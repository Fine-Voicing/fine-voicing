import OpenAI from "openai";
import { Logger } from "winston";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Config, TestMode, TestCase } from "./test-bench.d";
import type ConversationItem from "./conversation-generator.d";
import { RealtimeClient } from '@openai/realtime-api-beta';
import fs from "fs";
import ConversationEvaluator from "./conversation-evaluator";

interface AgentState {
    currentGoal: string;
    memory: ConversationItem[];
    status: 'idle' | 'thinking' | 'speaking' | 'listening';
    turnCount: number;
    systemPrompt: string;
}

class ConversationAgent {
    private promptGenerationClient: OpenAI;
    private nextMessageClient: OpenAI;
    private realtimeClient: RealtimeClient;
    private logger: Logger;
    private config: Config;
    private state: AgentState;
    private voices: ("alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer")[];
    private testCase: TestCase;
    private evaluator: ConversationEvaluator;
    private boundPerceive: (event: any) => Promise<void>;
    private conversationCompleteResolver: (() => void) | null = null;

    constructor(config: Config, testCase: TestCase, logger: Logger) {   
        this.config = config;
        this.logger = logger;
        this.testCase = testCase;

        this.promptGenerationClient = this.initializeOpenAIClient(this.config.conversation_generator.generation_prompt.api_key);
        this.nextMessageClient = this.initializeOpenAIClient(this.config.conversation_generator.next_message.api_key);
        this.realtimeClient = this.initializeRealtimeClient();
        
        this.state = {
            currentGoal: '',
            memory: [],
            status: 'idle',
            turnCount: 0,
            systemPrompt: ''
        };
        
        this.voices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
        this.evaluator = new ConversationEvaluator(this.config, this.logger, this.state.memory, this.testCase);
        this.boundPerceive = this.perceive.bind(this);
    }

    private initializeOpenAIClient(apiKey: string): OpenAI {
        this.logger.info(`Initializing OpenAI client`);
        return new OpenAI({ apiKey });
    }

    private initializeRealtimeClient(): RealtimeClient {
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

    private async generateSystemPrompt(): Promise<string> {
        const systemPrompt = fs.readFileSync(this.config.conversation_generator.generation_prompt.system_prompt_path, 'utf-8');
        const systemPromptWithInstructions = systemPrompt.replace('${instructions}', this.testCase.instructions);

        const response = await this.promptGenerationClient.chat.completions.create({
            model: this.config.conversation_generator.generation_prompt.model,
            messages: [
                { role: 'system', content: systemPromptWithInstructions }
            ]
        });

        return response?.choices[0].message.content || "";
    }

    private async think(): Promise<string> {
        this.state.status = 'thinking';
        
        const messages = [
            { role: 'system', content: this.state.systemPrompt },
            //{ role: 'system', content: `Current goal: ${this.state.currentGoal}` }
        ];

        if (this.state.memory.length > 0) {
            messages.push({ 
                role: 'system', 
                content: `Conversation history: ${this.state.memory.map(item => `- ${item.role}: ${item.content}`).join('\n')}` 
            });
        }

        const response = await this.nextMessageClient.chat.completions.create({
            model: this.config.conversation_generator.next_message.model,
            messages: messages as ChatCompletionMessageParam[],
        });

        const thought = response?.choices[0].message.content || '';
        this.updateState({ thought });
        return thought;
    }

    private async speak(message: string): Promise<void> {
        this.state.status = 'speaking';
        if (this.testCase.test_mode === TestMode.TTS) {
            const audioBuffer = await this.tts(message);
            this.realtimeClient.sendUserMessageContent([{ type: 'input_audio', audio: audioBuffer.toString('base64') }]);
        } else {
            this.realtimeClient.sendUserMessageContent([{ type: 'input_text', text: message }]);
        }
        this.state.memory.push({ role: 'user', content: message });
    }

    private async perceive(event: any): Promise<void> {
        switch (event?.type) {
            case 'response.done':
                const transcript = event.response.output[0].content[0].transcript;
                this.state.memory.push({ role: 'assistant', content: transcript });
                this.state.turnCount++;
                
                const shouldContinue = await this.evaluator.evaluateConversationContinuation();
                if (shouldContinue && this.state.turnCount < this.testCase.turns) {
                    const thought = await this.think();
                    await this.speak(thought);
                } else {
                    this.logger.info('Conversation complete');
                    await this.disconnect();
                    if (this.conversationCompleteResolver) {
                        this.conversationCompleteResolver();
                    }
                }
                break;
                
            case 'error':
                this.logger.error(`Error: ${JSON.stringify(event)}`);
                this.state.status = 'idle';
                if (this.conversationCompleteResolver) {
                    this.conversationCompleteResolver();
                }
                break;
        }
    }

    private async tts(message: string): Promise<Buffer> {
        const randomVoice = this.voices[Math.floor(Math.random() * this.voices.length)];
        const ttsResponse = await this.nextMessageClient.audio.speech.create({
            model: "tts-1",
            voice: randomVoice,
            input: message,
            response_format: 'pcm'
        });

        return Buffer.from(await ttsResponse.arrayBuffer());
    }

    private updateState(updates: Partial<AgentState>) {
        this.state = { ...this.state, ...updates };
        this.logger.debug(`State updated: ${JSON.stringify(this.state)}`);
    }

    public getState(): AgentState {
        return { ...this.state };
    }

    public async start(): Promise<void> {
        this.state.currentGoal = this.testCase.instructions;
        this.state.systemPrompt = await this.generateSystemPrompt();
        await this.realtimeClient.connect();
        
        this.realtimeClient.realtime.on('server.*', this.boundPerceive);
        
        const thought = await this.think();
        await this.speak(thought);

        // Wait for conversation to complete
        return new Promise<void>((resolve) => {
            this.conversationCompleteResolver = resolve;
        });
    }

    public async disconnect(): Promise<void> {
        if (this.realtimeClient?.realtime) {
            this.realtimeClient.realtime.off('server.*', this.boundPerceive);
            await this.realtimeClient.disconnect();
        }
    }
}

export default ConversationAgent;