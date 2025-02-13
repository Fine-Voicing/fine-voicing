import { describe, test, expect, beforeEach, vi } from 'vitest';
import { OpenAITTSService } from '../openai-tts.service';
import OpenAI from 'openai';

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      audio: {
        speech: {
          create: vi.fn()
        }
      }
    }))
  };
});

describe('OpenAITTSService', () => {
  let service: OpenAITTSService;

  beforeEach(() => {
    service = new OpenAITTSService('test-api-key');

    // Mock the create method to return a mock audio response
    const mockOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;
    mockOpenAI.prototype.audio.speech.create = vi.fn().mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]))
    });
  });

  test('streams TTS audio in chunks', async () => {
    const chunks: Buffer[] = [];
    await service.streamTTS('test text', (chunk) => chunks.push(chunk));

    expect(chunks.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(chunks[0])).toBe(true);
  });

  test('handles errors gracefully', async () => {
    const mockError = new Error('API Error');
    const mockOpenAI = OpenAI as jest.MockedClass<typeof OpenAI>;
    mockOpenAI.prototype.audio.speech.create = vi.fn().mockRejectedValue(mockError);

    await expect(
      service.streamTTS('test text', () => {})
    ).rejects.toThrow('API Error');
  });
}); 