import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { log, TwilioLogger } from './utils/logger.js';
import { ConversationAgent } from './conversation-agent.js';
import { AGENT_MODE, EmailContext, ModelInstance, OutboundCallMessage } from './types/index.js';
import Twilio from 'twilio';
import Stripe from 'stripe';
import { EmailService } from './services/email.service.js';
import { writeWavFile } from './utils/audio-storage.js';

export class OutboundCallQueueHandler {
    private supabase: SupabaseClient<any, "pgmq_public", any>;
    private supabaseQueueClient: SupabaseClient<any, "pgmq_public", any>;
    private messageSleepTime: number;
    private queueSleepTime: number;
    private twilioClient: Twilio.Twilio;
    private activeAgents: Map<string, ConversationAgent>;
    private isProcessing: boolean;
    private emailService: EmailService;

    private readonly QUEUE_NAME = 'outbound_calls';
    private readonly DEFAULT_QUEUE_MESSAGE_SLEEP_TIME = 10 * 60;
    private readonly DEFAULT_QUEUE_SLEEP_TIME = 60;
    private readonly DEFAULT_QUEUE_MAX_RETRIES = 50;

    constructor(activeAgents: Map<string, ConversationAgent>) {
        this.activeAgents = activeAgents;

        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
            throw new Error('SUPABASE_URL and SUPABASE_KEY must be set');
        }

