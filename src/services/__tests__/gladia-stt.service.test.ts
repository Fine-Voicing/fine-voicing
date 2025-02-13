import { describe, test, expect, beforeEach, vi } from 'vitest';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { GladiaSTTService } from '../gladia-stt.service';

vi.mock('ws');

describe('GladiaSTTService', () => {
  let service: GladiaSTTService;
  let eventBus: EventEmitter;
  let mockWs: any;

  beforeEach(() => {
    eventBus = new EventEmitter();
    mockWs = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };
    (WebSocket as any).mockImplementation(() => mockWs);
    
    service = new GladiaSTTService('test-api-key', eventBus);
  });

  test('connects and sends start message', async () => {
    await service.connect('test-stream');

    expect(mockWs.on).toHaveBeenCalledWith('open', expect.any(Function));
    
    // Simulate websocket open
    const openHandler = mockWs.on.mock.calls.find(call => call[0] === 'open')[1];
    openHandler();

    expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('start'));
  });

  test('handles transcription messages', async () => {
    const transcriptionSpy = vi.fn();
    eventBus.on('transcription-chunk', transcriptionSpy);

    await service.connect('test-stream');

    // Get message handler
    const messageHandler = mockWs.on.mock.calls.find(call => call[0] === 'message')[1];
    
    messageHandler(JSON.stringify({
      type: 'transcription',
      text: 'test transcription'
    }));

    expect(transcriptionSpy).toHaveBeenCalledWith({
      text: 'test transcription',
      streamSid: 'test-stream'
    });
  });
}); 