import VoiceAITestBench from './test-bench';
import winston, { format } from 'winston';
import yargs from 'yargs';
import fs from 'fs';
import path from 'path';

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Add command line arguments parsing
const argv = yargs(process.argv.slice(2))
  .option('debug', {
    alias: 'd',
    type: 'boolean',
    description: 'Enable debug logging',
    default: false
  })
  .option('test-case', {
    alias: 'n',
    type: 'string',
    description: 'Run only test case with the given name'
  })
  .help()
  .argv;

const logger = winston.createLogger({
    level: argv.debug ? 'debug' : 'info',  // Set log level based on debug flag
    format: format.combine(
      format.timestamp(),
      format.printf((info) => {
        const { timestamp, level, message } = info;
        return `${timestamp} [${level}]: ${message}`;
      })
    ),
    transports: [
      new winston.transports.Console()
      // Removed global log file - each test case will have its own log file
    ]
  });

const testBench = new VoiceAITestBench(logger);

if (argv['test-case']) {
  testBench.runTestCaseByName(argv['test-case']);
} else {
  testBench.runTestCases();
}
