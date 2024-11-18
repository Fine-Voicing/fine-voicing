export enum TestMode {
    TEXT = "text",
    TTS = "tts"
}

export interface TestCaseVoiceModel {
    provider: string;
    model: string;
    voice: string;
    api_key: string;
}

export interface TestCase {
    instructions: string;
    test_mode: TestMode;
    turns: number;
    voice_model: TestCaseVoiceModel;
}

// TypeScript type definition for config.example.json
export interface ConversationGeneratorConfig {
    provider: string;
    model: string;
    api_key: string;
    system_prompt_path: string;
}

export interface ConversationEvaluatorConfig {
    conversation: ConversationGeneratorConfig;
    information_extraction: ConversationGeneratorConfig;
    conversation_continuation: ConversationGeneratorConfig;
}

export interface TestSuiteConfig {
    dir: string;
    results_dir: string;
}

export interface Config {
    conversation_generator: ConversationGeneratorConfig;
    conversation_evaluator: ConversationEvaluatorConfig;
    test_suite: TestSuiteConfig;
}