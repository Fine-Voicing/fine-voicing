import { createLogger, format, transports } from 'winston';
import { join } from 'path';

// Create logs directory if it doesn't exist
const logsDir = join(process.cwd(), 'logs');

const logFormat = format.printf(({ level, message, timestamp, streamId, callSid }) => {
  const callPrefix = callSid ? `[Call ${callSid}] ` : '';
  const streamPrefix = streamId ? `[Stream ${streamId}] ` : '';
  return `${timestamp} ${level}: ${streamPrefix}${callPrefix}${message}`;
});

const logger = createLogger({
  format: format.combine(
    format.timestamp(),
    format.colorize(),
    logFormat
  ),
  transports: [
    // Console transport
    new transports.Console({
      level: 'info'
    }),
    // File transport for all logs
    new transports.File({
      filename: join(logsDir, 'combined.log'),
      level: 'debug',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // File transport for error logs
    new transports.File({
      filename: join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  ]
});

export interface LogContext {
  streamId?: string;
  callSid?: string;
}

export const log = {
  debug: (message: string, context: LogContext = {}) => {
    logger.debug(message, { streamId: context.streamId, callSid: context.callSid });
  },
  info: (message: string, context: LogContext = {}) => {
    logger.info(message, { streamId: context.streamId, callSid: context.callSid });
  },
  warn: (message: string, context: LogContext = {}) => {
    logger.warn(message, { streamId: context.streamId, callSid: context.callSid });
  },
  error: (message: string, error?: Error, context: LogContext = {}) => {
    const errorMessage = error ? `${message}: ${error.message}\n${error.stack}` : message;
    logger.error(errorMessage, { streamId: context.streamId, callSid: context.callSid });
  }
}; 

export class TwilioLogger {
  private callSid: string;
  private streamId: string;

  constructor(callSid?: string, streamId?: string) {
    this.callSid = callSid || '<PENDING_CALL_SID>';
    this.streamId = streamId || '<PENDING_STREAM_ID>';
  }

  public debug(message: string) {
    log.debug(message, { callSid: this.callSid, streamId: this.streamId });
  }

  public info(message: string) {
    log.info(message, { callSid: this.callSid, streamId: this.streamId });
  }

  public error(message: string, error?: Error) {
    log.error(message, error, { callSid: this.callSid, streamId: this.streamId });
  }

  public warn(message: string) {
    log.warn(message, { callSid: this.callSid, streamId: this.streamId });
  }

  public setCallSid(callSid: string) {
    this.callSid = callSid;
  }

  public setStreamId(streamId: string) {
    this.streamId = streamId;
  }
}