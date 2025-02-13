import { EventEmitter } from 'events';
import { AudioChunk, TextChunk, LLMService, TTSService, STTService, ErrorEvent, AGENT_MODE } from './types/index.js';
import { OpenAILLMService } from './services/openai-llm.service.js';
import { OpenAITTSService } from './services/openai-tts.service.js';
import { OpenAIRealtimeService } from './services/openai-realtime.service.js';
import { ConversationItem, PersonaInstructions, PersonaInstruction } from './types/index.js';
import { TwilioLogger } from './utils/logger.js';

// Main conversation agent class
export class ConversationAgent {
  private eventBus: EventEmitter;
  private streamId: string;
  private llmService: LLMService | null = null;
  private ttsService: TTSService | null = null;
  private sttService: STTService | null = null;
  private transcripts: ConversationItem[] = [];
  private transcriptionBuffers: Map<string, string> = new Map();
  private transcriptionTimers: Map<string, NodeJS.Timeout> = new Map();
  private llmBuffers: Map<string, string> = new Map();
  private llmTimers: Map<string, NodeJS.Timeout> = new Map();
  private ttsOutputTimers: Map<string, NodeJS.Timeout> = new Map();
  private realtimeService: OpenAIRealtimeService | null = null;
  private mode: AGENT_MODE;
  private originalInstructions: string;
  private personaRole: PersonaInstruction | null = null;
  private moderatorRole: PersonaInstruction | null = null;
  private audioBuffer: AudioChunk[] = [];
  private isProcessing: boolean = false;
  private isSpeaking: boolean = false;
  private callSid: string;

  private readonly logger: TwilioLogger | null = null;

  private readonly TRANSCRIPTION_DEBOUNCE_MS = 100;
  private readonly LLM_DEBOUNCE_MS = 100;
  private readonly TTS_OUTPUT_DEBOUNCE_MS = 100;

  private readonly PERSONA_SYSTEM_INSTRUCTIONS = `
  # Goal
Generate detailed instructions for two roles engaging in a conversation:
- A persona testing an AI agent. The tested AI agent is following the instructions below. Invent a character to engage in a conversation with it. Feel free to add details to make the conversation more realistic. The more details, the better.
- A moderator watching the conversation. Its role is to decide wether or not the conversation should continue.

# Output format
JSON string. No markdown. Must match this typescript definition:

export interface PersonaInstruction {
  role_name: string;
  role_prompt: string;
}

export interface PersonaInstructions {
  testing_role: PersonaInstruction;
  moderator: PersonaInstruction;
} 

# Prompt guidelines
  - Today's date timestamp ${new Date().toISOString()}
  - Conversation happening over the phone
  - Happen in {language}.
  - Testing role gender is female.
  - Use realistic names based on gender.
 -   The conversation should last {max_turns} turns.
  
# Tested Role Instructions
  {instructions}`;

  constructor(config: {
    callSid?: string,
    streamId?: string,
    mode: AGENT_MODE,
    instructions: string,
    llmService?: LLMService,
    ttsService?: TTSService,
    sttService?: STTService,
  }) {
    this.logger?.info('Initializing ConversationAgent');
    this.eventBus = new EventEmitter();

    this.callSid = config.callSid || '<PENDING_CALL_SID>';
    this.streamId = config.streamId || '<PENDING_STREAM_ID>';
    this.mode = config.mode;
    this.originalInstructions = config.instructions;

    this.logger = new TwilioLogger(config.callSid, config.streamId);

    this.llmService = config.llmService || null;
    this.ttsService = config.ttsService || null;
    this.sttService = config.sttService || null;
  }

  private setupEventHandlers() {
    this.logger?.info('Setting up event handlers');

    // Handle incoming audio
    this.eventBus.on('audio-received', this.handleAudioReceived.bind(this));

    if (this.mode === AGENT_MODE.LLM) {
      // Handle transcription chunks
      this.eventBus.on('transcription-chunk', this.handleTranscriptionChunk.bind(this));

      // Handle LLM response chunks
      this.eventBus.on('llm-response-chunk', this.handleLLMResponseChunk.bind(this));
    }

    this.logger?.info('Event handlers setup completed');
  }

