import { Config, TestCase } from "./test-bench.d";
import { Logger } from "winston";
import { ConversationItem } from "./conversation-generator.d";
import { ConversationQualityAgent } from "./conversation-quality-agent";
import { InformationExtractionAgent } from "./information-extraction-agent";

class ConversationEvaluator {
    private qualityAgent: ConversationQualityAgent;
    private extractionAgent: InformationExtractionAgent;
    private conversation: ConversationItem[];
    private testCase: TestCase;
    private logger: Logger;

    constructor(config: Config, logger: Logger, conversation: ConversationItem[], testCase: TestCase) {
        this.logger = logger;
        this.conversation = conversation;
        this.testCase = testCase;
        
        this.qualityAgent = new ConversationQualityAgent(config, logger);
        this.extractionAgent = new InformationExtractionAgent(config, logger);
    }

    async evaluateConversation(): Promise<string> {
        return new Promise((resolve) => {
            this.qualityAgent.once('reaction', (reaction) => {
                if (reaction.type === 'QUALITY_EVALUATED') {
                    resolve(reaction.payload.evaluation);
                }
            });

            this.qualityAgent.dispatch({
                type: 'EVALUATE_QUALITY',
                payload: {
                    conversation: this.conversation,
                    instructions: this.testCase.instructions
                }
            });
        });
    }

    async evaluateExtractedInformation(): Promise<string> {
        return new Promise((resolve) => {
            this.extractionAgent.once('reaction', (reaction) => {
                if (reaction.type === 'EXTRACTION_EVALUATED') {
                    resolve(reaction.payload.result);
                }
            });

            this.extractionAgent.dispatch({
                type: 'EVALUATE_EXTRACTION',
                payload: {
                    conversation: this.conversation,
                    instructions: this.testCase.instructions
                }
            });
        });
    }

    async evaluateConversationContinuation(): Promise<boolean> {
        return new Promise((resolve) => {
            this.extractionAgent.once('reaction', (reaction) => {
                if (reaction.type === 'COMPLETION_CHECKED') {
                    resolve(reaction.payload.shouldContinue || false);
                }
            });

            this.extractionAgent.dispatch({
                type: 'CHECK_COMPLETION',
                payload: {
                    conversation: this.conversation,
                    instructions: this.testCase.instructions
                }
            });
        });
    }
}

export default ConversationEvaluator;