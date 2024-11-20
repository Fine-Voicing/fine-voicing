import { RealtimeClient } from '@openai/realtime-api-beta';
import { AtomicAgent } from './atomic-agent';
import OpenAI from 'openai';
import { TestMode, TestCase } from './test-bench.d';
import { Logger } from 'winston';

// Define atomic actions
type VoiceAction = 
  | { type: 'SPEAK'; payload: { message: string; mode: TestMode } }
  | { type: 'LISTEN'; payload: { instructions: string } };

// Define atomic reactions
type VoiceReaction = 
  | { type: 'SPEECH_COMPLETE'; payload: { message: string } }
  | { type: 'TRANSCRIPT_RECEIVED'; payload: { transcript: string } }
  | { type: 'ERROR'; payload: { error: any } };

// Define agent state for VoiceAgent
type VoiceAgentState = {
    currentVoice?: string;
    lastTranscript?: string;
    errorCount?: number;
};

export class VoiceAgent extends AtomicAgent<VoiceAction, VoiceReaction, VoiceAgentState> {
    private realtimeClient: RealtimeClient;
    private ttsClient: OpenAI;
    private logger: Logger;
    private voices: ("alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer")[];

    constructor(testCase: TestCase, logger: Logger) {
        // Provide an initial state when calling the parent constructor
        super({
            currentVoice: undefined,
            lastTranscript: undefined,
            errorCount: 0
        });
        this.logger = logger;
        this.voices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
        this.ttsClient = new OpenAI({ apiKey: testCase.voice_model.api_key });
        this.realtimeClient = this.initializeRealtimeClient(testCase);
        this.setupRealtimeClientHandlers();
    }

    private initializeRealtimeClient(testCase: TestCase): RealtimeClient {
        this.logger.info(`Initializing realtime client`);
        const realtimeClient = new RealtimeClient({ 
            apiKey: testCase.voice_model.api_key 
        });

        realtimeClient.updateSession({
            instructions: testCase.instructions,
            voice: testCase.voice_model.voice as ("alloy" | "echo" | "shimmer" | "ash" | "ballad" | "coral" | "sage" | "verse"),
            turn_detection: null,
            input_audio_transcription: { model: 'whisper-1' },
        });

        return realtimeClient;
    }

    private setupRealtimeClientHandlers() {
        // Set up realtime client event handlers
        this.realtimeClient.realtime.on('server.*', (event: any) => {
            this.logger.info(`Received realtime event: ${JSON.stringify(event)}`);
            if (event.type === 'transcript') {
                this.react({ 
                    type: 'TRANSCRIPT_RECEIVED', 
                    payload: { transcript: event.transcript } 
                });
            }
        });
    }

    protected setupActionHandlers(): void {
        this.on('SPEAK', this.handleSpeakAction);
        this.on('LISTEN', this.handleListenAction);
    }

    private handleSpeakAction(action: VoiceAction): void {
        if (action.type === 'SPEAK') {
            // Implement text-to-speech logic here
            const { message, mode } = action.payload;
            // Example implementation (you'll need to customize this)
            this.ttsClient.audio.speech.create({
                model: 'tts-1',
                voice: this.voices[0], // Default to first voice
                input: message
            }).then(response => {
                this.emit('SPEECH_COMPLETE', { message });
            }).catch(error => {
                this.emit('ERROR', { error });
            });
        }
    }

    private handleListenAction(action: VoiceAction): void {
        if (action.type === 'LISTEN') {
            // Implement speech-to-text logic here
            const { instructions } = action.payload;
            // Example implementation (you'll need to customize this)
            this.realtimeClient.startListening({
                instructions: instructions
            }).then(transcript => {
                this.emit('TRANSCRIPT_RECEIVED', { transcript });
            }).catch(error => {
                this.emit('ERROR', { error });
            });
        }
    }

    protected async onAction(action: VoiceAction): Promise<void> {
        try {
            switch (action.type) {
                case 'SPEAK':
                    const { message, mode } = action.payload;
                    if (mode === 'test') {
                        this.logger.info(`[TEST MODE] Would speak: ${message}`);
                        this.react({ type: 'SPEECH_COMPLETE', payload: { message } });
                        return;
                    }

                    const mp3Response = await this.ttsClient.audio.speech.create({
                        model: "tts-1",
                        voice: this.voices[Math.floor(Math.random() * this.voices.length)],
                        input: message
                    });

                    const buffer = Buffer.from(await mp3Response.arrayBuffer());
                    // TODO: Play the audio
                    this.logger.info(`Would play audio for message: ${message}`);
                    this.react({ type: 'SPEECH_COMPLETE', payload: { message } });
                    break;

                case 'LISTEN':
                    const { instructions } = action.payload;
                    this.logger.info(`Would listen with instructions: ${instructions}`);
                    // Mock transcript for now
                    this.react({ 
                        type: 'TRANSCRIPT_RECEIVED', 
                        payload: { transcript: "This is a mock transcript" } 
                    });
                    break;

                default:
                    throw new Error(`Unknown action type: ${(action as any).type}`);
            }
        } catch (error) {
            this.react({ type: 'ERROR', payload: { error } });
        }
    }

    private async handleSpeak({ message, mode }: { message: string; mode: TestMode }) {
        try {
            if (mode === TestMode.TTS) {
                const audioBuffer = await this.tts(message);
                await this.realtimeClient.sendUserMessageContent([{ 
                    type: 'input_audio', 
                    audio: audioBuffer.toString('base64') 
                }]);
            } else {
                await this.realtimeClient.sendUserMessageContent([{ 
                    type: 'input_text', 
                    text: message 
                }]);
            }
            
            this.emit('reaction', { 
                type: 'SPEECH_COMPLETE', 
                payload: { message } 
            });
        } catch (error) {
            this.emit('reaction', { 
                type: 'ERROR', 
                payload: { error } 
            });
        }
    }

    private async handleListen({ instructions }: { instructions: string }) {
        try {
            await this.realtimeClient.updateSession({
                instructions,
                turn_detection: null,
                input_audio_transcription: { model: 'whisper-1' },
            });
        } catch (error) {
            this.emit('reaction', { 
                type: 'ERROR', 
                payload: { error } 
            });
        }
    }

    private handleRealtimeEvent(event: any) {
        if (event?.type === 'response.done') {
            const transcript = event.response.output[0].content[0].transcript;
            this.emit('reaction', { 
                type: 'TRANSCRIPT_RECEIVED', 
                payload: { transcript } 
            });
        } else if (event?.type === 'error') {
            this.emit('reaction', { 
                type: 'ERROR', 
                payload: { error: event } 
            });
        }
    }

    private async tts(message: string): Promise<Buffer> {
        const randomVoice = this.voices[Math.floor(Math.random() * this.voices.length)];
        const ttsResponse = await this.ttsClient.audio.speech.create({
            model: "tts-1",
            voice: randomVoice,
            input: message,
            response_format: 'pcm'
        });

        return Buffer.from(await ttsResponse.arrayBuffer());
    }

    public async connect(): Promise<void> {
        await this.realtimeClient.connect();
    }

    public async disconnect(): Promise<void> {
        if (this.realtimeClient?.realtime) {
            this.realtimeClient.realtime.removeAllListeners('server.*');
            await this.realtimeClient.disconnect();
        }
    }
}

export type { VoiceAction, VoiceReaction };
