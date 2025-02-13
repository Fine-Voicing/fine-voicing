import { describe, test, expect, beforeEach, vi } from 'vitest';
import { ConversationAgent } from '../conversation-agent.js';
import { AGENT_MODE, LLMService as ILLMService } from '../types/index.js';
import { OpenAILLMService } from '../services/openai-llm.service.js';

// Mock services
class MockGladiaSTT {
  async connect() { }
  async disconnect() { }
  async sendAudio(audioChunk: any) {
    // Simulate transcription after brief delay
    setTimeout(() => {
      this.eventBus?.emit('transcription-chunk', {
        text: "Hello world",
        streamSid: audioChunk.streamSid,
        modelInstanceId: audioChunk.modelInstanceId
      });
    }, 50);
  }
  eventBus?: any;
}

class MockLLM implements ILLMService {
  async streamLLM(prompt: string, onData: (chunk: string) => void) {
    // Simulate LLM response with delay
    setTimeout(() => {
      onData("AI response");
    }, 50);
  }
  async completeLLM(prompt: string): Promise<string> {
    return "AI response";
  }
}

class MockTTS {
  async streamTTS(text: string, onData: (chunk: Buffer) => void) {
    // Simulate TTS audio output with delay
    setTimeout(() => {
      onData(Buffer.from("audio data"));
    }, 50);
  }
}

