import { AtomicAgent, AtomicAction, AtomicReaction } from './atomic-agent';
import { Config, TestCase } from './test-bench.d';
import { Logger } from 'winston';
import { ConversationItem } from './conversation-generator.d';
import OpenAI from 'openai';
import fs from 'fs';
import { ChatCompletionMessageParam } from 'openai/resources/index.mjs';

// Define atomic actions
interface ExtractionAction extends AtomicAction {
    type: 'EVALUATE_EXTRACTION' | 'CHECK_COMPLETION';
    payload: {
        conversation: ConversationItem[];
        instructions: string;
    };
}

// Define atomic reactions
interface ExtractionReaction extends AtomicReaction {
    type: 'EXTRACTION_EVALUATED' | 'COMPLETION_CHECKED';
    payload: {
        result: string;
        shouldContinue?: boolean;
    };
}

// Define agent state
interface ExtractionState {
    config: Config;
    logger: Logger;
    openaiClient: OpenAI;
}

export class InformationExtractionAgent extends AtomicAgent<ExtractionAction, ExtractionReaction, ExtractionState> {
    constructor(config: Config, logger: Logger) {
        const initialState: ExtractionState = {
            config,
            logger,
            openaiClient: new OpenAI({
                apiKey: config.conversation_evaluator.information_extraction.api_key,
            })
        };
        super(initialState);
    }

    protected setupActionHandlers(): void {
        this.on('action', async (action: ExtractionAction) => {
            switch (action.type) {
                case 'EVALUATE_EXTRACTION':
                    await this.handleEvaluateExtraction(action.payload);
                    break;
                case 'CHECK_COMPLETION':
                    await this.handleCheckCompletion(action.payload);
                    break;
            }
        });
    }

    private async handleEvaluateExtraction({ conversation, instructions }: { conversation: ConversationItem[]; instructions: string }) {
        this.state.logger.info('Evaluating information extraction');
        
        const systemPrompt = this.createSystemPrompt(
            this.state.config.conversation_evaluator.information_extraction.system_prompt_path,
            instructions
        );
        
        const result = await this.evaluate(
            systemPrompt,
            conversation,
            this.state.config.conversation_evaluator.information_extraction.model
        );

        this.react({
            type: 'EXTRACTION_EVALUATED',
            payload: { result }
        });
    }

    private async handleCheckCompletion({ conversation, instructions }: { conversation: ConversationItem[]; instructions: string }) {
        this.state.logger.info('Checking conversation completion');
        
        const systemPrompt = this.createSystemPrompt(
            this.state.config.conversation_evaluator.conversation_continuation.system_prompt_path,
            instructions
        );
        
        const result = await this.evaluate(
            systemPrompt,
            conversation,
            this.state.config.conversation_evaluator.conversation_continuation.model
        );

        // The result is 'YES' if all information is extracted, 'NO' if we should continue
        const shouldContinue = result === 'NO';

        this.react({
            type: 'COMPLETION_CHECKED',
            payload: { 
                result,
                shouldContinue
            }
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
        this.state.logger.debug(`Extraction evaluation result: ${content}`);
        
        return content;
    }
}