        if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
            throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
        }

        if (!process.env.TWILIO_PHONE_NUMBER) {
            throw new Error('TWILIO_PHONE_NUMBER must be set');
        }

        if (process.env.QUEUE_MESSAGE_SLEEP_TIME) {
            this.messageSleepTime = parseInt(process.env.QUEUE_MESSAGE_SLEEP_TIME);
        } else {
            this.messageSleepTime = this.DEFAULT_QUEUE_MESSAGE_SLEEP_TIME;
        }

        if (process.env.QUEUE_SLEEP_TIME) {
            this.queueSleepTime = parseInt(process.env.QUEUE_SLEEP_TIME);
        } else {
            this.queueSleepTime = this.DEFAULT_QUEUE_SLEEP_TIME;
        }

        this.supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
        this.supabaseQueueClient = createClient<any, "pgmq_public", any>(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!, { db: { schema: 'pgmq_public' } });
        this.twilioClient = new Twilio.Twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
        this.activeAgents = activeAgents;
        this.emailService = new EmailService();
        this.isProcessing = false;
    }

    public async start() {
        this.isProcessing = true;

        while (this.isProcessing) {
            try {
                log.debug(`Reading from ${this.QUEUE_NAME} queue`);
                const { data, error } = await this.supabaseQueueClient.rpc('read', {
                    'queue_name': this.QUEUE_NAME,
                    'sleep_seconds': this.messageSleepTime,
                    'n': 1
                })

                if (error) {
                    log.error('Error reading from outbound_calls queue', error);
                }
                if (data?.length > 0) {
                    await this.processMessage(data[0]);
                }
            } catch (error: any) {
                log.error('Error processing outbound call queue', error);
            }
            finally {
                await new Promise(resolve => setTimeout(resolve, this.queueSleepTime * 1000));
            }
        }
    }

    public async stop() {
        this.isProcessing = false;
        this.cleanupActiveSessions();
    }

    private async processMessage(data: OutboundCallMessage) {
        const logger = new TwilioLogger();
        logger.info(`Processing outbound call for user: ${data.message.user_id} to phone number: ${data.message.to_phone_number}`);

        const messageIsOverMaxRetries = await this.checkMessageRetryCount(data.msg_id, data.read_ct);
        if (messageIsOverMaxRetries) {
            logger.info(`Message ${data.msg_id} has exceeded max retries, archived`);
            return;
        }

        const userIsVerified = await this.isUserVerified(data.message.user_id);
        if (!userIsVerified) {
            logger.info(`User ${data.message.user_id} is not verified, skipping`);
            return;
        }

        const { data: conversationData, error: conversationFetchError } = await this.fetchConversation(data.message.conversation_id);
        if (conversationFetchError) {
            throw new Error(conversationFetchError);
        }

        const { data: modelInstanceData, error: modelInstanceFetchError } = await this.fetchModelInstance(data.message.model_instance_id);
        if (modelInstanceFetchError) {
            throw new Error(modelInstanceFetchError);
        }

        if (!modelInstanceData) {
            throw new Error(`Model instance not found: ${conversationData.model_instance_id}`);
        }

        if (!data.message.is_demo) {
            const isSubscriptionActive = await this.stripeCheckSubscriptionStatus(data.message.user_id);
            if (!isSubscriptionActive) {
                throw new Error(`User ${data.message.user_id} subscription is not active`);
            }
        }

        const agent = new ConversationAgent({
            mode: AGENT_MODE.STS,
            instructions: conversationData.prompt,
            modelInstance: modelInstanceData
        });

        await agent.start();

        const callSid = await this.initTwilioCall(data.message.to_phone_number);

        this.activeAgents.set(callSid, agent);
        agent.setCallSid(callSid);
        agent.onStopped((durationSeconds: number) => this.onAgentStopped(data, callSid, conversationData, modelInstanceData, durationSeconds));
    }

    private async fetchConversation(conversationId: string): Promise<{ data: any | null, error: string | null }> {
        const { data, error } = await this.supabase.from('conversations').select('*').eq('conversation_id', conversationId).single();

        if (error) {
            return { data: null, error: error.message };
        }

        if (!data) {
            return { data: null, error: `Conversation not found: ${conversationId}` };
        }

        return { data, error: null };
    }

    private async fetchModelInstance(modelInstanceId: string): Promise<{ data: ModelInstance | null, error: string | null }> {
        const { data, error } = await this.supabase.from('model_instances').select('*').eq('instance_id', modelInstanceId).single();

        if (error) {
            return { data: null, error: error.message };
        }

        if (!data) {
            return { data: null, error: `Model instance not found: ${modelInstanceId}` };
        }

        return { data, error: null };
    }

    private async isUserVerified(userId: string): Promise<boolean> {
        const { data, error } = await this.supabase.auth.admin.getUserById(userId);

        if (error) {
            return false;
        }
        return data.user.email_confirmed_at !== undefined;
    }

    private async checkMessageRetryCount(msgId: string, retryCount: number): Promise<boolean> {
        if (retryCount >= this.DEFAULT_QUEUE_MAX_RETRIES) {
            await this.supabaseQueueClient.rpc('archive', {
                'queue_name': this.QUEUE_NAME,
                'message_id': msgId
            });
            return true;
        }
        return false;
    }

    private async initTwilioCall(toPhoneNumber: string) {
        // Create TwiML for WebSocket streaming
        const fqdn = process.env.FQDN;
        const streamUrl = `wss://${fqdn}/media-stream/outbound`;

        // <Parameter name="prompt" value="${Buffer.from(prompt).toString('base64')}" />
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Connect>
                    <Stream url="${streamUrl}"></Stream>
                </Connect>
            </Response>`;

        const call = await this.twilioClient.calls.create({
            record: true,
            to: toPhoneNumber,
            from: process.env.TWILIO_PHONE_NUMBER as string,
            //statusCallback: `https://${fqdn}/twilio/voice/status`,
            twiml: twiml
        });

        return call.sid;
    }

    private async onAgentStopped(messageData: OutboundCallMessage, callSid: string, conversation: any, modelInstance: ModelInstance, duration: number) {
        log.info(`[OutboundCallQueueHandler] Archiving message: ${messageData.msg_id}`);

        const agent = this.activeAgents.get(callSid);
        if (!agent) {
            log.error(`[OutboundCallQueueHandler] Agent not found for call: ${callSid}`);
            return;
        }

        await this.saveTranscripts(agent, conversation, modelInstance);
        if (!messageData.message.is_demo) {
            await this.stripeMeterOutboundCall(messageData.message.user_id, duration);
        }

        const user = await this.supabase.auth.admin.getUserById(messageData.message.user_id);
        if (!user.data.user?.email) {
            log.error(`[OutboundCallQueueHandler] User ${messageData.message.user_id} has no email: ${callSid}`);
            return;
        }

        const recordedAudio = agent.getRecordedAudio();
        let wavFileUrl: string | null = null;
        if (recordedAudio) {
            wavFileUrl = await writeWavFile(messageData.message.to_phone_number, recordedAudio);
        }

        const emailContext: EmailContext = {
            prompt: conversation.prompt,
            transcript: agent.getTranscripts(),
            duration: duration,
            to_phone_number: messageData.message.to_phone_number,
            secureLink: wavFileUrl || '',
            fineVoicingRole: agent.getPersonaRole() || { role_name: 'Fine Voicing', role_prompt: '<EMPTY ROLE INSTRUCTIONS>' }
        };
        await this.emailService.sendEmail(user.data.user.email, emailContext);

        this.activeAgents.delete(callSid);

        await this.supabaseQueueClient.rpc('archive', {
            'queue_name': this.QUEUE_NAME,
            'message_id': messageData.msg_id
        });
    }

    private async saveTranscripts(agent: ConversationAgent, conversation: any, modelInstance: ModelInstance) {
        const logger = new TwilioLogger();
        logger.info(`[OutboundCallQueueHandler] Saving transcripts for call: ${conversation['conversation_id']}`);

        const transcripts = agent.getTranscripts();
        transcripts.forEach(async (transcript, index) => {
            logger.debug(`[OutboundCallQueueHandler] Transcript ${index}: ${transcript.role}: ${transcript.content}`);
            const message_data = {
                'conversation_id': conversation.conversation_id,
                'role': transcript.role,
                'sequence_number': index,
                'instance_id': modelInstance.instance_id,
            };
            const message_response = await this.supabase.from('messages').insert(message_data).select();
            if (message_response.error) {
                logger.error(`[OutboundCallQueueHandler] Error inserting message: ${JSON.stringify(message_response.error, null, 2)}`);
                return;
            }

            if (message_response.data) {
                const transcript_data = {
                    'message_id': message_response.data[0]['message_id'],
                    'text': transcript['content'],
                };
                const transcript_response = await this.supabase.from('transcripts').insert(transcript_data);
                if (transcript_response.error) {
                    logger.error(`[OutboundCallQueueHandler] Error inserting transcript: ${transcript_response.error}`);
                    return;
                }
            }
        });
    }

    private async stripeMeterOutboundCall(userId: string, durationSeconds: number) {
        const { data, error } = await this.supabase.from('profiles').select('*').eq('id', userId).single();
        if (error) {
            log.error(`[OutboundCallQueueHandler] Stripe metering, error fetching user: ${error}`);
            return;
        }

        const user_profile = data;
        if (!user_profile) {
            log.error(`[OutboundCallQueueHandler] Stripe meter error fetching user: ${error}`);
            return;
        }

        const stripeSubscriptionId = user_profile.stripe_subscription_id;
        if (!stripeSubscriptionId) {
            log.error(`[OutboundCallQueueHandler] Stripe meter error, user has no stripe subscription id: ${userId}`);
            return;
        }

        const stripeClient = new Stripe(process.env.STRIPE_API_KEY as string);
        const subscription: Stripe.Subscription = await stripeClient.subscriptions.retrieve(stripeSubscriptionId);
        if (!subscription) {
            log.error(`[OutboundCallQueueHandler] Stripe meter error, error fetching subscription: ${error}`);
            return;
        }

        const subscriptionItem = subscription.items.data[0];
        if (!subscriptionItem) {
            log.error(`[OutboundCallQueueHandler] Stripe meter error, error fetching subscription item: ${error}`);
            return;
        }

        await stripeClient.billing.meterEvents.create({
            event_name: 'outbound_call',
            payload: {
                value: durationSeconds.toString(),
                stripe_customer_id: user_profile.stripe_customer_id,
            },
        });
    }

    private async stripeCheckSubscriptionStatus(userId: string) {
        const { data, error } = await this.supabase.from('profiles').select('stripe_subscription_status').eq('id', userId).single();

        if (error) {
            throw new Error(error.message);
        }
        
        return data.stripe_subscription_status === 'active';
    }

    // Function to gracefully cleanup all active sessions
    public async cleanupActiveSessions() {
        log.info(`Cleaning up ${this.activeAgents.size} active agents`);

        // Cleanup conversation agents
        for (const [callSid, agent] of this.activeAgents.entries()) {
            try {
                await agent.stop();
                //this.activeAgents.delete(callSid);
                log.info('Agent cleaned up during graceful shutdown', { callSid });
            } catch (error: any) {
                log.error('Error cleaning up agent', error);
            }
        }
    }
}