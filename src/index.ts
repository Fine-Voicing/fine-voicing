import VoiceAITestBench from './test-bench';
import winston, { format } from 'winston';
import yargs from 'yargs';

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
      new winston.transports.Console(),
      new winston.transports.File({ filename: 'combined.log' })
    ]
  });

const testBench = new VoiceAITestBench(logger);

if (argv['test-case']) {
  testBench.runTestCase(argv['test-case']);
} else {
  testBench.runTestCases();
}
