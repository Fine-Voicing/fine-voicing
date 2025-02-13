import OpenAI from 'openai';
import { TTSService } from '../types/index.js';

export class OpenAITTSService implements TTSService {
  private client: OpenAI;
  
  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async streamTTS(
    text: string,
    onData: (chunk: Buffer) => void,
    modelInstanceId?: string
  ): Promise<void> {
    const response = await this.client.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      response_format: 'pcm',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    
    // Since OpenAI doesn't support streaming TTS yet, we'll chunk the buffer
    const chunkSize = 1024;
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.slice(i, i + chunkSize);
      onData(chunk);
    }
  }
} 