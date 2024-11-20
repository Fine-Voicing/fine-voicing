import OpenAI from "openai";
import { Logger } from "winston";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { Config, TestMode, TestCase } from "./test-bench.d";
import type ConversationItem from "./conversation-generator.d";
import fs from "fs";
import EventEmitter from 'events';
import { VoiceAgent, VoiceAction, VoiceReaction } from './voice-agent';
import { ConversationQualityAgent } from './conversation-quality-agent';
import { InformationExtractionAgent } from './information-extraction-agent';
import { AtomicAgent, AtomicAction, AtomicReaction } from './atomic-agent';

// Define atomic actions
interface ConversationAction extends AtomicAction {
    type: 'THINK' | 'SPEAK' | 'PERCEIVE' | 'EVALUATE';
    payload: {
        systemPrompt?: string;
        memory?: ConversationItem[];
        message?: string;
        event?: any;
    };
}

// Define atomic reactions
interface ConversationReaction extends AtomicReaction {
    type: 'THOUGHT_COMPLETE' | 'SPEECH_COMPLETE' | 'PERCEPTION_COMPLETE' | 'EVALUATION_COMPLETE';
    payload: {
        thought?: string;
        message?: string;
        transcript?: string;
        error?: any;
        shouldContinue?: boolean;
    };
}

interface ConversationState {
    currentGoal: string;
    memory: ConversationItem[];
    status: 'idle' | 'thinking' | 'speaking' | 'listening';
    turnCount: number;
    systemPrompt: string;
}

class ConversationAgent extends AtomicAgent<ConversationAction, ConversationReaction, ConversationState> {
    private promptGenerationClient: OpenAI;
    private nextMessageClient: OpenAI;
    private voiceAgent: VoiceAgent;
    private qualityAgent: ConversationQualityAgent;
    private extractionAgent: InformationExtractionAgent;
    private logger: Logger;
    private config: Config;
    private testCase: TestCase;
    private conversationCompleteResolver: (() => void) | null = null;

    constructor(config: Config, testCase: TestCase, logger: Logger) {   
        const initialState: ConversationState = {
            currentGoal: '',
            memory: [],
            status: 'idle',
            turnCount: 0,
            systemPrompt: ''
        };
        super(initialState);

        this.config = config;
        this.logger = logger;
        this.testCase = testCase;

        this.promptGenerationClient = this.initializeOpenAIClient(this.config.conversation_generator.generation_prompt.api_key);
        this.nextMessageClient = this.initializeOpenAIClient(this.config.conversation_generator.next_message.api_key);
        
        // Initialize atomic agents
        this.voiceAgent = new VoiceAgent(testCase, logger);
        this.qualityAgent = new ConversationQualityAgent(config, logger);
        this.extractionAgent = new InformationExtractionAgent(config, logger);
        
        // Set up handlers for all agents
        this.setupVoiceAgentHandlers();
        this.setupQualityAgentHandlers();
        this.setupExtractionAgentHandlers();
    }

    protected setupActionHandlers(): void {
        this.on('action', async (action: ConversationAction) => {
            switch (action.type) {
                case 'THINK':
                    await this.handleThink(action.payload);
                    break;
                case 'SPEAK':
                    await this.handleSpeak(action.payload);
                    break;
                case 'PERCEIVE':
                    await this.handlePerceive(action.payload);
                    break;
                case 'EVALUATE':
                    await this.handleEvaluate(action.payload);
                    break;
            }
        });

        this.on('reaction', async (reaction: ConversationReaction) => {
            switch (reaction.type) {
                case 'THOUGHT_COMPLETE':
                    if (reaction.payload.thought) {
                        await this.dispatch({ 
                            type: 'SPEAK', 
                            payload: { message: reaction.payload.thought } 
                        });
                    }
                    break;
                case 'SPEECH_COMPLETE':
                    this.updateState({ status: 'listening' });
                    break;
                case 'PERCEPTION_COMPLETE':
                    if (reaction.payload.transcript) {
                        this.state.memory.push({ 
                            role: 'assistant', 
                            content: reaction.payload.transcript 
                        });
                        this.state.turnCount++;
                        await this.dispatch({
                            type: 'EVALUATE',
                            payload: { 
                                memory: this.state.memory
                            }
                        });
                    } else if (reaction.payload.error) {
                        this.logger.error(`Error: ${JSON.stringify(reaction.payload.error)}`);
                        this.completeConversation();
                    }
                    break;
                case 'EVALUATION_COMPLETE':
                    if (reaction.payload.shouldContinue && this.state.turnCount < this.testCase.turns) {
                        await this.dispatch({
                            type: 'THINK',
                            payload: { 
                                systemPrompt: this.state.systemPrompt, 
                                memory: this.state.memory 
                            }
                        });
                    } else {
                        this.completeConversation();
                    }
                    break;
            }
        });
    }

