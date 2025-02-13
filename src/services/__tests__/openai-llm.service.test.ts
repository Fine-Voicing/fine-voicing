import { describe, test, expect, beforeEach, vi } from 'vitest';
import { OpenAILLMService } from '../openai-llm.service';
import OpenAI from 'openai';

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn()
        }
      }
    }))
  };
});

describe('OpenAILLMService', () => {
  let service: OpenAILLMService;
  let mockStream: AsyncGenerator<any>;

  beforeEach(() => {
    service = new OpenAILLMService('test-api-key');
    
    // Create mock stream
    mockStream = (async function* () {
      yield { choices: [{ delta: { content: 'Hello' } }] };
      yield { choices: [{ delta: { content: ' World' } }] };
    })();

    // Mock the create method
    const mockOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;
    mockOpenAI.prototype.chat.completions.create = vi.fn().mockResolvedValue(mockStream);
  });

  test('streams LLM responses', async () => {
    const chunks: string[] = [];
    await service.streamLLM('test prompt', (chunk) => chunks.push(chunk));

    expect(chunks).toEqual(['Hello', ' World']);
  });

  test('handles errors gracefully', async () => {
    const mockError = new Error('API Error');
    const mockOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;
    mockOpenAI.prototype.chat.completions.create = vi.fn().mockRejectedValue(mockError);

    await expect(
      service.streamLLM('test prompt', () => {})
    ).rejects.toThrow('API Error');
  });
}); 