import { WebSocketServer, WebSocket } from 'ws';
import { TwilioLogger } from './utils/logger.js';
import { ConversationAgent } from './conversation-agent.js';
import { Server } from 'http';
import { AudioChunk, ErrorEvent } from './types/index.js';

class TwilioStreamConnectionHandler {
    private ws: WebSocket;
    private logger: TwilioLogger;
    private streamSid: string | undefined;
    private callSid: string | undefined;
    private onClose: (ws: WebSocket) => void;
    private onError: (ws: WebSocket, error: Error) => void;
    private activeAgents: Map<string, ConversationAgent>;
    private agent: ConversationAgent | undefined;

    constructor(config: {
        ws: WebSocket,
        onClose: (ws: WebSocket) => void,
        onError: (ws: WebSocket, error: Error) => void,
        activeAgents: Map<string, ConversationAgent>
    }) {
        this.ws = config.ws;
        this.logger = new TwilioLogger();
        this.onClose = config.onClose;
        this.onError = config.onError;
        this.activeAgents = config.activeAgents;
        this.setupWebhookEventHandlers();
    }

    private setupWebhookEventHandlers() {
        this.ws.on('message', this.handleTwilioMessage.bind(this));
        this.ws.on('close', this.handleClose.bind(this));
        this.ws.on('error', this.handleError.bind(this));
    }

    private handleClose() {
        this.logger.info('[TwilioStreamConnectionHandler] Twilio WebSocket connection closed');
        this.onClose(this.ws);
    }

    private handleError(error: Error) {
        this.logger.error('[TwilioStreamConnectionHandler] Twilio WebSocket error', error);
        this.onError(this.ws, error);
    }

    private async handleTwilioMessage(message: Buffer) {
        try {
            const msg = JSON.parse(message.toString());
            this.logger.setStreamId(msg.streamSid);
            this.logger.debug(`Received Twilio message ${msg.event}`);

            // Handle the start message to get streamSid
            if (msg.event === 'start') {
                this.logger.info('[TwilioStreamConnectionHandler] Received start message');

                this.callSid = msg.start.callSid;
                this.streamSid = msg.streamSid;

                //const prompt = Buffer.from(msg.start.customParameters.prompt, 'base64').toString();
                if (!this.streamSid) {
                    throw new Error('No streamSid provided in start message');
                }

                if (!this.callSid) {
                    throw new Error('No callSid provided in start message');
                }

                // Create new conversation agent for this stream
                this.agent = this.activeAgents.get(this.callSid);
                if (!this.agent) {
                    throw new Error('No agent found for streamSid');
                }

                this.agent.setStreamId(this.streamSid);
                // Set up audio output handler
                this.agent.onOutgoingAudio(this.onAgentOutgoingAudio.bind(this));
                this.agent.onResponseDone(this.onAgentResponseDone.bind(this));
                this.agent.onError(this.onAgentError.bind(this));
                this.agent.onStopped(this.onAgentStopped.bind(this));
            }

            // Handle media messages
            else if (msg.event === 'media' && this.streamSid && msg.media) {
                this.logger.debug('[TwilioStreamConnectionHandler] Received media message');
                if (this.agent) {
                    const audioChunk = {
                        data: Buffer.from(msg.media.payload, 'base64'),
                        streamSid: this.streamSid
                    };
                    this.agent.handleIncomingAudio(audioChunk);
                }
            }

            // Handle stop message
            else if (msg.event === 'stop' && this.streamSid) {
                this.logger.info('[TwilioStreamConnectionHandler] Received stop message');
                await this.cleanup();
            }
        } catch (error: any) {
            this.logger.error('[TwilioStreamConnectionHandler] Error processing WebSocket message', error);
            await this.cleanup();
        }
    }

    public async cleanup() {
        this.logger.info('[TwilioStreamConnectionHandler] Session cleaned up');
        if (this.agent) {
            await this.agent.stop();
        }
    }

    private onAgentOutgoingAudio(audioChunk: AudioChunk) {
        if (this.ws.readyState === this.ws.OPEN) {
            //log.info('Converting audio to 8kHz mulaw format', { streamId: audioChunk.streamSid });
            //const convertedAudio = AudioConverter.convertPCM24kTo8kMulaw(audioChunk.data);

            this.logger.debug('[TwilioStreamConnectionHandler] Sending audio chunk to Twilio');
            const response = {
                event: 'media',
                streamSid: audioChunk.streamSid,
                media: {
                    payload: audioChunk.data.toString('base64')
                }
            };
            this.ws.send(JSON.stringify(response));
        }
    }

    private onAgentResponseDone() {
        this.logger.info('[TwilioStreamConnectionHandler] Response done');
        const markResponse = {
            event: 'mark',
            streamSid: this.streamSid,
            mark: { name: 'responsePart' }
        }
        this.ws.send(JSON.stringify(markResponse));
    }

    private onAgentError(error: ErrorEvent) {
        this.logger.error('[TwilioStreamConnectionHandler] Error in conversation agent', error.error);
        this.onError(this.ws, error.error);
    }

    private onAgentStopped(streamId: string) {
        this.logger.info('[TwilioStreamConnectionHandler] Conversation stopped');
        this.ws.close();
    }
}

export class TwilioStreamWebSocketServer {
    private wss: WebSocketServer;
    private logger: TwilioLogger;
    private activeConnections: TwilioStreamConnectionHandler[];
    private activeAgents: Map<string, ConversationAgent>;
    
    constructor(server: Server, activeAgents: Map<string, ConversationAgent>) {
        this.wss = new WebSocketServer({ server, path: '/media-stream/outbound' });
        this.logger = new TwilioLogger();
        this.activeConnections = [];
        this.activeAgents = activeAgents;
    }

    public start() {
        this.wss.on('connection', this.handleConnection.bind(this));
    }

    private handleConnection(ws: WebSocket, req: Request) {
        this.logger.info('[TwilioStreamWebSocketServer] Twilio WebSocket connection established');
        const handler = new TwilioStreamConnectionHandler({
            ws: ws,
            onClose: this.handleClose.bind(this),
            onError: this.handleError.bind(this),
            activeAgents: this.activeAgents
        });
        this.activeConnections.push(handler);
    }

    private handleClose(ws: WebSocket) {
        this.logger.debug('[TwilioStreamWebSocketServer] Removing active connection');
        this.activeConnections = this.activeConnections.filter(handler => ws !== ws);
    }

    private handleError(ws: WebSocket, error: Error) {
        this.logger.error('[TwilioStreamWebSocketServer] Twilio WebSocket error', error);
        this.activeConnections = this.activeConnections.filter(handler => ws !== ws);
    }

    public cleanupActiveSessions() {
        this.activeConnections.forEach(handler => handler.cleanup());
    }
}