describe('ConversationAgent', () => {
  let agent: ConversationAgent;
  let mockSTT: MockGladiaSTT;
  let mockLLM: MockLLM;
  let mockTTS: MockTTS;

  beforeEach(() => {
    mockSTT = new MockGladiaSTT();
    mockLLM = new MockLLM();
    mockTTS = new MockTTS();
    agent = new ConversationAgent({
      mode: AGENT_MODE.LLM,
      instructions: 'test-instructions',
      llmService: mockLLM,
      ttsService: mockTTS,
      sttService: mockSTT
    });
  });

  test('processes audio through the pipeline', async () => {
    const testAudio = {
      data: Buffer.from('test audio'),
      streamSid: 'test-stream',
      modelInstanceId: 'test-model'
    };

    return new Promise<void>((resolve) => {
      // Listen for output audio
      agent.onOutgoingAudio((audioChunk) => {
        expect(audioChunk.streamSid).toBe('test-stream');
        expect(audioChunk.modelInstanceId).toBe('test-model');
        expect(audioChunk.data).toBeDefined();
        resolve();
      });

      // Send test audio
      agent.handleIncomingAudio(testAudio);
    });
  });

  test('handles cleanup correctly', async () => {
    const streamSid = 'test-stream';
    const disconnectSpy = vi.spyOn(mockSTT, 'disconnect');

    await agent.handleIncomingAudio({
      data: Buffer.from('test'),
      streamSid
    });

    await agent.cleanup();

    expect(disconnectSpy).toHaveBeenCalledWith(streamSid);
  });

  test('handles STT errors correctly', async () => {
    const errorSpy = vi.fn();
    const testError = new Error('STT error');

    vi.spyOn(mockSTT, 'sendAudio').mockRejectedValueOnce(testError);

    agent['eventBus'].on('transcription-error', errorSpy);

    await agent.handleIncomingAudio({
      data: Buffer.from('test'),
      streamSid: 'test-stream'
    });

    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({
      error: testError,
      streamSid: 'test-stream'
    }));
  });

  test('handles multiple concurrent streams', async () => {
    const stream1 = 'stream-1';
    const stream2 = 'stream-2';

    const connectSpy = vi.spyOn(mockSTT, 'connect');

    await Promise.all([
      agent.handleIncomingAudio({
        data: Buffer.from('test1'),
        streamSid: stream1
      }),
      agent.handleIncomingAudio({
        data: Buffer.from('test2'),
        streamSid: stream2
      })
    ]);

    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(connectSpy).toHaveBeenCalledWith(stream1);
    expect(connectSpy).toHaveBeenCalledWith(stream2);
  });

  test('handles speech end event', async () => {
    const streamSid = 'test-stream';
    const disconnectSpy = vi.spyOn(mockSTT, 'disconnect');

    // First connect
    await agent.handleIncomingAudio({
      data: Buffer.from('test'),
      streamSid
    });

    // Emit speech end
    agent['eventBus'].emit('speech_end', { streamSid });

    // Wait for async operations
    await vi.waitFor(() => {
      expect(disconnectSpy).toHaveBeenCalledWith(streamSid);
    });
  });

  test('Generates persona instructions correctly', async () => {
    const mockLLM = new class implements ILLMService {
      async streamLLM(prompt: string, onData: (chunk: string) => void) {
        // Simulate LLM response with delay
        setTimeout(() => {
          onData("AI response");
        }, 50);
      }
      async completeLLM(prompt: string): Promise<string> {
        // Simulate LLM response with delay
        const personaInstructions = {
          testing_role: {
            role_name: 'Testing Role',
            role_prompt: 'Testing Role Prompt'
          },
          moderator: {
            role_name: 'Moderator Role',
            role_prompt: 'Moderator Role Prompt'
          }
        };
        return JSON.stringify(personaInstructions);
      }
    }
    const agent = new ConversationAgent({
      mode: AGENT_MODE.LLM,
      instructions: 'test-instructions',
      llmService: mockLLM
    });
    const personaInstructions = await agent.generatePersonaInstructions();
    expect(personaInstructions).toBeDefined();
    expect(personaInstructions.testing_role).toBeDefined();
    expect(personaInstructions.moderator).toBeDefined();
    expect(personaInstructions.testing_role.role_name).toBe('Testing Role');
    expect(personaInstructions.moderator.role_name).toBe('Moderator Role');
    expect(personaInstructions.testing_role.role_prompt).toBe('Testing Role Prompt');
    expect(personaInstructions.moderator.role_prompt).toBe('Moderator Role Prompt');
  });

  test.only('Moderates conversation correctly', async () => {
    const mockLLM = new class implements ILLMService {
      async streamLLM(prompt: string, onData: (chunk: string) => void) {
        throw new Error('Not implemented');
      }

      async completeLLM(prompt: string): Promise<string> {
        return JSON.stringify({
          testing_role: {
            role_name: "Carla",
            role_prompt: "You are Carla, a customer service representative at a real estate agency. When you answer the phone, greet the caller warmly and professionally. Your goal is to collect key information: the caller's name, the property they are interested in (reference number if available), their available dates for a property visit, and their intended move-in date or period. Ask each question individually and wait for the response before proceeding. If you don't understand a response, politely ask the caller to repeat it. If the conversation strays off-topic, politely end the call after informing the caller. Once you have collected all necessary information, inform the caller that you will forward their details to a human agent who will contact them. End the call afterwards."
          },
          moderator: {
            role_name: "Moderator",
            role_prompt: "You are the moderator overseeing a conversation between Carla, a real estate agency representative, and a caller. Ensure that the conversation is conducted professionally and stays on topic. It should take place over the phone in European Portuguese, lasting for two exchanges. Your role is to ensure that Carla collects all necessary information from the caller efficiently. If Carla doesn't get the required information or if the caller strays off-topic, the call should be courteously concluded."
          }
        });
      }
    }

    const agent = new ConversationAgent({
      mode: AGENT_MODE.LLM,
      instructions: 'test-instructions',
      llmService: mockLLM
    });

    const spyFormatTranscripts = vi.spyOn(agent, 'formatTranscripts').mockReturnValue(`
      - assistant: Sou da Agência Imobiliária e estou aqui para ajudá-lo com informações sobre arrendamento de propriedade. Como posso ajudá-lo hoje?
    - user: Boa tarde! Estou interessada em saber mais sobre o processo de arrendamento de propriedades. Você pode explicar como funciona e quais são os passos para alugar um imóvel?
    `);

    await agent.generatePersonaInstructions();
    const shouldContinue = await agent.moderateConversation();
    expect(spyFormatTranscripts).toHaveBeenCalled();
    expect(shouldContinue).toBe(true);
  });
}); 