import OpenAI from 'openai';
import { LLMService } from '../types/index.js';

export class OpenRouterLLMService implements LLMService {
  private client: OpenAI;
  private model: string;
  private readonly OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

  constructor(apiKey: string, model: string = 'gpt-4o') {
    this.client = new OpenAI({
      apiKey: apiKey, // defaults to process.env["OPENAI_API_KEY"]
      baseURL: this.OPENROUTER_BASE_URL,
    });
    this.model = model;
  }

  async stream(
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

  async complete(
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