import { AtomicAgent, AtomicAction, AtomicReaction } from './atomic-agent';
import { Config, TestCase } from './test-bench.d';
import { Logger } from 'winston';
import { ConversationItem } from './conversation-generator.d';
import OpenAI from 'openai';
import fs from 'fs';
import { ChatCompletionMessageParam } from 'openai/resources/index.mjs';

// Define atomic actions
interface QualityAction extends AtomicAction {
    type: 'EVALUATE_QUALITY';
    payload: {
        conversation: ConversationItem[];
        instructions: string;
    };
}

// Define atomic reactions
interface QualityReaction extends AtomicReaction {
    type: 'QUALITY_EVALUATED';
    payload: {
        evaluation: string;
    };
}

// Define agent state
interface QualityState {
    config: Config;
    logger: Logger;
    openaiClient: OpenAI;
}

export class ConversationQualityAgent extends AtomicAgent<QualityAction, QualityReaction, QualityState> {
    constructor(config: Config, logger: Logger) {
        const initialState: QualityState = {
            config,
            logger,
            openaiClient: new OpenAI({
                apiKey: config.conversation_evaluator.conversation.api_key,
            })
        };
        super(initialState);
    }

    protected setupActionHandlers(): void {
        this.on('action', async (action: QualityAction) => {
            if (action.type === 'EVALUATE_QUALITY') {
                await this.handleEvaluateQuality(action.payload);
            }
        });
    }

    private async handleEvaluateQuality({ conversation, instructions }: { conversation: ConversationItem[]; instructions: string }) {
        this.state.logger.info('Evaluating conversation quality');
        
        const systemPrompt = this.createSystemPrompt(
            this.state.config.conversation_evaluator.conversation.system_prompt_path,
            instructions
        );
        
        const evaluation = await this.evaluate(
            systemPrompt,
            conversation,
            this.state.config.conversation_evaluator.conversation.model
        );

        this.react({
            type: 'QUALITY_EVALUATED',
            payload: { evaluation }
        });
    }

    private createSystemPrompt(path: string, instructions: string): string {
        const systemPrompt = fs.readFileSync(path, 'utf-8');
        return systemPrompt.replace('${instructions}', instructions);
    }

    private async evaluate(systemPrompt: string, conversation: ConversationItem[], model: string): Promise<string> {
        const conversationTranscript = conversation.map(item => `- ${item.role}: ${item.content}`).join('\n');
        
        this.state.logger.debug(`System prompt: ${systemPrompt}`);
        this.state.logger.debug(`Conversation: ${conversationTranscript}`);

        const messages: ChatCompletionMessageParam[] = [
            {
                role: 'system',
                content: systemPrompt
            },
            {
                role: 'system',
                content: `Conversation:\n${conversationTranscript}`
            }
        ];

        const response = await this.state.openaiClient.chat.completions.create({
            model,
            messages
        });

        const content = response?.choices[0].message.content || '';
        this.state.logger.debug(`Quality evaluation result: ${content}`);
        
        return content;
    }
}
