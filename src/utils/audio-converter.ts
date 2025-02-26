export class AudioConverter {
  static pcmToMulaw(pcmSample: number): number {
    const BIAS = 0x84;
    const CLIP = 32635;
    const exp_lut = [
      0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3,
      4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
      5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
      5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
      7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7
    ];

    let sign = (pcmSample >> 8) & 0x80;
    if (sign) pcmSample = -pcmSample;
    if (pcmSample > CLIP) pcmSample = CLIP;
    
    pcmSample = (pcmSample + BIAS) >> 2;
    let exponent = exp_lut[(pcmSample >> 6) & 0xFF];
    let mantissa = (pcmSample >> (exponent ?? 0 + 3)) & 0x0F;
    let ulawByte = ~(sign | ((exponent ?? 0) << 4) | mantissa);
    
    return ulawByte & 0xFF;
  }

  static mulawToPcm(mulawSample: number): number {
    const BIAS = 0x84;
    const SIGN_BIT = 0x80;
    const QUANT_MASK = 0xf;
    const SEG_SHIFT = 4;
    const SEG_MASK = 0x70;
    
    mulawSample = ~mulawSample;
    let sign = (mulawSample & SIGN_BIT) ? -1 : 1;
    let segment = (mulawSample & SEG_MASK) >> SEG_SHIFT;
    let quantization = mulawSample & QUANT_MASK;
    let magnitude = (quantization << 3) + BIAS;
    
    magnitude <<= segment;
    return sign * (magnitude - BIAS);
  }

  static convertBuffer(buffer: Buffer, converter: (sample: number) => number): Buffer {
    const result = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      result[i] = converter(buffer[i] ?? 0);
    }
    return result;
  }

  static convertPCM8kToMulaw(inputBuffer: Buffer): Buffer {
    // Handle undefined or null input
    if (!inputBuffer) {
      return Buffer.alloc(0);
    }

    // Convert 16-bit PCM at 8kHz to μ-law
    // Each PCM sample is 2 bytes (16-bit)
    const sampleCount = Math.floor(inputBuffer.length / 2);
    const mulawBuffer = Buffer.alloc(sampleCount);
    
    // Process only complete 16-bit samples
    for (let i = 0; i < sampleCount; i++) {
      if ((i * 2) + 1 < inputBuffer.length) {
        const sample = inputBuffer.readInt16LE(i * 2);
        mulawBuffer[i] = this.pcmToMulaw(sample);
      }
    }
    
    return mulawBuffer;
  }

  static convertMulawToPCM8k(inputBuffer: Buffer): Buffer {
    // Handle undefined or null input
    if (!inputBuffer) {
      return Buffer.alloc(0);
    }
    
    // Convert μ-law to 16-bit PCM at 8kHz
    // Each μ-law sample is 1 byte, each PCM sample will be 2 bytes
    const pcmBuffer = Buffer.alloc(inputBuffer.length * 2);
    
    for (let i = 0; i < inputBuffer.length; i++) {
      const pcmSample = this.mulawToPcm(inputBuffer[i] ?? 0);
      pcmBuffer.writeInt16LE(pcmSample, i * 2);
    }
    
    return pcmBuffer;
  }

  static convertPCM24kTo8kMulaw(inputBuffer: Buffer): Buffer {
    const downsamplingFactor = 3; // 24000 / 8000 = 3
    const samplesCount = Math.floor(inputBuffer.length / 2); // 16-bit = 2 bytes per sample
    const downsampledLength = Math.floor(samplesCount / downsamplingFactor) * 2;
    const downsampledBuffer = Buffer.alloc(downsampledLength);

    // Simple moving average filter window size (should be odd)
    const filterSize = 5;
    const halfFilterSize = Math.floor(filterSize / 2);

    // Process each output sample (16-bit)
    for (let i = 0; i < downsampledLength / 2; i++) {
      const inputIndex = i * downsamplingFactor * 2;
      let sum = 0;
      let count = 0;

      // Apply moving average filter around the sample
      for (let j = -halfFilterSize; j <= halfFilterSize; j++) {
        const sampleIndex = inputIndex + (j * 2);
        if (sampleIndex >= 0 && sampleIndex < inputBuffer.length - 1) {
          sum += inputBuffer.readInt16LE(sampleIndex);
          count++;
        }
      }

      // Calculate filtered sample
      const filteredSample = Math.round(sum / count);
      
      // Apply a slight gain to compensate for the filtering
      const gainCompensation = 1.2;
      const compensatedSample = Math.min(32767, Math.max(-32768, Math.round(filteredSample * gainCompensation)));
      
      downsampledBuffer.writeInt16LE(compensatedSample, i * 2);
    }

    // Convert downsampled PCM to mulaw
    const mulawBuffer = Buffer.alloc(downsampledLength / 2);
    for (let i = 0; i < downsampledLength / 2; i++) {
      const sample = downsampledBuffer.readInt16LE(i * 2);
      mulawBuffer[i] = this.pcmToMulaw(sample);
    }

    return mulawBuffer;
  }

  static convert8kMulawToPCM24k(inputBuffer: Buffer): Buffer {
    // First convert mulaw to PCM
    const pcm8kBuffer = Buffer.alloc(inputBuffer.length * 2); // 16-bit PCM samples
    for (let i = 0; i < inputBuffer.length; i++) {
      const pcmSample = this.mulawToPcm(inputBuffer[i] ?? 0);
      pcm8kBuffer.writeInt16LE(pcmSample, i * 2);
    }

    // Upsample from 8kHz to 24kHz using linear interpolation
    const upsamplingFactor = 3; // 24000 / 8000 = 3
    const outputBuffer = Buffer.alloc(pcm8kBuffer.length * upsamplingFactor);

    for (let i = 0; i < pcm8kBuffer.length / 2 - 1; i++) {
      const currentSample = pcm8kBuffer.readInt16LE(i * 2);
      const nextSample = pcm8kBuffer.readInt16LE((i + 1) * 2);
      
      // Write the current sample and two interpolated samples
      outputBuffer.writeInt16LE(currentSample, i * 6);
      
      // Calculate and write two interpolated samples
      const step = (nextSample - currentSample) / 3;
      const interpolatedSample1 = Math.round(currentSample + step);
      const interpolatedSample2 = Math.round(currentSample + 2 * step);
      
      outputBuffer.writeInt16LE(interpolatedSample1, i * 6 + 2);
      outputBuffer.writeInt16LE(interpolatedSample2, i * 6 + 4);
    }

    // Handle the last sample - repeat it for the remaining positions
    const lastIndex = Math.floor(pcm8kBuffer.length / 2) - 1;
    const lastSample = pcm8kBuffer.readInt16LE(lastIndex * 2);
    const lastPosition = lastIndex * 6;
    
    // Write the last sample and its interpolated copies
    outputBuffer.writeInt16LE(lastSample, lastPosition);
    outputBuffer.writeInt16LE(lastSample, lastPosition + 2);
    outputBuffer.writeInt16LE(lastSample, lastPosition + 4);

    return outputBuffer;
  }
} 