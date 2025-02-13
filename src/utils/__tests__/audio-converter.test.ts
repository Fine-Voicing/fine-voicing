import { describe, test, expect } from 'vitest';
import { AudioConverter } from '../audio-converter.js';

describe('AudioConverter', () => {
  test('converts PCM to mulaw and back', () => {
    const originalPcm = 1000;
    const mulaw = AudioConverter.pcmToMulaw(originalPcm);
    const pcm = AudioConverter.mulawToPcm(mulaw);
    
    // Allow for some loss in conversion
    expect(Math.abs(pcm - originalPcm)).toBeLessThan(100);
  });

  test('converts buffer of PCM to mulaw', () => {
    const pcmBuffer = Buffer.from([100, 200, 300]);
    const mulawBuffer = AudioConverter.convertBuffer(pcmBuffer, AudioConverter.pcmToMulaw);
    
    expect(mulawBuffer.length).toBe(pcmBuffer.length);
    expect(mulawBuffer).not.toEqual(pcmBuffer);
  });

  test('handles edge cases', () => {
    // Test silence
    expect(AudioConverter.pcmToMulaw(0)).toBeDefined();
    
    // Test maximum values
    expect(AudioConverter.pcmToMulaw(32767)).toBeDefined();
    expect(AudioConverter.pcmToMulaw(-32768)).toBeDefined();
  });
}); 