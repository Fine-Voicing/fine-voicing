import VoiceAITestBench from './test-bench';
import winston, { format } from 'winston';

const logger = winston.createLogger({
    level: 'info',
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
testBench.runTestSuite();