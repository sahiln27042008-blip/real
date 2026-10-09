/**
 * High-performance client-side WAV merger, Canonical RIFF Header Normalizer,
 * Velvet Sleep Acoustic Softener DSP, and Fractional Resampling Speed Controller.
 */

export type AcousticWarmthMode = 'velvet' | 'deep_warmth' | 'natural';

export function base64ToUint8Array(b64: string): Uint8Array {
  const cleanB64 = b64.replace(/^data:audio\/\w+;base64,/, '').trim();
  const binaryString = atob(cleanB64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary);
}

/**
 * Builds a canonical 44-byte 24,000 Hz, 16-bit, Mono RIFF WAVE header for a given PCM byte length.
 */
export function createCanonicalWavHeader(pcmByteLength: number, sampleRate: number = 24000): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  // "RIFF"
  header[0] = 0x52;
  header[1] = 0x49;
  header[2] = 0x46;
  header[3] = 0x46;
  // File size - 8
  view.setUint32(4, 36 + pcmByteLength, true);
  // "WAVE"
  header[8] = 0x57;
  header[9] = 0x41;
  header[10] = 0x56;
  header[11] = 0x45;
  // "fmt "
  header[12] = 0x66;
  header[13] = 0x6d;
  header[14] = 0x74;
  header[15] = 0x20;
  // Subchunk1Size (16 for PCM)
  view.setUint32(16, 16, true);
  // AudioFormat (1 = PCM)
  view.setUint16(20, 1, true);
  // NumChannels (1 = Mono)
  view.setUint16(22, 1, true);
  // SampleRate (24000 Hz)
  view.setUint32(24, sampleRate, true);
  // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint32(28, sampleRate * 2, true);
  // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true);
  // BitsPerSample (16)
  view.setUint16(34, 16, true);
  // "data"
  header[36] = 0x64;
  header[37] = 0x61;
  header[38] = 0x74;
  header[39] = 0x61;
  // Subchunk2Size (pcmByteLength)
  view.setUint32(40, pcmByteLength, true);

  return header;
}

/**
 * Extracts raw 16-bit signed PCM bytes from either a RIFF WAV buffer or a raw L16 PCM buffer.
 * Ensures 2-byte alignment so sample framing never shifts.
 */
export function extractRawPcmBytes(rawBytes: Uint8Array): Uint8Array {
  if (rawBytes.length <= 44) return new Uint8Array(0);

  // Check if starts with "RIFF" (0x52, 0x49, 0x46, 0x46)
  const isRiff =
    rawBytes[0] === 0x52 &&
    rawBytes[1] === 0x49 &&
    rawBytes[2] === 0x46 &&
    rawBytes[3] === 0x46;

  let pcmSlice: Uint8Array;
  if (isRiff) {
    // Search for "data" chunk marker (0x64, 0x61, 0x74, 0x61) within first 256 bytes
    let dataOffset = 44;
    const searchLimit = Math.min(rawBytes.length - 8, 256);
    for (let i = 12; i < searchLimit; i++) {
      if (
        rawBytes[i] === 0x64 &&
        rawBytes[i + 1] === 0x61 &&
        rawBytes[i + 2] === 0x74 &&
        rawBytes[i + 3] === 0x61
      ) {
        dataOffset = i + 8;
        break;
      }
    }
    pcmSlice = rawBytes.subarray(dataOffset);
  } else {
    // Raw 16-bit PCM returned directly by Gemini TTS
    pcmSlice = rawBytes;
  }

  // Ensure even byte length for 16-bit samples
  const evenLen = pcmSlice.length - (pcmSlice.length % 2);
  return pcmSlice.subarray(0, evenLen);
}

/**
 * Normalizes any base64 audio from TTS into a valid 44-byte RIFF WAV base64 string (unfiltered).
 */
export function normalizeRawTtsToCanonicalWavBase64(b64: string): string {
  const rawBytes = base64ToUint8Array(b64);
  const pcmBytes = extractRawPcmBytes(rawBytes);
  const header = createCanonicalWavHeader(pcmBytes.length, 24000);
  const wav = new Uint8Array(44 + pcmBytes.length);
  wav.set(header, 0);
  wav.set(pcmBytes, 44);
  return uint8ArrayToBase64(wav);
}

/**
 * Softens and speed-adjusts a single 24kHz 16-bit Mono WAV file (applied ONCE from clean source)
 * so individual clips are warm, unsharp, peaceful, and paced at the exact target speed (e.g., 0.96x).
 */