  private async initialize() {
    if (!this.llmService) {
      this.llmService = new OpenAILLMService(process.env.OPENAI_API_KEY as string);
    }

    await this.generatePersonaInstructions();

    if (this.mode === AGENT_MODE.LLM) {
      if (!this.ttsService) {
        this.ttsService = new OpenAITTSService(process.env.OPENAI_API_KEY as string);
      }
      //this.sttService = sttService || new GladiaSTTService(streamId, process.env.GLADIA_API_KEY as string, this.processTranscriptionChunk.bind(this));
    }
    else {
      this.realtimeService = new OpenAIRealtimeService({
        apiKey: process.env.OPENAI_API_KEY as string,
        instructions: this.personaRole?.role_prompt || this.originalInstructions,
        voice: 'ash',
        onAudioDelta: this.processSTSResponse.bind(this),
        onTranscriptionDone: this.processTranscriptionChunk.bind(this),
        onAudioDone: this.handleSTSResponseDone.bind(this),
        onError: this.handleSTSError.bind(this),
        logger: this.logger!
      });
    }

    this.setupEventHandlers();
    this.logger?.info('ConversationAgent initialized successfully');
  }

  public async start() {
    this.logger?.info('Starting ConversationAgent');

    await this.initialize();

    if (this.mode === AGENT_MODE.STS) {
      this.logger?.info('Initializing new STS stream connection');
      await this.realtimeService?.connect();
      while (!this.realtimeService?.isConnected()) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      this.logger?.info('STS stream connection established');
      this.isProcessing = true;
      this.processAudioBufferAsync();
    }
  }

