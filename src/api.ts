import express from 'express';
import { createServer } from 'http';
import { config } from 'dotenv';
import { ConversationAgent } from './conversation-agent.js';
import { log } from './utils/logger.js';
import { TwilioStreamWebSocketServer } from './twilio_webhook_handler.js';
import { OutboundCallQueueHandler } from './queue_handler.js';

// router.post('/outbound-call', async (req: Request, res: Response): Promise<void> => {
//     try {
//         const { prompt, to_phone_number } = req.body;

//         if (!prompt || !to_phone_number) {
//             log.warn('Missing required parameters in outbound call request');
//             res.status(400).json({ error: 'Missing required parameters' });
//             return
//         }

//         const agent = new ConversationAgent({
//             mode: AGENT_MODE.STS,
//             instructions: prompt
//         });
//         await agent.start();

//         // Create TwiML for WebSocket streaming
//         const fqdn = process.env.FQDN;
//         const streamUrl = `wss://${fqdn}/media-stream/outbound`;

//         // <Parameter name="prompt" value="${Buffer.from(prompt).toString('base64')}" />
//         const twiml = `<?xml version="1.0" encoding="UTF-8"?>
//             <Response>
//                 <Connect>
//                     <Stream url="${streamUrl}"></Stream>
//                 </Connect>
//             </Response>`;

//         // Initiate outbound call with TwiML
//         const call = await twilioClient.calls.create({
//             record: true,
//             to: to_phone_number,
//             from: process.env.TWILIO_PHONE_NUMBER as string,
//             //statusCallback: `https://${fqdn}/twilio/voice/status`,
//             twiml: twiml
//         });

//         const callSid = call.sid;
//         logger.setCallSid(callSid);
//         agent.setCallSid(callSid);

//         activeSessions.set(callSid, agent);

//         logger.info('Outbound call initiated successfully');
//         res.json({
//             success: true,
//             callSid: call.sid
//         });
//         return
//     } catch (error: any) {
//         logger.error('Failed to initiate outbound call', error);
//         res.status(500).json({
//             error: 'Failed to initiate call',
//             details: error.message
//         });
//         return
//     }
// });

function main() {
    log.info('Starting Fine Voicing Queue Handler and Twilio WebSocket Server');
    // Load environment variables
    config({ override: true });

    const app = express();
    const router = express.Router();
    const server = createServer(app);

    // Middleware
    app.use(express.json());
    app.use('/', router);

    // Session management
    const activeAgents = new Map<string, ConversationAgent>();

    const twilioStreamWebSocketServer = new TwilioStreamWebSocketServer(server, activeAgents);
    twilioStreamWebSocketServer.start();

    const queueHandler = new OutboundCallQueueHandler(activeAgents);
    queueHandler.start();

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        log.info('Received SIGINT signal');
        queueHandler.cleanupActiveSessions();
        twilioStreamWebSocketServer.cleanupActiveSessions();
        log.info('Active sessions cleaned up, API continues running');
    });

    process.on('SIGTERM', () => {
        log.info('Received SIGTERM signal');
        queueHandler.cleanupActiveSessions();
        twilioStreamWebSocketServer.cleanupActiveSessions();
        log.info('Active sessions cleaned up, API continues running');
    });

    //Start the server
    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => {
        log.info(`Server is running on port ${PORT}`);
    });
}

main();