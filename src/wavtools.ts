import fs from 'fs';

// Function to create a WAV file from PCM data
function createWavFile(pcmData: Buffer, sampleRate: number) {
    const buffer = new ArrayBuffer(44 + pcmData.length * 2);
    const view = new DataView(buffer);

    // RIFF identifier
    writeString(view, 0, 'RIFF');
    // file length
    view.setUint32(4, 36 + pcmData.length * 2, true);
    // RIFF type
    writeString(view, 8, 'WAVE');
    // format chunk identifier
    writeString(view, 12, 'fmt ');
    // format chunk length
    view.setUint32(16, 16, true);
    // sample format (raw)
    view.setUint16(20, 1, true);
    // channel count
    view.setUint16(22, 1, true);
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (sample rate * block align)
    view.setUint32(28, sampleRate * 2, true); // 16-bit PCM
    // block align (channel count * bytes per sample)
    view.setUint16(32, 2, true); // 16 bits
    // bits per sample
    view.setUint16(34, 16, true); // 16 bits
    // data chunk identifier
    writeString(view, 36, 'data');
    // data chunk length
    view.setUint32(40, pcmData.length * 2, true);

    // Write the PCM samples
    for (let i = 0; i < pcmData.length; i++) {
        view.setInt16(44 + i * 2, pcmData[i], true);
    }

    return Buffer.from(buffer);
}

// Helper function to write string to DataView
function writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

export function saveWavFile(pcmData: Buffer, sampleRate: number, filename: string) {
    const wavBuffer = createWavFile(pcmData, sampleRate);
    fs.writeFileSync(filename, wavBuffer);
}

export default { createWavFile, saveWavFile };