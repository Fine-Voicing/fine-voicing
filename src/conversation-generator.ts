import OpenAI from "openai";
import { Logger } from "winston";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Config, TestMode, TestCase } from "./test-bench.d";
import type ConversationItem from "./conversation-generator.d";
import { RealtimeClient } from '@openai/realtime-api-beta';
import fs from "fs";
import ConversationEvaluator from "./conversation-evaluator";

class ConversationGenerator {
    private openaiClient: OpenAI;
    private realtimeClient: RealtimeClient;
    private logger: Logger;
    private config: Config;
    private conversation: ConversationItem[];
    private voices: ("alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer")[];
    private generationSystemPrompt: string;
    private testCase: TestCase;

    constructor(config: Config, testCase: TestCase, logger: Logger) {   
        this.config = config;
        this.logger = logger;
        this.testCase = testCase;

        this.openaiClient = this.initializeOpenAIClient();
        this.realtimeClient = this.initializeRealtimeClient();

        this.conversation = [];
        this.voices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
        this.generationSystemPrompt = "";
    }

    initializeOpenAIClient(): OpenAI {
        this.logger.info(`Initializing OpenAI client`);
        return new OpenAI({ apiKey: this.config.conversation_generator.api_key });
    }

    initializeRealtimeClient(): RealtimeClient {
        this.logger.info(`Initializing realtime client`);
        const realtimeClient = new RealtimeClient({ apiKey: this.testCase.voice_model.api_key });

        realtimeClient.updateSession({
            instructions: this.testCase.instructions,
            voice: this.testCase.voice_model.voice as ("alloy" | "echo" | "shimmer" | "ash" | "ballad" | "coral" | "sage" | "verse"),
            turn_detection: null,
            input_audio_transcription: { model: 'whisper-1' },
        });

        return realtimeClient;
    }

    setConversation(conversation: ConversationItem[]) {
        this.conversation = conversation;
    }

    getConversation() {
        return this.conversation;
    }

    async generateMessage(): Promise<string> {
        const messages = [
            { role: 'system', content: `Generate the next (single one) message to append in a conversation, based on the instructions: ${this.generationSystemPrompt}` },
            { role: 'system', content: "Use real information. Maximum 20 words. Do not hesitate to answer ambiguously or steer the discussion away, to force the assistant to come back to the original topic." }
        ];

        if (this.conversation.length > 0) {
            messages.push({ role: 'system', content: `Here is the conversation history: ${this.conversation.map(item => `- ${item.role}: ${item.content}`).join('\n')}` });
        }

        this.logger.info(`Generating a message`);
        this.logger.debug(`System prompt: ${JSON.stringify(messages, null, 2)}`);

        const response = await this.openaiClient?.chat.completions.create({
            model: this.config.conversation_generator.model,
            messages: messages as ChatCompletionMessageParam[],
        });

        this.logger.info(`Generated message`);
        this.logger.debug(`${response?.choices[0].message.content}`);

        return response?.choices[0].message.content || "I'm not sure what to say next.";
    }

    async sendMessage(message: string) {
        if (this.testCase.test_mode === TestMode.TTS) {
            this.logger.info(`Sending message as audio`);
            const audioBuffer = await this.tts(message);
            this.realtimeClient.sendUserMessageContent([{ type: 'input_audio', audio: audioBuffer.toString('base64') }]);
        }
        else {
            this.logger.info(`Sending message as text`);
            this.realtimeClient.sendUserMessageContent([{ type: 'input_text', text: message }]);
        }
    }

    async tts(message: string) {
        const randomVoice = this.voices[Math.floor(Math.random() * this.voices.length)];
        const ttsResponse = await this.openaiClient.audio.speech.create({
            model: "tts-1",
            voice: randomVoice, // Randomly pick a voice from the supported values
            input: message,
            response_format: 'pcm'
        });

        const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
        return audioBuffer;
    }

    async disconnect() {
        await this.realtimeClient?.disconnect();
    }

    async generateConversationGenerationPrompt(): Promise<string> {
        const systemPrompt = fs.readFileSync(this.config.conversation_generator.system_prompt_path, 'utf-8');
        const systemPromptWithInstructions = systemPrompt.replace('${instructions}', this.testCase.instructions);

        this.logger.debug(`Conversation generation prompt: ${systemPromptWithInstructions}`);
        const response = await this.openaiClient.chat.completions.create({
            model: this.config.conversation_generator.model,
            messages: [
                { role: 'system', content: systemPromptWithInstructions }
            ]
        });
        this.logger.info(`Generated conversation generation prompt`);
        this.logger.debug(`${response?.choices[0].message.content}`);

        this.generationSystemPrompt = response?.choices[0].message.content || "";

        return this.generationSystemPrompt;
    }

    async converse(): Promise<ConversationItem[]> {
        return new Promise(async (resolve, reject) => {
            let responseResolver: (() => void) | null = null;
            let isWaitingForResponse = false;
            this.conversation = [];

            await this.realtimeClient.connect();

            const handleEvent = (event: any) => {
                //this.logger.debug(`Event: ${event?.type}`);
                switch (event?.type) {
                    case 'response.done':
                        const transcript = event.response.output[0].content[0].transcript;
                        this.logger.info('Response complete');
                        this.logger.debug(`Transcript: ${transcript}`);
                        this.conversation.push({ role: 'assistant', content: transcript });
                        isWaitingForResponse = false;
                        if (responseResolver) {
                            responseResolver();
                            responseResolver = null;
                        }
                        break;
                    case 'error':
                        this.logger.error(`Error: ${JSON.stringify(event)}`);
                        isWaitingForResponse = false;
                        if (responseResolver) {
                            responseResolver();
                            responseResolver = null;
                        }
                        break;
                }
            };

            this.realtimeClient.realtime.on('server.*', handleEvent);

            try {
                await this.generateConversationGenerationPrompt();

                const firstMessage = await this.generateMessage();
                this.logger.info(`Sending first message`);
                this.logger.debug(`First message: ${firstMessage}`);
                this.conversation.push({ role: 'user', content: firstMessage });
                this.sendMessage(firstMessage);

                await new Promise<void>(resolve => responseResolver = resolve);

                let conversationShouldContinue = true;
                let i = 0;
                while (conversationShouldContinue && i < this.testCase.turns) {
                    const nextMessage = await this.generateMessage();
                    this.logger.info(`Sending generated message`);
                    this.logger.debug(`Generated message: ${nextMessage}`);
                    this.conversation.push({ role: 'user', content: nextMessage });

                    // Wait for any previous response to complete
                    if (isWaitingForResponse) {
                        await new Promise<void>(resolve => responseResolver = resolve);
                    }

                    // Send the message and mark that we're waiting
                    isWaitingForResponse = true;
                    this.sendMessage(nextMessage);

                    // Wait for this message's response
                    await new Promise<void>(resolve => responseResolver = resolve);
                    conversationShouldContinue = await new ConversationEvaluator(this.config, this.logger, this.conversation, this.testCase).evaluateConversationContinuation();
                    this.logger.info(`Conversation should continue: ${conversationShouldContinue}`);
                    i++;
                }

                this.logger.info(`Conversation complete`);
                this.logger.debug(`Conversation transcript:\n${this.conversation.map((item) => `- ${item.role}: ${item.content}`).join('\n')}`);

            } finally {
                // Clean up the event listener when we're done
                this.realtimeClient?.realtime.off('server.*', handleEvent);
            }
            resolve(this.conversation);
        });
    }
}

export default ConversationGenerator;