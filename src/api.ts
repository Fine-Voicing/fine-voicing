import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from 'dotenv';
import twilio from 'twilio';
import { ConversationAgent } from './conversation-agent.js';
import { log } from './utils/logger.js';
import { AGENT_MODE, ErrorEvent } from './types/index.js';
import { TwilioLogger } from './utils/logger.js';

// Load environment variables
config();

// Session management
const activeSessions = new Map<string, ConversationAgent>();
const activeConnections = new Map<string, WebSocket>();
const logger = new TwilioLogger();

// Function to gracefully cleanup all active sessions
const cleanupActiveSessions = () => {
    log.info(`Cleaning up ${activeSessions.size} active sessions and ${activeConnections.size} connections`);
    
    // Cleanup WebSocket connections
    for (const [streamSid, ws] of activeConnections.entries()) {
        try {
            if (ws.readyState === ws.OPEN) {
                ws.close();
            }
        } catch (error: any) {
            logger.error('Error closing WebSocket connection', error);
        }
        activeConnections.delete(streamSid);
    }

    // Cleanup conversation agents
    for (const [streamSid, agent] of activeSessions.entries()) {
        try {
            agent.cleanup();
            activeSessions.delete(streamSid);
            logger.info('Session cleaned up during graceful shutdown');
        } catch (error: any) {
            logger.error('Error cleaning up session', error);
        }
    }
};

// Handle graceful shutdown
process.on('SIGINT', () => {
    log.info('Received SIGINT signal');
    cleanupActiveSessions();
    log.info('Active sessions cleaned up, API continues running');
});

process.on('SIGTERM', () => {
    log.info('Received SIGTERM signal');
    cleanupActiveSessions();
    log.info('Active sessions cleaned up, API continues running');
});

const app = express();
const router = express.Router();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream/outbound' });

// Middleware
app.use(express.json());
app.use('/', router);

// Initialize Twilio client
const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID as string,
    process.env.TWILIO_AUTH_TOKEN as string
);

// POST endpoint for initiating outbound calls
interface OutboundCallRequest {
    prompt: string;
    to_phone_number: string;
}

router.post('/outbound-call', async (req: Request, res: Response): Promise<void> => {
    try {
        const { prompt, to_phone_number } = req.body;
        
        if (!prompt || !to_phone_number) {
            log.warn('Missing required parameters in outbound call request');
            res.status(400).json({ error: 'Missing required parameters' });
            return
        }

        const agent = new ConversationAgent({
            mode: AGENT_MODE.STS,
            instructions: prompt
        });
        await agent.start();

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

        // Initiate outbound call with TwiML
        const call = await twilioClient.calls.create({
            record: true,
            to: to_phone_number,
            from: process.env.TWILIO_PHONE_NUMBER as string,
            //statusCallback: `https://${fqdn}/twilio/voice/status`,
            twiml: twiml
        });

        const callSid = call.sid;
        logger.setCallSid(callSid);
        agent.setCallSid(callSid);
        
        activeSessions.set(callSid, agent);

        logger.info('Outbound call initiated successfully');
        res.json({ 
            success: true, 
            callSid: call.sid 
        });
        return
    } catch (error: any) {
        logger.error('Failed to initiate outbound call', error);
        res.status(500).json({ 
            error: 'Failed to initiate call',
            details: error.message 
        });
        return
    }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    
    logger.info('Twilio WebSocket connection established');
    let streamSid: string | undefined;
    let agent: ConversationAgent | undefined;

    ws.on('message', async (message: Buffer) => {
        try {
            const msg = JSON.parse(message.toString());
            logger.setStreamId(msg.streamSid);
            logger.debug(`Received Twilio message ${msg.event}`);
            
            // Handle the start message to get streamSid
            if (msg.event === 'start') {
                logger.info('Twilio: Received start message');
                streamSid = msg.streamSid;

                //const prompt = Buffer.from(msg.start.customParameters.prompt, 'base64').toString();
                if (!streamSid) {
                    throw new Error('No streamSid provided in start message');
                }
                
                // Store WebSocket connection
                activeConnections.set(streamSid, ws);
                
                // Create new conversation agent for this stream
                agent = activeSessions.get(msg.start.callSid);
                if (!agent) {
                    throw new Error('No agent found for streamSid');
                }

                agent.setStreamId(streamSid);
                
                // Set up audio output handler
                agent.onOutgoingAudio((audioChunk) => {
                    if (ws.readyState === ws.OPEN) {
                        //log.info('Converting audio to 8kHz mulaw format', { streamId: audioChunk.streamSid });
                        //const convertedAudio = AudioConverter.convertPCM24kTo8kMulaw(audioChunk.data);
                        
                        logger.debug('Sending audio chunk to Twilio');
                        const response = {
                            event: 'media',
                            streamSid: audioChunk.streamSid,
                            media: {
                                payload: audioChunk.data.toString('base64')
                            }
                        };
                        ws.send(JSON.stringify(response));
                    }
                });
                agent.onResponseDone((streamId) => {
                    logger.info('Response done');
                    const markResponse = {
                        event: 'mark',
                        streamSid: streamSid,
                        mark: { name: 'responsePart' }
                    }
                    ws.send(JSON.stringify(markResponse));
                });

                agent.onError((error: ErrorEvent) => {
                    logger.error('Error in conversation agent', error.error);
                    cleanupSession(error.streamSid);
                });

                agent.onTerminateConversation((streamId) => {
                    logger.info('Conversation terminated by moderator');
                    cleanupSession(streamId);
                });
            }
            
            // Handle media messages
            else if (msg.event === 'media' && streamSid && msg.media) {
                logger.debug('Received media message');
                if (agent) {
                    const audioChunk = {
                        data: Buffer.from(msg.media.payload, 'base64'),
                        streamSid: streamSid
                    };
                    agent.handleIncomingAudio(audioChunk);
                }
            }
            
            // Handle stop message
            else if (msg.event === 'stop' && streamSid) {
                logger.info('Received stop message');
                if (agent) {
                    agent.cleanup();
                    activeSessions.delete(msg.stop.callSid);
                    logger.info('Session cleaned up');
                }
            }
        } catch (error: any) {
            logger.error('Error processing WebSocket message', error);
            await cleanupSession(streamSid ?? '');
        }
    });

    ws.on('close', async () => {
        logger.info('Twilio WebSocket connection closed');
        await cleanupSession(streamSid ?? '');
    });

    ws.on('error', async (error) => {
        logger.error('Twilio WebSocket error', error);
        await cleanupSession(streamSid ?? '');
    });
});

const cleanupSession = async (streamSid: string) => {
    logger.debug('Cleaning up session');
    const agent = activeSessions.get(streamSid);
    if (agent) {
        await agent.cleanup();
        activeSessions.delete(streamSid);
    }

    const connection = activeConnections.get(streamSid);
    if (connection) {
        connection.close();
        activeConnections.delete(streamSid);
    }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    log.info(`Server is running on port ${PORT}`);
});