  private async processAudioBufferAsync() {
    while (this.isProcessing) {
      try {
        if (this.audioBuffer.length > 0) {
          if (this.realtimeService?.isConnected()) {
            const chunk = this.audioBuffer.shift();
            if (chunk) {
              await this.realtimeService?.sendAudio(chunk);
            }
          }
          else {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        } else {
          // Wait a bit before checking again to avoid busy-waiting
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } catch (error: any) {
        this.logger?.error('Error processing audio buffer', error);
        this.eventBus.emit('error', {
          step: 'audio-buffer-processing',
          error,
          streamSid: this.streamId
        });
      }
    }
    this.logger?.debug('Audio buffer processing stopped');
  }

  private async handleAudioReceived(chunk: AudioChunk) {
    this.logger?.debug('Received audio chunk');
    try {
      switch (this.mode) {
        case AGENT_MODE.LLM:
          this.logger?.info('Initializing new STT stream connection');
          await this.sttService?.connect();
          this.logger?.info('STT stream connection established');
          this.logger?.debug('Processing audio through STT service');
          await this.sttService?.sendAudio(chunk);
          break;
        case AGENT_MODE.STS:
          this.logger?.debug('Buffering audio chunk');
          this.audioBuffer.push(chunk);
          break;
      }
    } catch (error: any) {
      this.logger?.error('Error processing audio', error);
      this.eventBus.emit('error', {
        step: 'audio-received',
        error,
        streamSid: chunk.streamSid,
        modelInstanceId: chunk.modelInstanceId
      });
    }
  }

  private async handleTranscriptionChunk(data: TextChunk) {
    this.logger?.debug('Processing transcription through LLM');
    try {
      await this.llmService?.streamLLM(
        data.text,
        this.processLLMResponseChunk.bind(this),
      );
    } catch (error: any) {
      this.logger?.error('Error processing LLM response', error);
      this.eventBus.emit('error', {
        step: 'llm-response-chunk',
        error,
        streamSid: data.streamSid,
        modelInstanceId: data.modelInstanceId
      });
    }
  }

  private clearTTSOutputTimer(streamId: string) {
    const existingTimer = this.ttsOutputTimers.get(streamId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.ttsOutputTimers.delete(streamId);
    }
  }

  private async handleLLMResponseChunk(data: TextChunk) {
    this.logger?.debug(`Received LLM response chunk: "${data.text}"`);

    // Get or initialize buffer for this stream
    const currentBuffer = this.llmBuffers.get(data.streamSid) || '';
    this.llmBuffers.set(data.streamSid, currentBuffer + data.text);

    // Clear existing timer if any
    const existingTimer = this.llmTimers.get(data.streamSid);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(async () => {
      const completeResponse = this.llmBuffers.get(data.streamSid) || '';
      if (completeResponse) {
        this.logger?.info(`Converting complete response to speech: "${completeResponse}"`);

        try {
          await this.ttsService?.streamTTS(
            completeResponse, (chunk: Buffer) => this.processTTSOutput(chunk, data.streamSid), data.modelInstanceId
          );
        } catch (error: any) {
          this.logger?.error('Error in text-to-speech conversion', error);
          this.eventBus.emit('error', {
            step: 'tts-response-chunk',
            error,
            streamSid: data.streamSid,
            modelInstanceId: data.modelInstanceId
          });
        }

        // Clear the buffer after processing
        this.llmBuffers.set(data.streamSid, '');
      }
    }, this.LLM_DEBOUNCE_MS);

    this.llmTimers.set(data.streamSid, timer);
  }

  private async handleSpeechEnd(data: { streamSid: string }) {
    this.logger?.info('Speech end detected');

    // Clean up stream resources
    this.logger?.info('Disconnecting STT stream');
    await this.sttService?.disconnect();
    this.logger?.info('STT stream disconnected');
  }

  // Public methods for external interaction
  public async handleIncomingAudio(audioChunk: AudioChunk) {
    this.logger?.debug('Handling incoming audio chunk');
    this.eventBus.emit('audio-received', audioChunk);
  }

  private async handleSTSError(error: any) {
    this.logger?.error('OpenAI Realtime error', error);
    this.eventBus.emit('error', {
      step: 'sts-error',
      error
    });
  }

  public onOutgoingAudio(callback: (audioChunk: AudioChunk) => void) {
    this.logger?.info('Registering outgoing audio callback');
    this.isSpeaking = true;
    this.eventBus.on('audio-to-twilio', callback);
  }

  public async onResponseDone(callback: (streamSid: string) => void) {
    this.logger?.info('Registering response done callback');
    this.isSpeaking = false;
    this.eventBus.on('response.done', callback);
  }

  public onError(callback: (error: ErrorEvent) => void) {
    this.logger?.info('Registering error callback');
    this.eventBus.on('error', callback);
  }

  public async onTerminateConversation(callback: (streamSid: string) => void) {
    this.logger?.info('Registering terminate conversation callback');
    this.eventBus.on('terminate-conversation', callback);
  }

  private processTTSOutput(chunk: Buffer, streamId: string) {
    this.logger?.debug('Generated audio chunk for Twilio');

    // Emit audio chunk
    this.eventBus.emit('audio-to-twilio', {
      data: chunk,
      streamSid: streamId,
      //modelInstanceId: this.modelInstanceId
    });

    // Clear any existing TTS completion timer since we got new data
    this.clearTTSOutputTimer(streamId);

    // Start a new timer for TTS completion
    const timer = setTimeout(() => {
      this.logger?.info('No TTS output for 100ms, emitting response.done event');
      this.eventBus.emit('response.done', {
        streamSid: streamId,
        //modelInstanceId: this.modelInstanceId
      });
      this.ttsOutputTimers.delete(streamId);
    }, this.TTS_OUTPUT_DEBOUNCE_MS);

    this.ttsOutputTimers.set(streamId, timer);
  }

  private async processLLMResponseChunk(chunk: string) {
    this.logger?.debug(`Received LLM response chunk: "${chunk}"`);
    this.eventBus.emit('llm-response-chunk', {
      text: chunk,
      streamSid: this.streamId,
      //modelInstanceId: this.modelInstanceId
    });
    this.handleSpeechEnd({ streamSid: this.streamId });
  }

  private async processTranscriptionChunk(transcription: ConversationItem) {
    this.logger?.info(`Received transcription: "${JSON.stringify(transcription, null, 2)}"`);
    this.transcripts.push(transcription);

    this.eventBus.emit('transcription-chunk', {
      text: transcription,
      streamSid: this.streamId,
      //modelInstanceId: this.modelInstanceId
    });
  }

  private async processSTSResponse(audioDelta: string) {
    this.logger?.debug(`Received STS response: "${audioDelta}"`);
    this.eventBus.emit('audio-to-twilio', {
      data: Buffer.from(audioDelta, 'base64'),
      streamSid: this.streamId,
      //modelInstanceId: this.modelInstanceId
    });
  }

  private async handleSTSResponseDone() {
    this.logger?.info('STS response done');
    this.eventBus.emit('response.done', this.streamId);

    const shouldContinue = await this.moderateConversation();
    if (!shouldContinue) {
      while (this.isSpeaking) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      this.eventBus.emit('terminate-conversation', this.streamId);
    }
  }

  // Clean up method
  public async cleanup() {
    this.logger?.info('Starting cleanup');
    this.isProcessing = false;  // Stop the audio buffer processing
    this.isSpeaking = false;

    // Clear any pending timers
    const existingTranscriptionTimer = this.transcriptionTimers.get(this.streamId);
    if (existingTranscriptionTimer) {
      clearTimeout(existingTranscriptionTimer);
      this.transcriptionTimers.delete(this.streamId);
    }

    const existingLLMTimer = this.llmTimers.get(this.streamId);
    if (existingLLMTimer) {
      clearTimeout(existingLLMTimer);
      this.llmTimers.delete(this.streamId);
    }

    const existingTTSTimer = this.ttsOutputTimers.get(this.streamId);
    if (existingTTSTimer) {
      clearTimeout(existingTTSTimer);
      this.ttsOutputTimers.delete(this.streamId);
    }

    this.logger?.info('Transcripts: ' + this.formatTranscripts());

    this.logger?.info('Disconnecting active STT stream');
    this.transcriptionBuffers.delete(this.streamId);
    this.llmBuffers.delete(this.streamId);
    await this.sttService?.disconnect();
    this.logger?.info('Cleanup completed');
  }

  public async generatePersonaInstructions(): Promise<PersonaInstructions> {
    let personaSystemInstructions = this.PERSONA_SYSTEM_INSTRUCTIONS;
    personaSystemInstructions = personaSystemInstructions.replace('{instructions}', this.originalInstructions);
    personaSystemInstructions = personaSystemInstructions.replace('{language}', 'en-US');
    personaSystemInstructions = personaSystemInstructions.replace('{max_turns}', '10');

    this.logger?.debug('Persona system instructions: ' + personaSystemInstructions);

    let response = await this.llmService?.completeLLM(personaSystemInstructions);
    if (!response) {
      throw new Error('Failed to generate persona instructions');
    }

    try {
      const roles = JSON.parse(response) as PersonaInstructions;

      if (roles.testing_role.role_prompt === '' || roles.moderator.role_prompt === '') {
        throw new Error('Empty persona instructions');
      }

      this.logger?.info('Persona instructions: ' + JSON.stringify(roles, null, 2));
      this.personaRole = roles.testing_role;
      this.moderatorRole = roles.moderator;

      return roles;
    } catch (error: any) {
      this.logger?.error('Failed to parse persona instructions:', error);
      throw new Error('Invalid persona instructions format');
    }
  }

  public async moderateConversation(): Promise<boolean> {
    const prompt = `# Decision criteria
    \n${this.moderatorRole?.role_prompt}
    \n\nStart with continue OR terminate, without any formatting, all lower-case. Then, provide an explanation of the decision based on the conversation history. 
    \n\nAlways respond in English.
    \n\nConversation history (most recent last):
    \n${this.formatTranscripts()}`;

    this.logger?.debug('Moderation prompt: ' + prompt);
    const decision = (await this.llmService?.completeLLM(prompt))?.toLowerCase();
    this.logger?.info('Moderation decision: ' + decision);

    const shouldContinue = decision?.startsWith('continue') || false;
    this.logger?.info('Moderation, should continue: ' + shouldContinue);
    return shouldContinue;
  }

  public formatTranscripts() {
    return this.transcripts.map(item => `- ${item.role}: ${item.content}`).join('\n');
  }

  public setStreamId(streamId: string) {
    this.streamId = streamId;
    this.logger?.setStreamId(streamId);
  }

  public setCallSid(callSid: string) {
    this.callSid = callSid;
    this.logger?.setCallSid(callSid);
  }
}
