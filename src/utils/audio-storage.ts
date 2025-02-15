import { createClient } from '@supabase/supabase-js';
import { TwilioLogger } from './logger.js';
import { join } from 'path';
import fs from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const AUDIO_RECORDINGS_BUCKET = 'audio_recordings';

export async function writeWavFile(toPhoneNumber: string, audioChunks: Buffer): Promise<string | null> {
    const logger = new TwilioLogger();
    
    const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_KEY!
    );

    // Configure WAV parameters for mu-law 8kHz
    const channels = 1; // mono
    const sampleWidth = 1; // 1 byte for mu-law
    const frameRate = 8000; // 8kHz
    const audioFormat = 7; // 7 is the format code for mu-law

    // Create WAV header
    const dataSize = audioChunks.length;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;
    
    const header = Buffer.alloc(headerSize);
    
    // RIFF identifier
    header.write('RIFF', 0);
    // file length
    header.writeUInt32LE(36 + dataSize, 4);
    // RIFF type
    header.write('WAVE', 8);
    // format chunk identifier
    header.write('fmt ', 12);
    // format chunk length
    header.writeUInt32LE(16, 16);
    // sample format (mu-law = 7)
    header.writeUInt16LE(audioFormat, 20);
    // channel count
    header.writeUInt16LE(channels, 22);
    // sample rate
    header.writeUInt32LE(frameRate, 24);
    // byte rate (sample rate * block align)
    header.writeUInt32LE(frameRate * channels * sampleWidth, 28);
    // block align (channel count * bytes per sample)
    header.writeUInt16LE(channels * sampleWidth, 32);
    // bits per sample
    header.writeUInt16LE(sampleWidth * 8, 34);
    // data chunk identifier
    header.write('data', 36);
    // data chunk length
    header.writeUInt32LE(dataSize, 40);

    // Create temporary file
    const tempDir = tmpdir();
    const tempFilePath = join(tempDir, `${randomUUID()}.wav`);

    try {
        // Write header
        fs.writeFileSync(tempFilePath, header);

        // Append audio data
        fs.appendFileSync(tempFilePath, audioChunks);

        // Upload to Supabase
        const fileName = `${toPhoneNumber}_${new Date().toISOString().replace(/[:.]/g, '')}.wav`;
        
        const { data: uploadData, error: uploadError } = await supabase.storage
            .from(AUDIO_RECORDINGS_BUCKET)
            .upload(fileName, fs.readFileSync(tempFilePath), {
                contentType: 'audio/wav',
                cacheControl: '3600'
            });

        if (uploadError) {
            logger.error(`Error uploading file to Supabase: ${uploadError.message}`);
            return null;
        }

        // Create signed URL
        const { data: urlData, error: urlError } = await supabase.storage
            .from(AUDIO_RECORDINGS_BUCKET)
            .createSignedUrl(fileName, 60 * 60 * 24 * 7); // 7 days

        if (urlError) {
            logger.error(`Error creating signed URL: ${urlError.message}`);
            return null;
        }

        return urlData.signedUrl;
    } catch (error: any) {
        logger.error(`Error writing WAV file: ${error.message}`);
        return null;
    } finally {
        // Clean up temporary file
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch (error: any) {
            logger.error(`Error cleaning up temporary file: ${error.message}`);
        }
    }
} 