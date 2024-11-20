import path from "path";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { TestCase, Config } from './test-bench.d';
import winston, { Logger } from "winston";
import ConversationAgent from './conversation-agent';
import ConversationEvaluator from './conversation-evaluator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class VoiceAITestBench {
  private config: Config;
  private agent!: ConversationAgent;
  private conversationEvaluator!: ConversationEvaluator;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.config = this.readConfig();
  }

  readConfig(): Config {
    const configFilePath = path.join(__dirname, '/../', 'config.json');
    const configFileContent = fs.readFileSync(configFilePath, 'utf-8');
    const config: Config = JSON.parse(configFileContent);

    this.logger.info('Config read');
    this.logger.debug(`Config: ${JSON.stringify(config, null, 2)}`);

    return config;
  }

  saveTestResult(testResult: any, testFile: string) {
    const testFileName = path.basename(testFile, path.extname(testFile));
    const resultFilePath = path.join(__dirname, '/../', this.config.test_suite.results_dir, `${testFileName}-${Date.now()}-result.json`);
    fs.writeFileSync(resultFilePath, JSON.stringify(testResult, null, 2), 'utf-8');
    this.logger.info(`Test result saved to ${resultFilePath}`);
  }

  async runTestCaseByName(testCaseName: string) {
    const testCaseFilePath = path.join(this.config.test_suite.dir, `${testCaseName}.json`);
    const testCase = JSON.parse(fs.readFileSync(testCaseFilePath, 'utf-8')) as TestCase;
    
    const testLogger = this.createLoggerForTestCase(testCaseName);
    const testResult = await this.runTestCase(testCase, testLogger);
    this.saveTestResult(testResult, testCaseFilePath);
    
    return testResult;
  }

  private createLoggerForTestCase(testCaseName: string): Logger {
    const testLogger = this.logger.child({});
    // Add file transport specific to this test case
    testLogger.add(
      new winston.transports.File({
        filename: `logs/${testCaseName}-${Date.now()}.log`
      })
    );
    return testLogger;
  }

  async runTestCase(testCase: TestCase, testLogger: Logger): Promise<any> {    
    testLogger.info(`Running test case`);
    testLogger.debug(`Test case: ${JSON.stringify(testCase, null, 2)}`);
    testLogger.info(`Instructions: ${testCase.instructions}`);

    this.agent = new ConversationAgent(this.config, testCase, testLogger);
    await this.agent.start();

    // Wait for the conversation to complete and get the final state
    const conversation = this.agent.getState().memory;

    this.conversationEvaluator = new ConversationEvaluator(this.config, testLogger, conversation, testCase);
    const conversationEvaluation = await this.conversationEvaluator.evaluateConversation();
    const extractedInformationEvaluation = await this.conversationEvaluator.evaluateExtractedInformation();

    const testResult = { conversation, evaluation: { conversation: JSON.parse(conversationEvaluation), information: extractedInformationEvaluation } };

    return testResult;
  }

  async runTestCases() {
    const testCases = fs.readdirSync(this.config.test_suite.dir).filter((file: string) => {
      const fileName = path.basename(file, path.extname(file));
      return !fileName.endsWith('.example.json');
    });

    this.logger.info(`Running test cases`);
    this.logger.debug(`Running ${testCases.length} test cases`);

    for (const testFile of testCases) {
      const filePath = path.join(this.config.test_suite.dir, testFile);
      const testCase = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TestCase;

      this.logger.info(`Running test case ${testFile}`);
      const fileName = path.parse(testFile).name;
      const testLogger = this.createLoggerForTestCase(fileName);
      const testResult = await this.runTestCase(testCase, testLogger);
      this.saveTestResult(testResult, testFile);
    }

    await this.agent.disconnect();
  }
}

export default VoiceAITestBench;
