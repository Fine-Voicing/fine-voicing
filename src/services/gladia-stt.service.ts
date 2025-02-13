import WebSocket from 'ws';
import axios from 'axios';
import { log } from '../utils/logger.js';
import { AudioChunk } from '../types/index.js';

export class GladiaSTTService {
  private connection: WebSocket | null = null;
  private stopRecordingTimers: Map<string, NodeJS.Timeout> = new Map();
  private audioQueues: AudioChunk[] | null = null;
  private streamId: string;
  private readonly apiKey: string;
  private readonly AUDIO_DEBOUNCE_MS = 200;
  private onData: (transcription: string) => void;

  constructor(streamId: string, apiKey: string, onData: (transcription: string) => void) {
    this.streamId = streamId;
    this.apiKey = apiKey;
    this.onData = onData;
    this.audioQueues = [];
  }

  async connect() {
    try {
      if (this.connection) {
        log.info('Gladia WebSocket already connected', { streamId: this.streamId });
        return;
      }

      // Step 1: Get WebSocket URL from /v2/live endpoint
      log.info(`Connecting to Gladia`);
      const response = await axios.post('https://api.gladia.io/v2/live', {
        sample_rate: 8000,
        encoding: 'wav/ulaw',
        bit_depth: 16,
        channels: 1,
      }, {
        headers: {
          'x-gladia-key': this.apiKey,
          'Content-Type': 'application/json'
        }
      });

      const { url } = response.data;
      log.info(`Gladia WebSocket URL: ${url}`);
      this.connection = new WebSocket(url);;

      this.connection.on('open', () => {
        log.debug('Gladia WebSocket opened', { streamId: this.streamId });
        this.flushAudioQueue(this.streamId);
      });

      this.connection.on('message', (data: string) => {
        const response = JSON.parse(data);
        log.debug(`Received response from Gladia: ${JSON.stringify(response, null, 2)}`);

        // Handle different response types
        if (response.type === 'transcript' && response.data.is_final) {
          this.onData(response.data.utterance.text);
        }
        else if (response.type === 'audio_chunk') {
          if (response.acknowledged) {
            log.debug('Audio chunk acknowledged', { streamId: this.streamId });
          }
        }
      });

      this.connection.on('error', (error) => {
        log.error('Gladia WebSocket error', error, { streamId: this.streamId });
      });

      this.connection.on('close', () => {
        log.info('Gladia WebSocket closed', { streamId: this.streamId });
      });
    } catch (error: any) {
      const errorMessage = `Failed to initialize Gladia connection: ${error.message}`;
      if (this.connection && this.connection.readyState === WebSocket.OPEN) {
        this.connection.close();
        this.connection = null;
      }
      throw new Error(errorMessage);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      log.info(`Disconnecting from Gladia`, { streamId: this.streamId });
      // Clear any pending stop recording timer
      this.clearStopRecordingTimer(this.streamId);
      if (this.connection.readyState === WebSocket.OPEN) {
        this.connection.close();
      }
      this.connection = null;
      this.audioQueues = null;
    }
  }

  private clearStopRecordingTimer(streamId: string) {
    const existingTimer = this.stopRecordingTimers.get(streamId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.stopRecordingTimers.delete(streamId);
    }
  }

  private scheduleStopRecording(streamId: string, ws: WebSocket) {
    // Clear any existing timer first
    this.clearStopRecordingTimer(streamId);

    // Set new timer
    const timer = setTimeout(() => {
      log.debug(`No audio received for ${this.AUDIO_DEBOUNCE_MS}ms, sending stop recording to Gladia`, { streamId });
      ws.send(JSON.stringify({
        'type': 'stop_recording'
      }));
      this.stopRecordingTimers.delete(streamId);
    }, this.AUDIO_DEBOUNCE_MS);

    this.stopRecordingTimers.set(streamId, timer);
  }

  private async flushAudioQueue(streamId: string) {
    if (!this.audioQueues || !this.connection || this.connection.readyState !== WebSocket.OPEN) {
      return;
    }

    log.debug(`Flushing ${this.audioQueues.length} queued audio chunks`, { streamId });
    
    while (this.audioQueues.length > 0) {
      const chunk = this.audioQueues?.shift();
      if (chunk) {
        await this.sendAudio(chunk);
      }
    }
  }

  async sendAudio(audioChunk: AudioChunk): Promise<void> {
    const ws = this.connection;

    if (!ws) {
      log.error('No Gladia WebSocket connection found', undefined, { streamId: audioChunk.streamSid });
      return;
    }

    // If WebSocket isn't ready, queue the chunk
    if (ws.readyState !== WebSocket.OPEN) {
      log.debug('WebSocket not ready, queuing audio chunk', { streamId: audioChunk.streamSid });
      this.audioQueues?.push(audioChunk);
      return;
    }

    // If the connection is open, send the audio chunk
    log.debug('Sending audio chunk to Gladia', { streamId: audioChunk.streamSid });
    ws.send(JSON.stringify({
      type: 'audio_chunk',
      data: {
        chunk: audioChunk.data.toString("base64"),
      },
    }));

    // Schedule stop recording after this chunk
    this.scheduleStopRecording(audioChunk.streamSid, ws);
  }
}