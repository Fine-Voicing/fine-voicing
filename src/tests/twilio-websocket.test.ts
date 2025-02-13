import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import Speaker from 'speaker';
import mulaw from 'mu-law';


// Load environment variables
config({ override: true });

describe('Twilio WebSocket Integration', () => {
  let wsClient: WebSocket;
  let testAudioData: Buffer;
  const port = process.env.PORT || 3000;

  const SANDRA_REALESTATE_SYSTEM_MESSAGE_INBOUND = `You are working at real-estate agency and you are attending calls from people interested in renting a property. 
  You are to help the agency to collect informations about the caller to be later processed by a human working at the agency.
  Be very polite and professional, and greet the caller.
  Crucial informations are:
  - Name
  - Property of interest. Most of the time listing have a reference number, like "Referência do anúncio 2052".
  - Available dates for a visit
  - Move in date/period. For instance, in the next 2 weeks, or in the next month, etc.
  Ask informations one by one, and wait for the caller response before asking for the next one. If you didn't understand the caller response, ask again the same information.
  Upon first words from the caller, you will ask them for their name and ask how you can help them.
  Answer in Portuguese from Portugal (not Brazilian). As soon as you identified the proper language, switch to that language.
  If the caller try to steer the conversation away from the goal, you will terminate the call after notifying the caller.
  Once you've collected all the information, you will notify the caller that you're going to transfer the information to the human agent who will call them back. From there terminate the conversation.
  `;

  const SANDRA_DEALERSHIP_SYSTEM_MESSAGE_INBOUND = `Hello, I’m Sandra, your AI assistant for the dealership. I’m here to assist with a variety of tasks, including:
Scheduling appointments: Whether it's for a test drive, service appointment, or consultation, I can find a time that works for you.
Lead capture: I’ll gather your information and ensure you’re connected with the right person to move forward with your purchase or service.
Answering questions: I can provide details about our inventory, pricing, and promotions, and help you with any other general inquiries.
Follow-ups: If you’ve made an inquiry or started a process, I can check in and make sure everything is on track.
If your request falls outside my scope, I’ll direct you to one of our team members. How can I assist you today? In this demo, the customer is named Maxwell`;

const SANDRA_DEALERSHIP_PHONE_NUMBER = '+12025686833';

    beforeEach(async () => {
    // Load test audio file
    testAudioData = fs.readFileSync(path.join(__dirname, 'data', 'twilio-16-8k-mulaw.wav'));
  });

  afterEach(async () => {
    if (wsClient) {
      wsClient.close();
    }
  });

  test('handles complete Twilio WebSocket flow', async () => {``
    return new Promise<void>((resolve, reject) => {
      // Create speaker instance
      const speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: 8000
      });

      // Connect to WebSocket server using the real server endpoint
      wsClient = new WebSocket(`ws://localhost:${port}/media-stream/outbound`);

      wsClient.on('open', () => {
        // Send start event
        log.info('Test: Sending start event');
        const startEvent = {
          event: 'start',
          streamSid: 'test-stream-123',
          start: {
            mediaFormat: {
              encoding: 'mulaw',
              sampleRate: 8000,
              channels: 1
            },
            customParameters: {
              prompt: Buffer.from(SANDRA_REALESTATE_SYSTEM_MESSAGE_INBOUND).toString('base64')
            }
          }
        };
        wsClient.send(JSON.stringify(startEvent));

        // Send media event with real audio data
        log.info('Test: Sending media event');
        const mediaEvent = {
          event: 'media',
          streamSid: 'test-stream-123',
          media: {
            payload: testAudioData.toString('base64')
          }
        };
        wsClient.send(JSON.stringify(mediaEvent));

        // Send stop event after a short delay
        // setTimeout(() => {
        //   log.info('Test: Sending stop event');
        //   const stopEvent = {
        //     event: 'stop',
        //     streamSid: 'test-stream-123'
        //   };
        //   wsClient.send(JSON.stringify(stopEvent));
        // }, 5000); // Increased timeout to allow for real service responses
      });

      // Handle server responses
      let mediaResponseCount = 0;
      let markResponseCount = 0;
      wsClient.on('message', (data: Buffer) => {
        const response = JSON.parse(data.toString());
        log.debug(`Received response: ${JSON.stringify(response, null, 2)}`);
        
        if (response.event === 'media') {
          expect(response.streamSid).toBe('test-stream-123');
          expect(response.media.payload).toBeDefined();
          
          // Decode base64 audio and convert from µ-law to PCM
          const audioBuffer = Buffer.from(response.media.payload, 'base64');
          
          // Convert each µ-law byte to PCM
          const decodedAudio = new Int16Array(audioBuffer.length);
          for (let i = 0; i < audioBuffer.length; i++) {
            decodedAudio[i] = mulaw.decode(audioBuffer[i]);
          }
          
          // Convert to buffer for speaker
          const pcmBuffer = Buffer.from(decodedAudio.buffer);
          speaker.write(pcmBuffer);
          
          mediaResponseCount++;
        } else if (response.event === 'mark') {
          expect(response.streamSid).toBe('test-stream-123');
          expect(response.mark.name).toBe('responsePart');
          markResponseCount++;
          speaker.end();
        }
        
        // Resolve when we've received at least one media and one mark response
        if (mediaResponseCount >= 1 && markResponseCount >= 1) {
          resolve();
        }
      });

      wsClient.on('error', reject);
    });
  }, 30000);

  test('Twilio e2e test - Sandra Real Estate', async () => {
    const toPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
    const response = await fetch(`http://localhost:${port}/outbound-call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: SANDRA_REALESTATE_SYSTEM_MESSAGE_INBOUND, to_phone_number: toPhoneNumber })
    });

    if (!response.ok) {
      throw new Error('Failed to initiate outbound call');
    }

    const data = await response.json();
    
    log.info('Outbound call initiated successfully', { streamId: data.callSid });
  }, 10000);

  test.only('Twilio e2e test - Sandra Dealership', async () => {
    const response = await fetch(`http://localhost:${port}/outbound-call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt: SANDRA_DEALERSHIP_SYSTEM_MESSAGE_INBOUND, to_phone_number: SANDRA_DEALERSHIP_PHONE_NUMBER })
    });

    if (!response.ok) {
      throw new Error('Failed to initiate outbound call');
    }

    const data = await response.json();
    
    log.info('Outbound call initiated successfully', { streamId: data.callSid });
  }, 10000);
}); 