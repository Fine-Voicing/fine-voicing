import { Config, TestCase } from "./test-bench.d";
import { Logger } from "winston";
import fs from "fs";
import { ConversationItem } from "./conversation-generator.d";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import OpenAI from "openai";

class ConversationEvaluator {
    private openaiClient: OpenAI;
    private config: Config;
    private logger: Logger;
    private conversation: ConversationItem[];
    private testCase: TestCase;

    constructor(config: Config, logger: Logger, conversation: ConversationItem[], testCase: TestCase) {
        this.config = config;
        this.logger = logger;
        this.conversation = conversation;
        this.testCase = testCase;

        this.openaiClient = new OpenAI({
            apiKey: config.conversation_evaluator.conversation.api_key,
        });
    }

    async evaluateConversation(): Promise<string> {
        this.logger.info(`Evaluating conversation`);
        const systemPrompt = this.createSystemPrompt(this.config.conversation_evaluator.conversation.system_prompt_path, this.testCase.instructions);
        return this.evaluate(systemPrompt, this.config.conversation_evaluator.conversation.model);
    }

    async evaluateExtractedInformation(): Promise<string> {
        this.logger.info(`Evaluating extracted information`);
        const systemPrompt = this.createSystemPrompt(this.config.conversation_evaluator.information_extraction.system_prompt_path, this.testCase.instructions);
        return this.evaluate(systemPrompt, this.config.conversation_evaluator.information_extraction.model);
    }

    async evaluateConversationContinuation(): Promise<boolean> {
        this.logger.info(`Evaluating conversation continuation`);
        const systemPrompt = this.createSystemPrompt(this.config.conversation_evaluator.conversation_continuation.system_prompt_path, this.testCase.instructions);
        const allInformationExtracted = await this.evaluate(systemPrompt, this.config.conversation_evaluator.conversation_continuation.model);
        return allInformationExtracted === 'NO';
    }

    private async evaluate(systemPrompt: string, model: string): Promise<string> {
        const conversationTranscript = this.conversation.map(item => `- ${item.role}: ${item.content}`).join('\n');
        this.logger.debug(`System prompt: ${systemPrompt}`);
        this.logger.debug(`Conversation: ${conversationTranscript}`);

        const messages: ChatCompletionMessageParam[] = [];
        messages.push(
            {
                role: 'system',
                content: systemPrompt
            },
            {
                role: 'system',
                content: `Conversation:\n${conversationTranscript}`
            }
        );

        const response = await this.openaiClient?.chat.completions.create({
            model: model,
            messages: messages as ChatCompletionMessageParam[],
        });

        const content = response?.choices[0].message.content;

        this.logger.debug(`Evaluation result: ${content}`);
        return content;
    }

    private createSystemPrompt(path: string, instructions: string): string {
        const systemPrompt = fs.readFileSync(path, 'utf-8');
        return systemPrompt.replace('${instructions}', instructions);
    }
}

export default ConversationEvaluator;