export function softenSingleWavBase64(
  b64: string,
  warmthMode: AcousticWarmthMode = 'velvet',
  speedFactor: number = 0.96
): {
  audioBase64: string;
  audioBytes: Uint8Array;
  blob: Blob;
  blobUrl: string;
} {
  const rawBytes = base64ToUint8Array(b64);
  const pcmBytes = extractRawPcmBytes(rawBytes);
  const clampedSpeed = Math.max(0.8, Math.min(1.25, Number(speedFactor) || 0.96));

  if (pcmBytes.length === 0) {
    const emptyWav = createCanonicalWavHeader(0, 24000);
    const blob = new Blob([emptyWav.buffer as ArrayBuffer], { type: 'audio/wav' });
    return {
      audioBase64: uint8ArrayToBase64(emptyWav),
      audioBytes: emptyWav,
      blob,
      blobUrl: URL.createObjectURL(blob),
    };
  }

  const processedPcm =
    warmthMode === 'natural' && Math.abs(clampedSpeed - 1.0) < 0.005
      ? pcmBytes
      : applyVelvetSleepDspToPcm(pcmBytes, warmthMode, clampedSpeed);

  const header = createCanonicalWavHeader(processedPcm.length, 24000);
  const outWav = new Uint8Array(44 + processedPcm.length);
  outWav.set(header, 0);
  outWav.set(processedPcm, 44);

  const outB64 = uint8ArrayToBase64(outWav);
  const blob = new Blob([outWav.buffer as ArrayBuffer], { type: 'audio/wav' });

  return {
    audioBase64: outB64,
    audioBytes: outWav,
    blob,
    blobUrl: URL.createObjectURL(blob),
  };
}

/**
 * Processes 16-bit Little-Endian PCM audio:
 * 1. Fractional linear interpolation resampling for smooth speed adjustment (0.80x to 1.25x, default 0.96x)
 * 2. 2-pole warm low-pass filter (removes high-frequency ear fatigue & metallic TTS edge)
 * 3. Soft-knee dynamic leveling
 * 4. Smooth cosine fade-in (150ms) and fade-out (220ms) so clip starts/ends never pop
 */
function applyVelvetSleepDspToPcm(
  pcmBytes: Uint8Array,
  mode: AcousticWarmthMode,
  speedFactor: number = 0.96
): Uint8Array {
  const inSampleCount = Math.floor(pcmBytes.length / 2);
  if (inSampleCount <= 2) return pcmBytes;

  const clampedSpeed = Math.max(0.8, Math.min(1.25, Number(speedFactor) || 0.96));
  const outSampleCount = Math.max(2, Math.floor(inSampleCount / clampedSpeed));

  const outBytes = new Uint8Array(outSampleCount * 2);
  const inView = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, inSampleCount * 2);
  const outView = new DataView(outBytes.buffer, outBytes.byteOffset, outSampleCount * 2);

  // Filter coefficient alpha for 24,000 Hz sample rate:
  // 'velvet': cutoff ~3.1 kHz (alpha ~0.46) -> removes sharp sibilance while keeping voice clear and warm
  // 'deep_warmth': cutoff ~2.1 kHz (alpha ~0.34) -> ultra-soft, dark, muffled nocturnal bedtime warmth
  // 'natural': alpha = 1.0 (no low-pass filtering)
  const alpha = mode === 'deep_warmth' ? 0.34 : mode === 'velvet' ? 0.46 : 1.0;
  const gain = mode === 'deep_warmth' ? 0.84 : mode === 'velvet' ? 0.88 : 0.95;

  let lp1 = 0;
  let lp2 = 0;

  // 24kHz sample rate: 150ms fade-in = 3600 samples, 220ms fade-out = 5280 samples
  const fadeInSamples = Math.min(3600, Math.floor(outSampleCount * 0.05));
  const fadeOutSamples = Math.min(5280, Math.floor(outSampleCount * 0.08));

  for (let i = 0; i < outSampleCount; i++) {
    // Fractional source position for speed adjustment
    const srcPos = i * clampedSpeed;
    const idx0 = Math.min(inSampleCount - 1, Math.floor(srcPos));
    const idx1 = Math.min(inSampleCount - 1, idx0 + 1);
    const frac = srcPos - idx0;

    const s0 = inView.getInt16(idx0 * 2, true) / 32768.0;
    const s1 = inView.getInt16(idx1 * 2, true) / 32768.0;
    const rawSample = s0 + frac * (s1 - s0);

    let warmSample: number;
    if (mode === 'natural') {
      warmSample = rawSample * gain;
    } else {
      // Cascaded 2-pole exponential smoothing (zero-resonance warm roll-off of sharp treble)
      lp1 = lp1 + alpha * (rawSample - lp1);
      lp2 = lp2 + alpha * (lp1 - lp2);
      warmSample = (0.8 * lp2 + 0.2 * lp1) * gain;
      // Soft-knee saturation (prevents any sudden sharp peak from hurting sleepy ears)
      warmSample = warmSample / (1 + 0.35 * Math.abs(warmSample));
    }

    // Apply smooth cosine envelope at boundaries
    if (i < fadeInSamples) {
      const env = 0.5 * (1 - Math.cos((Math.PI * i) / fadeInSamples));
      warmSample *= env;
    } else if (i > outSampleCount - fadeOutSamples) {
      const rem = outSampleCount - i;
      const env = 0.5 * (1 - Math.cos((Math.PI * rem) / fadeOutSamples));
      warmSample *= env;
    }

    // Clamp & convert back to 16-bit PCM
    const clamped = Math.max(-0.98, Math.min(0.98, warmSample));
    outView.setInt16(i * 2, Math.round(clamped * 32767), true);
  }

  return outBytes;
}

