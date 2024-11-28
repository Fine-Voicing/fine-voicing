import OpenAI from "openai";
import { Logger } from "winston";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Config, TestMode, TestCase } from "./test-bench.d";
import type ConversationItem from "./conversation-generator.d";
import { RealtimeClient } from '@openai/realtime-api-beta';
import fs from "fs";
import ConversationEvaluator from "./conversation-evaluator";
import { WebSocket } from "ws";
import Speaker from 'speaker';

class ConversationGeneratorBase {
    private promptGenerationClient: OpenAI;
    private nextMessageClient: OpenAI;
    protected logger: Logger;
    private config: Config;
    protected conversation: ConversationItem[];
    private generationSystemPrompt: string;
    protected testCase: TestCase;

    constructor(config: Config, testCase: TestCase, logger: Logger) {
        this.config = config;
        this.logger = logger;
        this.testCase = testCase;

        this.logger.info(`Initializing OpenAI prompt generator client`);
        this.promptGenerationClient = this.initializeOpenAIClient(this.config.conversation_generator.generation_prompt.api_key);
        this.logger.info(`Initializing OpenAI next message client`);
        this.nextMessageClient = this.initializeOpenAIClient(this.config.conversation_generator.next_message.api_key);
        this.conversation = [];
        this.generationSystemPrompt = "";
    }

    initializeOpenAIClient(apiKey: string): OpenAI {
        return new OpenAI({ apiKey });
    }

    setConversation(conversation: ConversationItem[]) {
        this.conversation = conversation;
    }

    getConversation() {
        return this.conversation;
    }

    async generateMessage(): Promise<string> {
        const systemPrompt = fs.readFileSync(this.config.conversation_generator.next_message.system_prompt_path, 'utf-8');
        const systemPromptWithInstructions = systemPrompt.replace('${instructions}', this.generationSystemPrompt);

        const messages = [
            { role: 'system', content: systemPromptWithInstructions }
        ];

        if (this.conversation.length > 0) {
            messages.push({ role: 'system', content: `Here is the conversation history: ${this.conversation.map(item => `- ${item.role}: ${item.content}`).join('\n')}` });
        }

        this.logger.info(`Generating a message`);
        this.logger.debug(`System prompt: ${JSON.stringify(messages, null, 2)}`);

        const response = await this.nextMessageClient?.chat.completions.create({
            model: this.config.conversation_generator.next_message.model,
            messages: messages as ChatCompletionMessageParam[],
        });

        this.logger.info(`Generated message`);
        this.logger.debug(`${response?.choices[0].message.content}`);

        return response?.choices[0].message.content || "I'm not sure what to say next.";
    }

    async sendMessage(message: string) {
        throw new Error('Method not implemented.');
    }

    async tts(message: string) {
        const randomVoice = this.voices[Math.floor(Math.random() * this.voices.length)];
        const ttsResponse = await this.nextMessageClient.audio.speech.create({
            model: "tts-1",
            voice: randomVoice, // Randomly pick a voice from the supported values
            input: message,
            response_format: 'pcm'
        });

        const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
        return audioBuffer;
    }

    async connect() {
        throw new Error('Method not implemented.');
    }

    async disconnect() {
        throw new Error('Method not implemented.');
    }

