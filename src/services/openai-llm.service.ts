import OpenAI from 'openai';
import { LLMService } from '../types/index.js';

export class OpenAILLMService implements LLMService {
  private client: OpenAI;
  private model: string;
  
  constructor(apiKey: string, model: string = 'gpt-4o') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async streamLLM(
    prompt: string,
    onData: (chunk: string) => void
  ): Promise<void> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        onData(content);
      }
    }
  }

  async completeLLM(
    prompt: string,
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }]
    });

    if (!response.choices[0]?.message?.content) {
      throw new Error('No response from LLM');
    }

    return response.choices[0]?.message?.content;
  }
} 