export function mergeWavAudioChunks(
  base64Chunks: string[],
  warmthMode: AcousticWarmthMode = 'velvet',
  speedFactor: number = 0.96,
  pauseSeconds: number = 1.5
): {
  mergedBytes: Uint8Array;
  mergedBase64: string;
  blob: Blob;
  blobUrl: string;
} {
  const validPcms: Uint8Array[] = [];

  for (const b64 of base64Chunks) {
    if (!b64) continue;
    try {
      const bytes = base64ToUint8Array(b64);
      const rawPcm = extractRawPcmBytes(bytes);
      if (rawPcm.length > 0) {
        validPcms.push(rawPcm);
      }
    } catch (e) {
      console.warn('Skipping unparseable audio chunk:', e);
    }
  }

  if (validPcms.length === 0) {
    throw new Error('No valid audio data found in completed parts.');
  }

  const pcmList: Uint8Array[] = [];
  let totalPcmLength = 0;

  // Insert customizable silence gap (24000 Hz * 2 bytes/sample = 48000 bytes/sec) between segments
  const clampedPause = Math.max(0, Math.min(8, Number(pauseSeconds) || 0));
  const pauseByteLen = Math.floor(clampedPause * 24000) * 2;
  const interClipPauseBytes = new Uint8Array(pauseByteLen);

  for (let idx = 0; idx < validPcms.length; idx++) {
    const rawPcm = validPcms[idx];
    const processedPcm = applyVelvetSleepDspToPcm(rawPcm, warmthMode, speedFactor);

    pcmList.push(processedPcm);
    totalPcmLength += processedPcm.length;

    if (idx < validPcms.length - 1 && interClipPauseBytes.length > 0) {
      pcmList.push(interClipPauseBytes);
      totalPcmLength += interClipPauseBytes.length;
    }
  }

  const header = createCanonicalWavHeader(totalPcmLength, 24000);
  const merged = new Uint8Array(44 + totalPcmLength);
  merged.set(header, 0);

  let offset = 44;
  for (const pcm of pcmList) {
    merged.set(pcm, offset);
    offset += pcm.length;
  }

  const mergedBase64 = uint8ArrayToBase64(merged);
  const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'audio/wav' });
  const blobUrl = URL.createObjectURL(blob);

  return {
    mergedBytes: merged,
    mergedBase64,
    blob,
    blobUrl,
  };
}

/**
 * Splits a user-pasted script of any length into clean ~550–600 word segments along sentence boundaries
 * so users can paste their own script and convert it directly into audio clips + Master WAV.
 */
export function splitRawScriptInto550To600WordClips(
  rawScript: string
): { title: string; text: string; wordCount: number }[] {
  const cleaned = rawScript
    .replace(/\[\s*(?:pause|silence|breath)[^\]]*\]/gi, '... ...')
    .trim();
  if (!cleaned) return [];

  // Split by sentence/paragraph boundaries while preserving punctuation and ellipses
  const sentences = cleaned
    .split(/(?<=[.!?…])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  const clips: { title: string; text: string; wordCount: number }[] = [];
  let currentSentences: string[] = [];
  let currentWords = 0;

  for (const sentence of sentences) {
    const wCount = sentence.split(/\s+/).filter(Boolean).length;
    if (currentWords + wCount > 600 && currentWords >= 450) {
      const partIdx = clips.length + 1;
      const chunkText = currentSentences.join('\n\n');
      clips.push({
        title: `Direct Script Segment ${partIdx} (${currentWords} words)`,
        text: chunkText,
        wordCount: currentWords,
      });
      currentSentences = [sentence];
      currentWords = wCount;
    } else {
      currentSentences.push(sentence);
      currentWords += wCount;
    }
  }

  if (currentSentences.length > 0) {
    const partIdx = clips.length + 1;
    const chunkText = currentSentences.join('\n\n');
    clips.push({
      title: `Direct Script Segment ${partIdx} (${currentWords} words)`,
      text: chunkText,
      wordCount: currentWords,
    });
  }

  return clips;
}