    private setupVoiceAgentHandlers() {
        this.voiceAgent.on('reaction', (reaction: VoiceReaction) => {
            switch (reaction.type) {
                case 'SPEECH_COMPLETE':
                    this.react({ 
                        type: 'SPEECH_COMPLETE', 
                        payload: reaction.payload 
                    });
                    break;
                case 'TRANSCRIPT_RECEIVED':
                    this.react({ 
                        type: 'PERCEPTION_COMPLETE', 
                        payload: { transcript: reaction.payload.transcript } 
                    });
                    break;
                case 'ERROR':
                    this.react({ 
                        type: 'PERCEPTION_COMPLETE', 
                        payload: { error: reaction.payload.error } 
                    });
                    break;
            }
        });
    }

    private setupQualityAgentHandlers() {
        this.qualityAgent.on('reaction', (reaction) => {
            if (reaction.type === 'QUALITY_EVALUATED') {
                this.logger.info(`Conversation quality evaluation: ${reaction.payload.evaluation}`);
            }
        });
    }

    private setupExtractionAgentHandlers() {
        this.extractionAgent.on('reaction', (reaction) => {
            if (reaction.type === 'COMPLETION_CHECKED') {
                this.react({
                    type: 'EVALUATION_COMPLETE',
                    payload: { shouldContinue: reaction.payload.shouldContinue }
                });
            } else if (reaction.type === 'EXTRACTION_EVALUATED') {
                this.logger.info(`Information extraction evaluation: ${reaction.payload.result}`);
            }
        });
    }

    private async handleThink({ systemPrompt, memory }: { systemPrompt?: string; memory?: ConversationItem[] }) {
        this.updateState({ status: 'thinking' });
        
        const messages = [
            { role: 'system', content: systemPrompt || this.state.systemPrompt }
        ];

        if (memory && memory.length > 0) {
            messages.push({ 
                role: 'system', 
                content: `Conversation history: ${memory.map(item => `- ${item.role}: ${item.content}`).join('\n')}` 
            });
        }

        const response = await this.nextMessageClient.chat.completions.create({
            model: this.config.conversation_generator.next_message.model,
            messages: messages as ChatCompletionMessageParam[],
        });

        const thought = response?.choices[0].message.content || '';
        this.react({ 
            type: 'THOUGHT_COMPLETE', 
            payload: { thought } 
        });
    }

    private async handleSpeak({ message }: { message?: string }) {
        if (!message) return;

        this.updateState({ status: 'speaking' });
        this.state.memory.push({ role: 'user', content: message });
        
        this.voiceAgent.dispatch({
            type: 'SPEAK',
            payload: { 
                message,
                mode: this.testCase.test_mode
            }
        });
    }

    private async handlePerceive({ event }: { event?: any }) {
        this.voiceAgent.dispatch({
            type: 'LISTEN',
            payload: { instructions: this.testCase.instructions }
        });
    }

    private async handleEvaluate({ memory }: { memory?: ConversationItem[] }) {
        if (!memory) return;

        // Evaluate quality in parallel with extraction
        this.qualityAgent.dispatch({
            type: 'EVALUATE_QUALITY',
            payload: {
                conversation: memory,
                instructions: this.testCase.instructions
            }
        });

        // Evaluate information extraction
        this.extractionAgent.dispatch({
            type: 'EVALUATE_EXTRACTION',
            payload: {
                conversation: memory,
                instructions: this.testCase.instructions
            }
        });

        // Check if conversation should continue
        this.extractionAgent.dispatch({
            type: 'CHECK_COMPLETION',
            payload: {
                conversation: memory,
                instructions: this.testCase.instructions
            }
        });
    }

    private initializeOpenAIClient(apiKey: string): OpenAI {
        this.logger.info(`Initializing OpenAI client`);
        return new OpenAI({ apiKey });
    }

    private async generateSystemPrompt(): Promise<string> {
        const systemPrompt = fs.readFileSync(
            this.config.conversation_generator.generation_prompt.system_prompt_path, 
            'utf-8'
        );
        const systemPromptWithInstructions = systemPrompt.replace(
            '${instructions}', 
            this.testCase.instructions
        );

        const response = await this.promptGenerationClient.chat.completions.create({
            model: this.config.conversation_generator.generation_prompt.model,
            messages: [
                { role: 'system', content: systemPromptWithInstructions }
            ]
        });

        return response?.choices[0].message.content || "";
    }

    private completeConversation() {
        this.updateState({ status: 'idle' });
        if (this.conversationCompleteResolver) {
            this.conversationCompleteResolver();
        }
    }

    public async start(): Promise<void> {
        this.state.currentGoal = this.testCase.instructions;
        this.state.systemPrompt = await this.generateSystemPrompt();
        await this.voiceAgent.connect();
        
        // Start the conversation
        await this.dispatch({
            type: 'THINK',
            payload: { 
                systemPrompt: this.state.systemPrompt, 
                memory: this.state.memory 
            }
        });

        // Wait for conversation to complete
        return new Promise<void>((resolve) => {
            this.conversationCompleteResolver = resolve;
        });
    }

    public async disconnect(): Promise<void> {
        await this.voiceAgent.disconnect();
    }
}

export default ConversationAgent;