    async generateConversationGenerationPrompt(): Promise<string> {
        const systemPrompt = fs.readFileSync(this.config.conversation_generator.generation_prompt.system_prompt_path, 'utf-8');
        const systemPromptWithInstructions = systemPrompt.replace('${instructions}', this.testCase.instructions);

        this.logger.debug(`Conversation generation prompt: ${systemPromptWithInstructions}`);
        const response = await this.promptGenerationClient.chat.completions.create({
            model: this.config.conversation_generator.generation_prompt.model,
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
        throw new Error('Method not implemented.');
    }
}

class ConversationGeneratorOpenAI extends ConversationGeneratorBase {
    private realtimeClient: RealtimeClient;

    constructor(config: Config, testCase: TestCase, logger: Logger) {
        super(config, testCase, logger);
        this.realtimeClient = this.initializeRealtimeClient();
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

    async connect(): Promise<void> {
        await this.realtimeClient.connect();
    }

    async disconnect(): Promise<void> {
        await this.realtimeClient.disconnect();
    }

    async converse(): Promise<ConversationItem[]> {
        return new Promise(async (resolve, reject) => {
            let responseResolver: (() => void) | null = null;
            let isWaitingForResponse = false;
            this.conversation = [];

            await this.connect();

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

class ConversationGeneratorUltravox extends ConversationGeneratorBase {
    private webSocketClient!: WebSocket;
    private speaker: Speaker;

    constructor(config: Config, testCase: TestCase, logger: Logger) {
        super(config, testCase, logger);

        this.speaker = new Speaker({
            channels: 1,
            bitDepth: 16,
            sampleRate: 48000
        });
    }

    async connect(): Promise<void> {
        const response = await fetch('https://api.ultravox.ai/api/calls', {
            method: 'POST',
            headers: {
                'X-API-Key': this.testCase.voice_model.api_key,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                systemPrompt: this.testCase.instructions,
                model: this.testCase.voice_model.model || "fixie-ai/ultravox",
                voice: this.testCase.voice_model.voice || 'Mark',
                initiator: 'INITIATOR_USER',
                initialOutputMedium: 'MESSAGE_MEDIUM_TEXT',
                recordingEnabled: true,
                medium: {
                    serverWebSocket: {
                        inputSampleRate: 48000,
                        outputSampleRate: 48000,
                        clientBufferSizeMs: 30000
                    }
                }
            })
        });

        const responseJson = await response.json();
        if (!response.ok) {
            const error = new Error(`Failed to get join URL: ${response.status} ${response.statusText}`);
            Object.assign(error, responseJson);
            throw error;
        }

        const { joinUrl } = responseJson;
        this.logger.debug(`Join URL: ${joinUrl}`);
        
        this.webSocketClient = new WebSocket(joinUrl);
        this.webSocketClient.on('open', () => {
            this.logger.info('WebSocket connection to Ultravox opened');
        });
    }

    async disconnect(): Promise<void> {
        this.speaker.end();
        this.webSocketClient.on('close', () => {
            this.logger.info('WebSocket connection to Ultravox closed');
        });
        this.webSocketClient.close();
    }

    async sendMessage(message: string) {
        if (this.testCase.test_mode === TestMode.TTS) {
            this.logger.info(`Sending message as audio`);
            const audioBuffer = await this.tts(message);
            this.webSocketClient.send(audioBuffer);
        }
        else {
            this.logger.info(`Sending message as text`);
            this.webSocketClient.send(JSON.stringify({ type: 'input_text_message', text: message }));
        }
    }

    async converse(): Promise<ConversationItem[]> {
        return new Promise(async (resolve, reject) => {
            let responseResolver: (() => void) | null = null;
            let isWaitingForResponse = false;
            this.conversation = [];

            await this.connect();

            const handleEvent = (data: any) => {
                this.logger.debug(`Raw Event: ${data}`);

                try {
                    this.logger.debug(`typeof data: ${typeof data}`)
                    const event = JSON.parse(data);
                    if (typeof event !== 'object' || event === null) {
                        this.logger.error(`Non JSON formatted event: ${data}`);
                        return;
                    }

                    this.logger.debug(`Event: ${JSON.stringify(event)}`);

                    switch (event?.type) {
                        case 'transcript':
                            if (event.role === 'agent' && event.final) {
                                const transcript = event.text;
                                this.logger.info('Response complete');
                                this.logger.debug(`Transcript: ${transcript}`);
                                this.conversation.push({ role: 'assistant', content: transcript });
                                isWaitingForResponse = false;
                                if (responseResolver) {
                                    responseResolver();
                                    responseResolver = null;
                                }
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
                } catch (error) {
                    this.logger.error(`Error while parsing event as JSON: ${data}, error: ${error}`);
                    this.logger.info('Attempting to decode binary data');
                    try {
                        const audioBuffer = Buffer.from(data);
                        this.logger.debug(`Audio data (base64): ${audioBuffer.toString('base64')}`);
                        this.speaker.write(audioBuffer);
                    } catch (decodeError) {
                        this.logger.error(`Error decoding binary data: ${decodeError}`);
                        return;
                    }
                }
            };

            this.webSocketClient.on('message', handleEvent);

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
                this.webSocketClient.off('*', handleEvent);
            }
            resolve(this.conversation);
        });
    }
}


export { ConversationGeneratorBase, ConversationGeneratorOpenAI, ConversationGeneratorUltravox };