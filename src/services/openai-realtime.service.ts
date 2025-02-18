import { STTService, AudioChunk } from '../types/index.js';
import { log } from '../utils/logger.js';
import { WebSocket } from 'ws';
import { ConversationItem } from '../types/index.js';
import { TwilioLogger } from '../utils/logger.js';

export class OpenAIRealtimeService implements STTService {
    private client: WebSocket | null = null;
    private readonly apiKey: string;
    private readonly instructions: string;
    private readonly voice: string;
    private readonly model: string;

    private onAudioDelta: (audioDelta: string) => void;
    private onTranscriptionDone: (transcription: ConversationItem) => void;
    private onAudioDone: () => void;
    private onError: (error: any) => void;
    private isSessionUpdated: boolean = false;
    private logger: TwilioLogger;

    private readonly DEFAULT_MODEL = 'gpt-4o-realtime-preview';

    constructor(config: {
        apiKey: string;
        instructions: string;
        model?: string;
        voice?: string;
        onAudioDelta: (audioDelta: string) => void;
        onTranscriptionDone: (transcription: ConversationItem) => void;
        onAudioDone: () => void;
        onError: (error: any) => void;
        logger: TwilioLogger;
    }) {
        this.apiKey = config.apiKey || process.env.OPENAI_API_KEY as string;
        this.instructions = config.instructions;
        this.model = config.model || this.DEFAULT_MODEL;
        this.voice = config.voice || 'alloy';
        this.onAudioDelta = config.onAudioDelta;
        this.onTranscriptionDone = config.onTranscriptionDone;
        this.onAudioDone = config.onAudioDone;
        this.onError = config.onError;
        this.logger = config.logger;
    }

    async connect(): Promise<void> {
        try {
            if (this.client) {
                this.logger.info('OpenAI Realtime client already connected');
                return;
            }

            this.logger.debug('Initializing OpenAI Realtime client');
            const url = `wss://api.openai.com/v1/realtime?model=${this.model}`;
            this.client = new WebSocket(
                url,
                {
                  headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "OpenAI-Beta": "realtime=v1",
                  },
                }
            );
            this.client.on('open', this.sendSessionUpdate.bind(this));
            this.client.on('open', () => {
                this.logger.info('OpenAI Realtime client connected');
            });
            this.client.on('message', this.handleEvent.bind(this));
            //this.logger.info('OpenAI Realtime client connected');
        } catch (error: any) {
            const errorMessage = `Failed to initialize OpenAI Realtime connection: ${error.message}`;
            this.logger.error(errorMessage);
            throw new Error(errorMessage);
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            this.logger.info('Disconnecting OpenAI Realtime client');
            this.client.close();
            this.client = null;
        }
    }

    private isSilentFrame(audioData: Uint8Array): boolean {
        // G.711 µ-law has a bias of 128, so we need to decode the values
        // This is a simple amplitude check - adjust threshold as needed
        const threshold = 2; // Adjust this value based on your needs
        let maxAmplitude = 0;
        
        for (const byte of audioData) {
            // Convert µ-law to linear PCM (simplified)
            const linear = Math.abs(byte - 128);
            maxAmplitude = Math.max(maxAmplitude, linear);
        }
        
        return maxAmplitude < threshold;
    }

    async sendAudio(audioChunk: AudioChunk): Promise<void> {
        if (!this.client) {
            this.logger.error('No OpenAI Realtime connection found');
            return;
        }

        try {
            // Skip silent frames
            if (this.isSilentFrame(audioChunk.data)) {
                this.logger.debug('Skipping silent audio frame');
                return;
            }

            this.logger.debug('Sending audio chunk to OpenAI Realtime');
            this.client.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: audioChunk.data.toString('base64')
            }));
            await new Promise(resolve => setTimeout(resolve, 10));
        } catch (error: any) {
            this.logger.error(`Error sending audio to OpenAI Realtime: ${error.message}`, error);
            throw error;
        }
    }

    private async handleEvent(data: any) {
        const event = JSON.parse(data.toString());

        switch (event?.type) {
            case 'session.updated':
                this.logger.debug(`Session updated ${JSON.stringify(event, null, 2)}`);

                if (!this.isSessionUpdated && 
                    event.session.turn_detection.type === 'server_vad' &&
                    event.session.input_audio_format === 'g711_ulaw' &&
                    event.session.output_audio_format === 'g711_ulaw' &&
                    event.session.modalities.includes('text') &&
                    event.session.modalities.includes('audio') &&
                    event.session.input_audio_transcription.model === 'whisper-1'
                ) {
                    this.logger.debug(`Session updated to default configuration`);
                    this.isSessionUpdated = true;
                }

                break;
            case 'response.audio.delta':
                this.logger.debug(`Received audio delta ${JSON.stringify(event, null, 2)}`);
                this.onAudioDelta(event.delta);
                break;
            case 'response.text.done':
            case 'response.audio_transcript.done':
            case 'conversation.item.input_audio_transcription.completed':
                this.logger.debug(`Received transcript: ${JSON.stringify(event, null, 2)}`);
                const role = event.type === 'conversation.item.input_audio_transcription.completed' ? 'assistant' : 'user';
                this.onTranscriptionDone({
                    role,
                    content: event.transcript
                });
                break;
            case 'response.audio.done':
                this.logger.debug(`Received audio done ${JSON.stringify(event, null, 2)}`);
                this.onAudioDone();
                break;
            case 'response.done':
                this.logger.debug(`Received response done ${JSON.stringify(event, null, 2)}`);
                if (event.error) {
                    this.logger.error(`OpenAI Realtime error: ${JSON.stringify(event, null, 2)}`);
                    this.onError?.(event);
                }
                break;
            case 'error':
                this.logger.error(`OpenAI Realtime error: ${JSON.stringify(event, null, 2)}`);
                this.onError?.(event);
                break;
            default:
                this.logger.debug(`Received unhandled event: ${JSON.stringify(event)}`);
                break;
        }
    }

    private sendSessionUpdate() {
        this.client?.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: this.instructions,
                voice: this.voice as ("alloy" | "echo" | "shimmer" | "ash" | "ballad" | "coral" | "sage" | "verse"),
                turn_detection: { type: 'server_vad', threshold: 0.5, create_response: true, silence_duration_ms: 1000 },
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                modalities: ['text', 'audio'],
                input_audio_transcription: { model: 'whisper-1' },
            }
        }));
    }

    public getClient(): WebSocket | null {
        return this.client;
    }

    public isConnected(): boolean {
        return this.client?.readyState === WebSocket.OPEN && this.isSessionUpdated;
    }
} 
