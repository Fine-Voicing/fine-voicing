import { AudioChunk, STTService } from "../types/index.js";
import { ConversationItem } from "../types/index.js";
import { AudioConverter } from "../utils/audio-converter.js";
import { TwilioLogger } from "../utils/logger.js";
import { WebSocket } from "ws";

interface UltavoxCallResponse {
    joinUrl: string;
}

interface TranscriptEvent {
    type: 'transcript';
    role: 'agent' | 'user';
    final: boolean;
    text: string;
}

interface ErrorEvent {
    type: 'error';
    error: string;
}

interface StateEvent {
    type: 'state';
    state: 'thinking' | 'speaking' | 'listening' | 'idle';
}

export class UltravoxService implements STTService {
    private client: WebSocket | null = null;
    private readonly apiKey: string;
    private readonly instructions: string;
    private readonly voice: string;
    private readonly model: string;
    private readonly language: string;

    private onAudioDelta: (audioDelta: string) => void;
    private onTranscriptionDone: (transcription: ConversationItem) => void;
    private onAudioDone: () => void;
    private onError: (error: any) => void;
    private isSessionUpdated: boolean = false;
    private logger: TwilioLogger;

    constructor(config: {
        apiKey: string;
        instructions: string;
        model?: string;
        voice?: string;
        language?: string;
        onAudioDelta: (audioDelta: string) => void;
        onTranscriptionDone: (transcription: ConversationItem) => void;
        onAudioDone: () => void;
        onError: (error: any) => void;
        logger: TwilioLogger;
    }) {
        this.apiKey = config.apiKey;
        this.instructions = config.instructions;
        this.model = config.model || "fixie-ai/ultravox";
        this.voice = config.voice || "Mark";
        this.language = config.language || "en-US";
        this.onAudioDelta = config.onAudioDelta;
        this.onTranscriptionDone = config.onTranscriptionDone;
        this.onAudioDone = config.onAudioDone;
        this.onError = config.onError;
        this.logger = config.logger;
    }

    async connect(): Promise<void> {
        const response = await fetch('https://api.ultravox.ai/api/calls', {
            method: 'POST',
            headers: {
                'X-API-Key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                systemPrompt: this.instructions,
                model: this.model,
                voice: this.voice,
                transcriptOptional: false,
                firstSpeakerSettings: { user: {} },
                recordingEnabled: true,
                medium: {
                    serverWebSocket: {
                        inputSampleRate: 8000,
                        outputSampleRate: 8000,
                        clientBufferSizeMs: 30000
                    }
                },
                vadSettings: {
                    turnEndpointDelay: "0.960s",
                    //minimumInterruptionDuration: "0.200s"
                }
                // experimentalSettings: {
                //     dynamicEndpointing: true
                // }
            })
        });

        const responseJson = await response.json() as UltavoxCallResponse;
        if (!response.ok) {
            const error = new Error(`Failed to get join URL: ${response.status} ${response.statusText} ${JSON.stringify(responseJson)}`);
            Object.assign(error, responseJson);
            throw error;
        }

        const { joinUrl } = responseJson;
        this.logger.debug(`Join URL: ${joinUrl}`);

        this.client = new WebSocket(joinUrl);
        this.client.on('open', () => {
            this.logger.info('WebSocket connection to Ultravox opened');
            //this.updateSession();
        });
        this.client.on('message', this.handleEvent.bind(this));
    }

    async disconnect(): Promise<void> {
        this.client?.close();
        this.client = null;
    }

    async sendAudio(audioChunk: AudioChunk): Promise<void> {
        if (this.client) {
            // if (this.isSilentFrame(audioChunk.data)) {
            //     this.logger.debug('Skipping silent audio frame');
            //     await new Promise(resolve => setTimeout(resolve, 10));
            //     return;
            // }

            const audioDataMulawToPCM16 = AudioConverter.convertMulawToPCM8k(audioChunk.data);
            this.logger.debug('Sending audio chunk to Ultravox');
            this.client.send(audioDataMulawToPCM16);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    private async handleEvent(event: Buffer | string, isBinary: boolean) {
        this.logger.debug(`Raw Event type: ${typeof event}, isBuffer: ${Buffer.isBuffer(event)}`);

        // Handle binary data (audio)
        if (isBinary) {
            this.logger.debug('Received binary audio data');
            const audioDataPCM16ToMulaw = AudioConverter.convertPCM8kToMulaw(event as Buffer);
            this.onAudioDelta(audioDataPCM16ToMulaw.toString('base64'));
            return;
        }

        // Handle text data
        return this.handleTextEvent(event as string);
    }

    private handleTextEvent(event: string) {
        try {
            const parsedEvent = JSON.parse(event.toString());
            this.logger.debug(`Parsed event: ${JSON.stringify(parsedEvent)}`);

            switch (parsedEvent?.type) {
                case 'transcript':
                    const transcriptEvent = parsedEvent as TranscriptEvent;
                    if (transcriptEvent.final) {
                        this.logger.debug(`Received transcript: ${JSON.stringify(transcriptEvent, null, 2)}`);
                        const role = transcriptEvent.role === 'agent' ? 'user' : 'assistant';
                        this.onTranscriptionDone({
                            role,
                            content: transcriptEvent.text
                        });
                    }
                    break;
                case 'error':
                    const errorEvent = parsedEvent as ErrorEvent;
                    this.logger.error(`Error: ${JSON.stringify(errorEvent)}`);
                    this.onError?.(errorEvent);
                    break;
                case 'state':
                    const stateEvent = parsedEvent as StateEvent;
                    this.logger.debug(`Received state: ${JSON.stringify(stateEvent, null, 2)}`);

                    if (stateEvent.state === 'listening' || stateEvent.state === 'idle') {
                        this.onAudioDone();
                    }
                    break;
            }
        } catch (error) {
            this.logger.error(`Error parsing event as JSON: ${error}`);
            this.onError?.(error);
        }
    }

    private updateSession() {
        this.client?.send(JSON.stringify({
            type: 'set_output_medium',
            outputMedium: 'voice'
        }));
    }

    public isConnected(): boolean {
        return this.client?.readyState === WebSocket.OPEN;
    }

    private isSilentFrame(audioData: Uint8Array): boolean {
        // In µ-law encoding, 0xFF (255) represents near-silence
        const threshold = 253; // High threshold since 255 is silence
        let silentSamples = 0;

        for (const byte of audioData) {
            if (byte >= threshold) {
                silentSamples++;
            }
        }

        // Consider frame silent if most samples are silent (e.g., 90%)
        return silentSamples / audioData.length > 0.9;
    }

}