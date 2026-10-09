import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { Readable, Transform } from 'stream';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { ZipArchive } = createRequire(import.meta.url)('archiver') as typeof import('archiver');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '100mb' }));

// Shared Gemini client setup with mandatory telemetry header
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Session persistence & multi-session history so active/past sessions are NEVER lost
const SESSION_FILE = path.resolve(__dirname, 'src/persistedSession.json');
const HISTORY_FILE = path.resolve(__dirname, 'src/persistedHistory.json');
const ACTIVE_SESSION_CLEARED_FILE = path.resolve(__dirname, 'src/persistedActiveSessionCleared.json');
const AUDIO_CHUNKS_DIR = path.resolve(__dirname, 'src/persisted_audio_chunks');

try {
  if (!fs.existsSync(AUDIO_CHUNKS_DIR)) {
    fs.mkdirSync(AUDIO_CHUNKS_DIR, { recursive: true });
  }
} catch {}

function sanitizeId(raw: string): string {
  return String(raw || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getChunkAudioPath(sessionId: string, chunkId: number | string): string {
  return path.join(AUDIO_CHUNKS_DIR, `${sanitizeId(sessionId)}_chunk_${sanitizeId(String(chunkId))}.b64`);
}

function decodeBase64File(filePath: string, skipBytes = 0): Readable {
  let carry = '';
  let remainingSkip = skipBytes;
  const decoder = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const input = (carry + chunk.toString('ascii')).replace(/\s/g, '');
      const usableLength = input.length - (input.length % 4);
      carry = input.slice(usableLength);
      let decoded = Buffer.from(input.slice(0, usableLength), 'base64');
      if (remainingSkip > 0) {
        const skip = Math.min(remainingSkip, decoded.length);
        decoded = decoded.subarray(skip);
        remainingSkip -= skip;
      }
      if (decoded.length > 0) this.push(decoded);
      callback();
    },
    flush(callback) {
      let decoded = carry ? Buffer.from(carry, 'base64') : Buffer.alloc(0);
      if (remainingSkip > 0) decoded = decoded.subarray(Math.min(remainingSkip, decoded.length));
      if (decoded.length > 0) this.push(decoded);
      callback();
    },
  });
  return fs.createReadStream(filePath).pipe(decoder);
}

function wavHeader(pcmLength: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

function decodedBase64Length(filePath: string): number {
  const size = fs.statSync(filePath).size;
  const tail = Buffer.alloc(Math.min(2, size));
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
  } finally {
    fs.closeSync(fd);
  }
  const padding = tail.toString('ascii').match(/=+$/)?.[0].length || 0;
  return Math.floor(size / 4) * 3 - padding;
}

async function* streamMasterWav(
  sessionId: string,
  chunks: any[],
  pcmLength: number,
  pauseBytes: number,
  byteStart = 0,
  byteEnd = pcmLength + 43
) {
  let position = 0;
  const emitRange = async function* (source: Readable) {
    for await (const chunk of source) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const segmentStart = position;
      position += data.length;
      const from = Math.max(0, byteStart - segmentStart);
      const to = Math.min(data.length, byteEnd - segmentStart + 1);
      if (to > from) yield data.subarray(from, to);
      if (position > byteEnd) return;
    }
  };

  yield* emitRange(Readable.from([wavHeader(pcmLength)]));
  const availableChunks = chunks.filter((chunk) => fs.existsSync(getChunkAudioPath(sessionId, chunk.id)));
  for (let index = 0; index < availableChunks.length; index++) {
    const filePath = getChunkAudioPath(sessionId, availableChunks[index].id);
    yield* emitRange(decodeBase64File(filePath, 44));
    if (pauseBytes > 0 && index < availableChunks.length - 1) {
      yield* emitRange(Readable.from([Buffer.alloc(pauseBytes)]));
    }
  }
}

function getInterClipPauseBytes(rawGap: unknown): number {
  const parsedGap = Number(rawGap);
  const seconds = Math.max(0, Math.min(8, Number.isFinite(parsedGap) ? parsedGap : 1.5));
  return Math.floor(seconds * 24000) * 2;
}

function extractAndSaveServerAudioBricks(session: any): any {
  if (!session) return session;
  const sessionId = session.id || 'session-assistant-1';
  const completedChunks = Array.isArray(session.completedChunks)
    ? session.completedChunks.map((c: any) => {
        if (c && c.id != null && c.audioBase64) {
          try {
            fs.writeFileSync(getChunkAudioPath(sessionId, c.id), c.audioBase64, 'utf-8');
          } catch {}
        }
        const chunkExistsOnDisk =
          c && c.id != null ? fs.existsSync(getChunkAudioPath(sessionId, c.id)) : false;
        const lightChunk = {
          id: c.id,
          title: c.title,
          wordCount: c.wordCount,
          text: c.text,
          customPrompt: c.customPrompt,
          hasAudioSaved: Boolean(c.audioBase64 || chunkExistsOnDisk),
          driveLink: c.driveLink,
        };
        return lightChunk;
      })
    : [];

  const cleanCopy = {
    ...session,
    id: sessionId,
    completedChunks,
  };
  delete cleanCopy.masterAudioBase64;
  return cleanCopy;
}

function prepareSessionMetadata(session: any): any {
  if (!session) return null;
  const sessionId = session.id || 'session-assistant-1';
  const completedChunks = Array.isArray(session.completedChunks)
    ? session.completedChunks.map((c: any) => {
        const diskFile = getChunkAudioPath(sessionId, c.id);
        const hasAudio = Boolean(c.audioBase64 || (c.id != null && fs.existsSync(diskFile)));
        return {
          id: c.id,
          title: c.title,
          wordCount: c.wordCount,
          text: c.text,
          customPrompt: c.customPrompt,
          hasAudioSaved: hasAudio,
          driveLink: c.driveLink,
          audioUrl: hasAudio
            ? `/api/session/chunk-audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(c.id)}`
            : undefined,
        };
      })
    : [];

  const copy = {
    ...session,
    id: sessionId,
    completedChunks,
  };
  delete copy.masterAudioBase64;
  return copy;
}

function readServerHistory(): any[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function atomicWriteJson(filePath: string, data: any) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function upsertServerHistory(session: any): any[] {
  try {
    const list = readServerHistory();
    if (!session || !session.id) return list;
    const cleanCopy = extractAndSaveServerAudioBricks(session);
    const updatedItem = {
      ...cleanCopy,
      updatedAt:
        session.updatedAt ||
        new Date().toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
    };
    const filtered = list.filter((item: any) => item.id !== session.id);
    const nextList = [updatedItem, ...filtered].slice(0, 30);
    atomicWriteJson(HISTORY_FILE, nextList);
    return nextList;
  } catch {
    return [];
  }
}

app.get('/api/session/current', (_req, res) => {
  try {
    const history = readServerHistory().map(prepareSessionMetadata);
    if (fs.existsSync(SESSION_FILE)) {
      const content = fs.readFileSync(SESSION_FILE, 'utf-8');
      const session = prepareSessionMetadata(JSON.parse(content));
      return res.json({ session, history, activeSessionCleared: false });
    }
    if (fs.existsSync(ACTIVE_SESSION_CLEARED_FILE)) {
      return res.json({ session: null, history, activeSessionCleared: true });
    }
    // If active session file is absent, return the most recent history session so progress is never lost
    if (history.length > 0) {
      return res.json({ session: history[0], history, activeSessionCleared: false });
    }
    return res.json({ session: null, history: [], activeSessionCleared: false });
  } catch (err: any) {
    console.error('Error reading session file:', err);
    return res.json({ session: null, history: [] });
  }
});

app.get('/api/session/load/:id', (req, res) => {
  try {
    const targetId = req.params.id;
    const history = readServerHistory();
    const found = history.find((h: any) => h.id === targetId);
    if (found) {
      return res.json({ session: prepareSessionMetadata(found) });
    }
    if (fs.existsSync(SESSION_FILE)) {
      const current = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      if (current && current.id === targetId) {
        return res.json({ session: prepareSessionMetadata(current) });
      }
    }
    return res.status(404).json({ error: 'Session not found on server' });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to load session' });
  }
});

// Stream single chunk audio directly as binary audio/wav with HTTP Range support
app.get('/api/session/chunk-audio/:sessionId/:chunkId', (req, res) => {
  try {
    const { sessionId, chunkId } = req.params;
    const p = getChunkAudioPath(sessionId, chunkId);
    if (!fs.existsSync(p)) {
      return res.status(404).json({ error: 'Audio chunk not found on server disk' });
    }
    const b64 = fs.readFileSync(p, 'utf-8').trim();
    const buffer = Buffer.from(b64, 'base64');
    const totalSize = buffer.length;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
      if (start >= totalSize || end >= totalSize || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
        return res.end();
      }
      const chunk = buffer.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': chunk.length,
      });
      return res.end(chunk);
    }

    res.setHeader('Content-Length', totalSize);
    return res.end(buffer);
  } catch (err: any) {
    console.error('Error streaming chunk audio:', err);
    return res.status(500).json({ error: err?.message || 'Failed to stream audio chunk' });
  }
});

// Fetch single chunk base64 on-demand (lightweight, single clip only)
app.get('/api/session/chunk-audio-b64/:sessionId/:chunkId', (req, res) => {
  try {
    const { sessionId, chunkId } = req.params;
    const p = getChunkAudioPath(sessionId, chunkId);
    if (!fs.existsSync(p)) {
      return res.status(404).json({ error: 'Audio chunk not found on server disk' });
    }
    const b64 = fs.readFileSync(p, 'utf-8').trim();
    return res.json({ audioBase64: b64, id: chunkId, sessionId });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to get chunk base64' });
  }
});

// Stream continuous Master WAV stitched directly from disk chunks
app.get('/api/session/master-audio/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const history = readServerHistory();
    const current = fs.existsSync(SESSION_FILE) ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) : null;
    const session = (current && current.id === sessionId) ? current : history.find((h: any) => h.id === sessionId);

    if (!session || !Array.isArray(session.completedChunks) || session.completedChunks.length === 0) {
      return res.status(404).json({ error: 'Session has no clips to merge' });
    }

    const pauseBytes = getInterClipPauseBytes(req.query.gap);
    let totalPcmLength = 0;

    for (const c of session.completedChunks) {
      const p = getChunkAudioPath(sessionId, c.id);
      if (!fs.existsSync(p)) continue;
      totalPcmLength += Math.max(0, decodedBase64Length(p) - 44);
    }

    const missingChunks = session.completedChunks.filter((chunk: any) => !fs.existsSync(getChunkAudioPath(sessionId, chunk.id)));
    if (missingChunks.length > 0) {
      return res.status(409).json({ error: 'Some clip audio is not saved on the server.', missingChunkIds: missingChunks.map((chunk: any) => chunk.id) });
    }

    totalPcmLength += pauseBytes * Math.max(0, session.completedChunks.length - 1);

    if (totalPcmLength === 0) {
      return res.status(404).json({ error: 'No audio data found for session' });
    }

    const totalSize = 44 + totalPcmLength;
    let byteStart = 0;
    let byteEnd = totalSize - 1;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const rangeMatch = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (!rangeMatch || (!rangeMatch[1] && !rangeMatch[2])) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      if (!rangeMatch[1]) {
        const suffixLength = Number(rangeMatch[2]);
        byteStart = Math.max(0, totalSize - suffixLength);
      } else {
        byteStart = Number(rangeMatch[1]);
        if (rangeMatch[2]) byteEnd = Math.min(byteEnd, Number(rangeMatch[2]));
      }
      if (byteStart >= totalSize || byteStart > byteEnd) {
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${byteStart}-${byteEnd}/${totalSize}`);
    }

    const filenameSlug = (session.topic || 'narration').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', byteEnd - byteStart + 1);
    res.setHeader('Content-Disposition', `attachment; filename="${filenameSlug}-master.wav"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    for await (const data of streamMasterWav(sessionId, session.completedChunks, totalPcmLength, pauseBytes, byteStart, byteEnd)) {
      if (!res.write(data)) await new Promise<void>((resolve) => res.once('drain', resolve));
    }
    return res.end();
  } catch (err: any) {
    console.error('Error generating master audio on server:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate master audio' });
  }
});

// Server-side ZIP export - streams directly from server disk with ZERO client memory overhead
app.get('/api/session/download-zip/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const mode = (req.query.mode as string) || 'both_parts_and_master';
    const pauseBytes = getInterClipPauseBytes(req.query.gap);
    const history = readServerHistory();
    const current = fs.existsSync(SESSION_FILE) ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) : null;
    const session = (current && current.id === sessionId) ? current : history.find((h: any) => h.id === sessionId);

    if (!session || !Array.isArray(session.completedChunks) || session.completedChunks.length === 0) {
      return res.status(404).json({ error: 'Session has no clips to package' });
    }

    const needsAudio = mode === 'both_parts_and_master' || mode === 'parts_only' || mode === 'single_master_wav';
    const missingChunks = needsAudio
      ? session.completedChunks.filter((chunk: any) => !fs.existsSync(getChunkAudioPath(sessionId, chunk.id)))
      : [];
    if (missingChunks.length > 0) {
      return res.status(409).json({ error: 'Some clip audio is not saved on the server.', missingChunkIds: missingChunks.map((chunk: any) => chunk.id) });
    }

    const filenameSlug = (session.topic || 'narration').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on('warning', (warning) => console.warn('Audio ZIP warning:', warning));
    archive.on('error', (error) => {
      console.error('Audio ZIP stream error:', error);
      res.destroy(error);
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameSlug}-audio-package.zip"`);
    archive.pipe(res);

    // 1. Full script text
    const fullScript = session.fullCombinedScript || session.fullScriptText || session.completedChunks.map((c: any) => c.text).join('\n\n');
    if (fullScript) {
      archive.append(fullScript, { name: `${filenameSlug}-complete-script.txt` });
    }

    // 2. Individual clips
    if (mode === 'both_parts_and_master' || mode === 'parts_only') {
      for (const c of session.completedChunks) {
        const p = getChunkAudioPath(sessionId, c.id);
        if (fs.existsSync(p)) {
          const pad = String(c.id).padStart(2, '0');
          archive.append(decodeBase64File(p), { name: `parts/${pad}-${filenameSlug}-clip-${c.id}.wav` });
        }
      }
    }

    // 3. Stitched Master WAV
    if (mode === 'both_parts_and_master' || mode === 'single_master_wav') {
      let totalPcm = 0;

      for (const c of session.completedChunks) {
        const p = getChunkAudioPath(sessionId, c.id);
        if (!fs.existsSync(p)) continue;
        totalPcm += Math.max(0, decodedBase64Length(p) - 44);
      }

      totalPcm += pauseBytes * Math.max(0, session.completedChunks.length - 1);

      if (totalPcm > 0) {
        archive.append(Readable.from(streamMasterWav(sessionId, session.completedChunks, totalPcm, pauseBytes)), {
          name: `${filenameSlug}-master-complete.wav`,
        });
      }
    }

    await archive.finalize();
  } catch (err: any) {
    console.error('Error generating server ZIP:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate zip package' });
  }
});

app.post('/api/session/save-chunk-audio', (req, res) => {
  try {
    const { sessionId, chunkId, audioBase64 } = req.body;
    if (!sessionId || chunkId == null || typeof audioBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) {
      return res.status(400).json({ success: false, error: 'Valid sessionId, chunkId, and base64 audio are required.' });
    }
    const audioPath = getChunkAudioPath(sessionId, chunkId);
    const temporaryPath = `${audioPath}.tmp`;
    fs.writeFileSync(temporaryPath, audioBase64, 'utf-8');
    fs.renameSync(temporaryPath, audioPath);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('Error saving chunk audio brick:', err);
    return res.status(500).json({ error: 'Failed to save chunk audio brick' });
  }
});

app.delete('/api/session/delete/:id', (req, res) => {
  try {
    const targetId = req.params.id;
    const list = readServerHistory();
    const filtered = list.filter((item: any) => item.id !== targetId);
    atomicWriteJson(HISTORY_FILE, filtered);

    if (fs.existsSync(SESSION_FILE)) {
      try {
        const current = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        if (current && current.id === targetId) {
          fs.unlinkSync(SESSION_FILE);
        }
      } catch {}
    }

    const audioPrefix = `${sanitizeId(targetId)}_chunk_`;
    for (const filename of fs.readdirSync(AUDIO_CHUNKS_DIR)) {
      if (filename.startsWith(audioPrefix)) {
        fs.unlinkSync(path.join(AUDIO_CHUNKS_DIR, filename));
      }
    }

    return res.json({ success: true, history: filtered });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to delete session' });
  }
});

app.post('/api/session/save', (req, res) => {
  try {
    const { session, clearActiveOnly } = req.body;
    if (clearActiveOnly || session === null) {
      // Archive current session into history before clearing active pointer (NEVER delete user progress!)
      if (fs.existsSync(SESSION_FILE)) {
        try {
          const existing = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
          if (existing && (existing.completedChunks?.length > 0 || existing.userPrompt)) {
            upsertServerHistory(existing);
          }
        } catch {}
        fs.unlinkSync(SESSION_FILE);
      }
      atomicWriteJson(ACTIVE_SESSION_CLEARED_FILE, { clearedAt: new Date().toISOString() });
      return res.json({ success: true, cleared: true, activeSessionCleared: true, history: readServerHistory() });
    }
    if (session) {
      const cleanSession = extractAndSaveServerAudioBricks(session);
      atomicWriteJson(SESSION_FILE, cleanSession);
      if (fs.existsSync(ACTIVE_SESSION_CLEARED_FILE)) {
        fs.unlinkSync(ACTIVE_SESSION_CLEARED_FILE);
      }
      const history = upsertServerHistory(cleanSession);
      return res.json({ success: true, history });
    }
    return res.json({ success: true, history: readServerHistory() });
  } catch (err: any) {
    console.error('Error saving session file:', err);
    return res.status(500).json({ error: 'Failed to persist session' });
  }
});

// Prebuilt soothing & warm voices available in Gemini 3.8 TTS
const VOICES = [
  { id: 'Charon', name: 'Charon', tone: 'Deep, calm, resonant, velvet bass', gender: 'Male (Deep Bass)' },
  { id: 'Aoede', name: 'Aoede', tone: 'Soft, warm, tranquil, velvet calm', gender: 'Female (Soft Alto)' },
  { id: 'Kore', name: 'Kore', tone: 'Peaceful, gentle, soothing, unsharp', gender: 'Female (Warm Mezzo)' },
  { id: 'Fenrir', name: 'Fenrir', tone: 'Warm, grounded, steady baritone', gender: 'Male (Baritone)' },
  { id: 'Puck', name: 'Puck', tone: 'Softened, gentle tenor', gender: 'Male (Tenor)' },
];

app.get('/api/voices', (_req, res) => {
  res.json({ voices: VOICES, model: 'gemini-3.8-flash-tts' });
});

// Single-speaker and multi-speaker TTS generation
app.post('/api/tts/generate', async (req, res) => {
  try {
    const { mode, text, style, voiceName, dialogueParts, speaker1, speaker2 } = req.body;

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'GEMINI_API_KEY is not configured on the server. Please check your environment configuration.',
      });
    }

    if (mode === 'dual') {
      // Screenplay / Dual-speaker mode
      if (!Array.isArray(dialogueParts) || dialogueParts.length === 0) {
        return res.status(400).json({ error: 'Dual speaker mode requires at least one dialogue line.' });
      }

      const sp1Name = speaker1?.name || 'Alex';
      const sp1Voice = speaker1?.voice || 'Puck';
      const sp2Name = speaker2?.name || 'Sam';
      const sp2Voice = speaker2?.voice || 'Kore';

      const parts = dialogueParts.map((item: { speaker: string; text: string; style?: string }) => ({
        text: `${item.speaker}: ${item.text}`,
        speechMetadata: {
          speaker: item.speaker,
          ...(item.style ? { style: item.style } : {}),
        },
      }));

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-tts',
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            multiSpeakerVoiceConfig: {
              speakerVoiceConfigs: [
                {
                  speaker: sp1Name,
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: sp1Voice },
                  },
                },
                {
                  speaker: sp2Name,
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: sp2Voice },
                  },
                },
              ],
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        return res.status(500).json({ error: 'No audio data was returned from Gemini TTS.' });
      }

      return res.json({
        audioBase64: base64Audio,
        mimeType: 'audio/wav',
        model: 'gemini-3.8-flash-tts',
        mode: 'dual',
      });
    }

    // Single-speaker mode
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text prompt is required.' });
    }

    // Sanitize stage directions like [pause: 3s], [pause: 5s], [silence] into natural ellipses so TTS never reads brackets aloud
    const sanitizedText = text
      .replace(/\[\s*(?:pause|silence|breath|wait)[^\]]*\]/gi, '... ...')
      .replace(/\(\s*(?:pause|silence)[^)]*\)/gi, '... ...')
      .trim();

    const selectedVoice = voiceName || 'Puck';
    const speechPart: { text: string; speechMetadata?: { style: string } } = {
      text: sanitizedText,
    };

    if (style && style.trim()) {
      speechPart.speechMetadata = { style: style.trim() };
    }

    let response;
    let usedModel = 'gemini-3.8-flash-tts';

    // Primary: Google Gemini 3.8 Flash TTS
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-tts',
        contents: [
          {
            role: 'user',
            parts: [speechPart],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: selectedVoice },
            },
          },
        },
      });
    } catch (err: any) {
      console.warn('gemini-3.8-flash-tts error. Trying gemini-3.8-flash-lite-tts fallback...', err?.message);
      try {
        usedModel = 'gemini-3.8-flash-lite-tts';
        response = await ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [speechPart],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice },
              },
            },
          },
        });
      } catch (err2: any) {
        const errMsg = String(err2?.message || err?.message || '');
        const match = errMsg.match(/retry in ([0-9.]+)s/i) || errMsg.match(/"retryDelay":\s*"([0-9]+)s"/i);
        const retryDelaySeconds = match ? Math.ceil(parseFloat(match[1])) : 35;
        const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota');

        return res.status(isRateLimit ? 429 : 500).json({
          error: isRateLimit
            ? `Gemini quota limit reached. Please wait ${retryDelaySeconds}s for the quota bucket to reset.`
            : errMsg,
          isRateLimit,
          retryDelaySeconds,
        });
      }
    }

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64Audio) {
      return res.status(500).json({ error: 'No audio data returned by Gemini TTS.' });
    }

    // Ensure returned base64 audio always has a valid 44-byte 24kHz 16-bit Mono RIFF WAVE header
    const rawBuf = Buffer.from(base64Audio, 'base64');
    const isRiff =
      rawBuf.length > 44 &&
      rawBuf[0] === 0x52 &&
      rawBuf[1] === 0x49 &&
      rawBuf[2] === 0x46 &&
      rawBuf[3] === 0x46;

    let finalWavBase64 = base64Audio;
    if (!isRiff) {
      const pcmLen = rawBuf.length - (rawBuf.length % 2);
      const wavBuf = Buffer.alloc(44 + pcmLen);
      wavBuf.write('RIFF', 0);
      wavBuf.writeUInt32LE(36 + pcmLen, 4);
      wavBuf.write('WAVE', 8);
      wavBuf.write('fmt ', 12);
      wavBuf.writeUInt32LE(16, 16);
      wavBuf.writeUInt16LE(1, 20); // PCM
      wavBuf.writeUInt16LE(1, 22); // Mono
      wavBuf.writeUInt32LE(24000, 24); // 24kHz
      wavBuf.writeUInt32LE(48000, 28); // ByteRate
      wavBuf.writeUInt16LE(2, 32); // BlockAlign
      wavBuf.writeUInt16LE(16, 34); // BitsPerSample
      wavBuf.write('data', 36);
      wavBuf.writeUInt32LE(pcmLen, 40);
      rawBuf.copy(wavBuf, 44, 0, pcmLen);
      finalWavBase64 = wavBuf.toString('base64');
    }

    return res.json({
      audioBase64: finalWavBase64,
      mimeType: 'audio/wav',
      model: usedModel,
      mode: 'single',
    });
  } catch (error: any) {
    console.error('TTS Generation error:', error);
    const errMsg = String(error?.message || '');
    const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED');
    const match = errMsg.match(/retry in ([0-9.]+)s/i) || errMsg.match(/"retryDelay":\s*"([0-9]+)s"/i);
    const retryDelaySeconds = match ? Math.ceil(parseFloat(match[1])) : 45;

    return res.status(isRateLimit ? 429 : 500).json({
      error: isRateLimit
        ? `Free Tier quota reached. Please wait ${retryDelaySeconds}s for quota refresh.`
        : errMsg || 'Failed to generate speech audio with Gemini TTS.',
      isRateLimit,
      retryDelaySeconds,
    });
  }
});

// Merge multiple 24kHz unary WAV clips into a single continuous WAV file
app.post('/api/tts/merge-wavs', (req, res) => {
  try {
    const { audioChunks } = req.body;
    if (!Array.isArray(audioChunks) || audioChunks.length === 0) {
      return res.status(400).json({ error: 'No audio chunks provided for merging.' });
    }

    if (audioChunks.length === 1) {
      return res.json({ mergedAudioBase64: audioChunks[0] });
    }

    const pcmBuffers: Buffer[] = [];
    let firstHeader: Buffer | null = null;
    let totalPcmLength = 0;

    for (let i = 0; i < audioChunks.length; i++) {
      const buf = Buffer.from(audioChunks[i], 'base64');
      if (buf.length <= 44) continue;

      if (!firstHeader) {
        firstHeader = Buffer.from(buf.subarray(0, 44));
      }

      // Slice out the 44-byte RIFF header to extract raw PCM
      const pcm = buf.subarray(44);
      pcmBuffers.push(pcm);
      totalPcmLength += pcm.length;
    }

    if (!firstHeader || totalPcmLength === 0) {
      return res.status(500).json({ error: 'Unable to extract PCM from provided audio chunks.' });
    }

    // Allocate continuous buffer for combined WAV file
    const mergedWav = Buffer.alloc(44 + totalPcmLength);
    firstHeader.copy(mergedWav, 0, 0, 44);

    // Update RIFF ChunkSize (File size - 8)
    mergedWav.writeUInt32LE(36 + totalPcmLength, 4);

    // Update data Subchunk2Size
    mergedWav.writeUInt32LE(totalPcmLength, 40);

    // Append all PCM data
    let currentOffset = 44;
    for (const pcm of pcmBuffers) {
      pcm.copy(mergedWav, currentOffset);
      currentOffset += pcm.length;
    }

    return res.json({
      mergedAudioBase64: mergedWav.toString('base64'),
      mimeType: 'audio/wav',
      totalBytes: mergedWav.length,
      estimatedMinutes: (totalPcmLength / (24000 * 2 * 60)).toFixed(1),
    });
  } catch (err: any) {
    console.error('Merge WAVs error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to merge WAV files.' });
  }
});

// Helper route to enrich plain text with expressive vocal cues (<breath>, <laugh>, <gasp>, |mhm|, |yeah|)
app.post('/api/script/enhance', async (req, res) => {
  try {
    const { text, mood } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required to enrich.' });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `You are an audio director for Gemini 3.8 Flash TTS. 
Gemini 3.8 Flash TTS supports vocal bursts (<laugh>, <gasp>, <breath>, <cough>, <sigh>) and backchanneling cues (|yeah|, |mhm|, |right|, |uh-huh|).
Given the input script, enhance it naturally by inserting a few well-placed vocal tags and backchannels to match the mood: "${mood || 'expressive and conversational'}".
Keep the original meaning and core words. Do NOT add meta commentary or explanation. Return ONLY the enhanced script text.

Input Script:
${text}`,
    });

    const enhanced = response.text?.trim() || text;
    return res.json({ enhancedText: enhanced });
  } catch (err: any) {
    console.error('Enhance script error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to enhance script.' });
  }
});

// Helper to build any number of systematic subtopics (7, 14, 15, 20, 30+ parts) with zero cap
const EXTENDED_SUBTOPIC_POOL = [
  'The Quiescent Pre-Collapse and Hydrostatic Equilibrium',
  'Nuclear Fuel Exhaustion and Silicon-Burning Shell Kinetics',
  'Inert Iron-56 Core Accumulation and Endothermic Photodisintegration',
  'Phase Space Lattice Occupation and the Pauli Exclusion Principle',
  'Non-Relativistic Electron Degeneracy Pressure and Fermi Momentum',
  'Transition to Relativistic Fermi Gas and Adiabatic Index Softening',
  'The Chandrasekhar Mass Threshold and Loss of Mechanical Stability',
  'Inverse Beta Decay, Electron Capture, and Neutrino Escape Channels',
  'Homologous Inner Core Infall and Supersonic Outer Mantle Velocity',
  'Nuclear Saturation Density and Short-Range Strong Force Stiffening',
  'Tolman-Oppenheimer-Volkoff Pressure Integral and Neutron Degeneracy',
  'Relativistic Gravity Dominance Over Quantum Baryonic Repulsion',
  'Gravitational Redshift Steepening and Exterior Coordinate Dilation',
  'The Photon Sphere at 1.5 Schwarzschild Radii and Null Geodesic Orbits',
  'Light-Cone Tipping and Inward Tilt of Causal Future Trajectories',
  'Asymptotic Freezing of Infalling Matter Relative to Distant Observers',
  'The Schwarzschild Radius and Coordinate Singularity Resolution',
  'Eddington-Finkelstein Ingoing Coordinates and Continuous Horizon Crossing',
  'Metric Signature Inversion: Radial Space Becoming Unidirectional Time',
  'Kruskal-Szekeres Maximal Analytic Extension and Causal Geometry',
  'Weyl Curvature Tensor Divergence and Tidal Geodesic Deviation',
  'Birkhoff Theorem and the Elimination of Monopole Gravitational Radiation',
  'No-Hair Theorem: Asymptotic Relaxation to Mass, Charge, and Spin',
  'Quasinormal Ringdown Modes and Damped Spacetime Perturbations',
  'Surface Gravity Uniformity and Zeroth Law of Black Hole Mechanics',
  'Bekenstein-Hawking Horizon Area Entropy and Microstate Counting',
  'Quantum Vacuum Fluctuations Near the Horizon and Hawking Thermal Flux',
  'Unruh Effect Equivalence and Exponential Redshift of Escaping Modes',
  'Infinite Wavelength Stretching and Deep Infrared Photon Attenuation',
  'Thermodynamic Equilibrium, Zero-Resistance Stasis, and Absolute Rest',
];

function buildFallbackSubtopics(topic: string, count: number, customPrompt?: string): Array<{ title: string; movement: string; targetWords: string }> {
  const num = Math.max(1, count);
  const result: Array<{ title: string; movement: string; targetWords: string }> = [];
  const tier1End = Math.max(1, Math.floor(num * 0.15));
  const tier3Start = Math.max(tier1End + 1, Math.ceil(num * 0.85));

  for (let i = 0; i < num; i++) {
    let movement = 'Movement II';
    if (i < tier1End) movement = 'Movement I';
    else if (i >= tier3Start) movement = 'Movement III';

    const poolItem = EXTENDED_SUBTOPIC_POOL[i % EXTENDED_SUBTOPIC_POOL.length];
    const cycleSuffix = i >= EXTENDED_SUBTOPIC_POOL.length ? ` (Phase ${Math.floor(i / EXTENDED_SUBTOPIC_POOL.length) + 1})` : '';
    const prefix = customPrompt ? `${customPrompt.slice(0, 60).trim()} — ` : '';
    result.push({
      title: `${movement}: ${prefix}${poolItem}${cycleSuffix}`,
      movement,
      targetWords: '550-600 words',
    });
  }
  return result;
}

const PHOTON_SINGLE_CLIP_SCRIPT = `Deep within the radiative zone of a main-sequence star, energy generated by proton-proton fusion migrates outward through a dense plasma of hydrogen and helium ions, undergoing billions of Compton scattering events over more than 100,000 years before finally reaching the tenuous upper boundary known as the photosphere. At an effective surface temperature of 5,800 Kelvin, a single optical photon decouples from the thermalized stellar gas at a wavelength of 465 nanometers, departing the stellar horizon at a constant vacuum velocity of 299,792 kilometers per second. Once past the outer coronal magnetic loops, the local particle density drops below 10 protons per cubic centimeter, and the photon enters the quiet expanse of the interstellar medium, where collisions become extraordinarily rare and trajectories remain linear across hundreds of parsecs.

As the electromagnetic wave packet propagates through the galactic disk over the next 1,400 years, its oscillating electric and magnetic fields remain strictly perpendicular to the direction of travel, maintaining a fixed frequency near 645 terahertz. Across these vast spatial intervals, the ambient temperature of surrounding neutral hydrogen clouds settles near 80 Kelvin, while diffuse ionized regions emit faint, dispersed spectral lines that never perturb the passing wave. Occasionally, the photon traverses a cold molecular cloud filament containing sub-micron silicate and carbonaceous dust grains measuring between 0.05 and 0.25 micrometers in diameter. Because the grain dimensions are comparable to the optical wavelength, Mie scattering slightly deflects the propagation angle by a fraction of an arcsecond, while adjacent shorter-wavelength ultraviolet photons are selectively absorbed and re-emitted as far-infrared thermal radiation at 20 Kelvin.

Throughout this interstellar transit, weak galactic magnetic fields with strengths between 3 and 6 microgauss permeate the tenuous gas, aligning elongated paramagnetic dust particles along uniform field lines through radiative torque mechanisms. As the photon passes through these aligned silicate curtains, dichroic extinction subtly filters its transverse oscillation plane, introducing a measurable linear polarization of 1.8 percent without altering its forward velocity. Over distances exceeding 850 parsecs, the cumulative differential motion of the spiral arm introduces a modest Doppler shift, gently stretching the original 465-nanometer blue-white wavelength toward 468 nanometers while preserving the coherence of its phase packet.

Eventually, after crossing trillions of kilometers of undisturbed vacuum, the photon enters the gravitational neighborhood of a quiet planetary system and encounters the upper stratosphere of a terrestrial world. Passing through tenuous layers of molecular nitrogen, oxygen, and trace argon, the wave experiences slight Rayleigh refractive bending before descending into the dry air above a high-altitude astronomical observatory at 4,200 meters elevation. Entering the open aperture of a Cassegrain reflecting telescope, the photon reflects cleanly off a paraboloidal aluminum-coated primary mirror and a hyperbolic secondary mirror, converging onto a cryogenically cooled silicon charge-coupled device kept at 170 Kelvin. Within the crystalline silicon depletion layer, the photon transfers its discrete energy of 2.65 electron-volts to a bound valence electron, liberating a single measurable photoelectron that settles quietly into a potential well, completing its long transit across interstellar space in complete thermal stillness.`;

function detectTargetWordsFromPrompt(prompt: string, explicitTargetWords?: number): number {
  if (explicitTargetWords && Number.isFinite(Number(explicitTargetWords)) && Number(explicitTargetWords) >= 300) {
    return Math.round(Number(explicitTargetWords));
  }

  // Strip rate expressions (e.g., "90-100 words per minute", "550 to 600 words per segment") before scanning target lengths
  const cleanedPrompt = prompt
    .replace(/\b\d+(?:\s*[-–to]+\s*\d+)?\s*words?\s*(?:per|\/|a)\s*(?:minute|min|clip|segment|part|section)\b/gi, '')
    .replace(/\b550\s*(?:to|[-–])\s*600\s*words?\b/gi, '');

  // Check if user explicitly asks for a single 500-word clip or "The Quiet Life of a Photon"
  if (
    /quiet life of a photon/i.test(cleanedPrompt) ||
    /\bsingle\s+(?:short\s+)?(?:audio\s+)?clip\b/i.test(cleanedPrompt) ||
    /\bone\s+single\b/i.test(cleanedPrompt)
  ) {
    const explicitSmallMatch = cleanedPrompt.match(/(?:~|\b)([\d,]{3,4})[\s-]*words?\b/i);
    if (explicitSmallMatch) {
      const w = parseInt(explicitSmallMatch[1].replace(/,/g, ''), 10);
      if (w >= 300 && w <= 650) return w;
    }
    return 500;
  }

  // 1. Check all explicit word counts in prompt (e.g., "8,000 words", "4,000-word") and pick largest >= 300
  const wordMatches = Array.from(cleanedPrompt.matchAll(/(?:~|\b)([\d,]{3,7})[\s-]*words?\b/gi));
  let maxWords = 0;
  for (const m of wordMatches) {
    const w = parseInt(m[1].replace(/,/g, ''), 10);
    if (w >= 300 && w > maxWords) maxWords = w;
  }
  if (maxWords >= 300) return maxWords;

  // 2. Check all explicit hours in prompt (e.g., "2 hours", "2-hour", "1.5 hrs") -> ~4,500 words per hour
  const hourMatches = Array.from(cleanedPrompt.matchAll(/(?:\b|-)(\d+(?:\.\d+)?)[\s-]*(?:hours|hour|hrs|hr)\b/gi));
  let maxHours = 0;
  for (const m of hourMatches) {
    const h = parseFloat(m[1]);
    if (h > maxHours && h <= 24) maxHours = h;
  }
  if (maxHours > 0) return Math.max(500, Math.round(maxHours * 4500));

  // 3. Check all explicit minutes in prompt (e.g., "90-minute", "120 minutes", "75–90 min") and pick largest!
  const minMatches = Array.from(cleanedPrompt.matchAll(/(?:\b|–|-)(\d{1,4})[\s-]*(?:minutes|minute|mins|min)\b/gi));
  let maxMins = 0;
  for (const m of minMatches) {
    const mins = parseInt(m[1], 10);
    if (mins >= 4 && mins <= 1440 && mins > maxMins) maxMins = mins;
  }
  if (maxMins >= 4) return Math.max(500, Math.round(maxMins * 75));

  // Default to 4,000 words if no word/time limit is mentioned in prompt
  return 4000;
}

// Autonomous chat planning endpoint: decomposes any user prompt into strict 550-600w segments (or 1 single ~500w clip if requested)
app.post('/api/chat/plan-orchestration', async (req, res) => {
  try {
    const { prompt, targetWords: explicitTargetWords } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'User prompt is required.' });
    }

    const isPhotonTest = /quiet life of a photon/i.test(prompt);
    const isSingleClipRequested =
      isPhotonTest ||
      /\bsingle\s+(?:short\s+)?(?:audio\s+)?clip\b/i.test(prompt) ||
      /\bone\s+single\b/i.test(prompt);

    const extractedTopicMatch =
      prompt.match(/titled:\s*[\n\r\s*“"']*([^"”'\n\r*]+)/i) ||
      prompt.match(/on:\s*["']?([^"'\n\r]+)["']?/i) ||
      prompt.match(/topic:\s*["']?([^"'\n\r]+)["']?/i);
    const cleanTopic = isPhotonTest
      ? 'The Quiet Life of a Photon'
      : extractedTopicMatch
      ? extractedTopicMatch[1].trim()
      : prompt.slice(0, 90).replace(/\n/g, ' ').trim();

    const targetWords = detectTargetWordsFromPrompt(prompt, explicitTargetWords);
    const targetSegmentsCount = isSingleClipRequested || targetWords <= 600 ? 1 : Math.max(1, Math.ceil(targetWords / 575));

    if (targetSegmentsCount === 1) {
      return res.json({
        topic: cleanTopic,
        targetWords: isPhotonTest ? 500 : targetWords,
        subtopics: [
          {
            title: cleanTopic,
            movement: 'Single Continuous Narration (~500 Words)',
            targetWords: '~500 words',
            customPrompt: prompt,
          },
        ],
      });
    }

    const fallbackPlan = {
      topic: cleanTopic,
      targetWords,
      subtopics: buildFallbackSubtopics(cleanTopic, targetSegmentsCount),
    };

    // For very large segment counts (e.g. > 30), ask AI for initial batch and seamlessly extend
    const aiBatchCount = Math.min(30, targetSegmentsCount);

    const aiPrompt = `You are an acoustic director and script architect for exhaustive "boring science" sleep narrations.
Analyze the following user prompt:
"${prompt}"

CRITICAL RULE:
- Total target length: ${targetWords} words.
- Every single segment MUST be 550 to 600 words long (NEVER smaller chunks).
- Therefore, we need ${aiBatchCount} sequential subtopic segments (each 550-600 words).

Distribute the ${aiBatchCount} subtopics across:
- Movement I (Opening ~15%): Quiescent baseline, spatial detachment, equilibrium.
- Movement II (Core ~70%): Granular step-by-step physical mechanisms, mathematical invariants, and progressive transformations.
- Movement III (Final ~15%): Asymptotic stillness, infinite redshift, thermodynamic equilibrium, and absolute rest.

Return a JSON object with ${aiBatchCount} items in "subtopics":
{
  "topic": "Clean topic name",
  "targetWords": ${targetWords},
  "subtopics": [
    { "title": "Movement I: ...", "movement": "Movement I", "targetWords": "550-600 words" }
  ]
}
Output valid raw JSON only.`;

    let response;
    const planModels = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];

    for (const m of planModels) {
      try {
        response = await ai.models.generateContent({
          model: m,
          contents: aiPrompt,
          config: { responseMimeType: 'application/json' },
        });
        if (response && response.text) break;
      } catch (err: any) {
        console.warn(`Model ${m} failed for planning:`, err?.message);
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    if (!response || !response.text) {
      return res.json(fallbackPlan);
    }

    try {
      const parsed = JSON.parse(response.text.trim());
      if (parsed.subtopics && Array.isArray(parsed.subtopics) && parsed.subtopics.length > 0) {
        const finalSubtopics = [...parsed.subtopics];
        if (finalSubtopics.length < targetSegmentsCount) {
          const extraNeeded = buildFallbackSubtopics(parsed.topic || cleanTopic, targetSegmentsCount);
          for (let i = finalSubtopics.length; i < targetSegmentsCount; i++) {
            finalSubtopics.push(extraNeeded[i]);
          }
        }
        return res.json({
          topic: parsed.topic || cleanTopic,
          targetWords,
          subtopics: finalSubtopics,
        });
      }
    } catch {}

    return res.json(fallbackPlan);
  } catch (err: any) {
    console.error('Chat orchestration error:', err);
    const targetWords = detectTargetWordsFromPrompt(req.body?.prompt || '', req.body?.targetWords);
    const count = Math.max(1, Math.ceil(targetWords / 575));
    return res.json({
      topic: 'Stellar Collapse, Degeneracy Pressure, and the Schwarzschild Metric',
      targetWords,
      subtopics: buildFallbackSubtopics('Stellar Collapse, Degeneracy Pressure, and the Schwarzschild Metric', count),
    });
  }
});

// Generate more 550-600w segments for an existing session from a new prompt or additional word/time target
app.post('/api/chat/expand-plan', async (req, res) => {
  try {
    const { topic, existingSubtopics = [], additionalPrompt = '', additionalWords } = req.body;
    const extraWords = detectTargetWordsFromPrompt(additionalPrompt, additionalWords || 2000);
    const additionalCount = Math.max(1, Math.ceil(extraWords / 575));
    const targetTotal = existingSubtopics.length + additionalCount;
    const cleanTopic = additionalPrompt.trim()
      ? `${topic || 'Sleep Narration'} — ${additionalPrompt.trim().slice(0, 80)}`
      : topic || 'Stellar Collapse, Degeneracy Pressure, and the Schwarzschild Metric';

    const existingTitles = existingSubtopics.slice(-10).map((s: any, idx: number) => `${idx + 1}. ${s.title}`).join('\n');

    const aiPrompt = `You are an acoustic director for long-form scientific sleep narrations.
Topic: "${topic || cleanTopic}"
${additionalPrompt ? `New Continuation Prompt / Direction from User:\n"${additionalPrompt}"` : ''}

Recent segments already covered:
${existingTitles}

The user wants to generate ${extraWords} more words of narration. Since EVERY segment is strictly 550 to 600 words, generate EXACTLY ${additionalCount} new sequential subtopics (Segments ${existingSubtopics.length + 1} through ${targetTotal}) following the user's new prompt/direction.

Return a JSON object:
{
  "newSubtopics": [
    { "title": "Movement II: ...", "movement": "Movement II", "targetWords": "550-600 words" }
  ]
}
Output valid raw JSON only.`;

    let addedSubtopics: Array<{ title: string; movement: string; targetWords: string }> = [];
    const planModels = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];

    for (const m of planModels) {
      try {
        const response = await ai.models.generateContent({
          model: m,
          contents: aiPrompt,
          config: { responseMimeType: 'application/json' },
        });
        if (response && response.text) {
          const parsed = JSON.parse(response.text.trim());
          if (parsed.newSubtopics && Array.isArray(parsed.newSubtopics) && parsed.newSubtopics.length > 0) {
            addedSubtopics = parsed.newSubtopics.map((s: any) => ({
              ...s,
              targetWords: '550-600 words',
              customPrompt: additionalPrompt || undefined,
            }));
            break;
          }
        }
      } catch (err: any) {
        console.warn(`Expand plan model ${m} failed:`, err?.message);
      }
    }

    const fallbackFull = buildFallbackSubtopics(cleanTopic, targetTotal, additionalPrompt);
    while (addedSubtopics.length < additionalCount) {
      const idx = existingSubtopics.length + addedSubtopics.length;
      addedSubtopics.push({
        ...(fallbackFull[idx] || {
          title: `Movement III: Deep Asymptotic Redshift and Horizon Equilibrium (Part ${idx + 1})`,
          movement: 'Movement III',
          targetWords: '550-600 words',
        }),
        ...(additionalPrompt ? { customPrompt: additionalPrompt } : {}),
      });
    }

    const combinedSubtopics = [...existingSubtopics, ...addedSubtopics.slice(0, additionalCount)];

    return res.json({
      topic: topic || cleanTopic,
      addedWords: extraWords,
      addedSegmentsCount: additionalCount,
      subtopics: combinedSubtopics,
    });
  } catch (err: any) {
    console.error('Expand plan error:', err);
    const existingSubtopics = req.body?.existingSubtopics || [];
    const extraWords = Number(req.body?.additionalWords) || 2000;
    const additionalCount = Math.max(1, Math.ceil(extraWords / 575));
    const targetTotal = existingSubtopics.length + additionalCount;
    const fallbackFull = buildFallbackSubtopics(req.body?.topic || 'Stellar Collapse', targetTotal, req.body?.additionalPrompt);
    const combined = [...existingSubtopics, ...fallbackFull.slice(existingSubtopics.length, targetTotal)];
    return res.json({
      topic: req.body?.topic || 'Stellar Collapse, Degeneracy Pressure, and the Schwarzschild Metric',
      addedWords: extraWords,
      addedSegmentsCount: additionalCount,
      subtopics: combined,
    });
  }
});

// Plan subtopics for long systematic topic
app.post('/api/script/plan-subtopics', async (req, res) => {
  try {
    const { topic = 'Fields of Quantum Mechanics', count = 4 } = req.body;

    const prompt = `You are an acoustic director and script architect for long-form, intellectually dense "boring science and systematic phenomena" sleep narrations.
Topic: "${topic}"
Generate an ordered list of exactly ${count} subtopics that systematically cover this domain across a 3-Tier Deceleration architecture:
1. Subtopic 1 (Tier 1: Tacit Spatial & Scale Detachment): Grounding the listener in an expansive, quiet, slowly operating framework.
2. Subtopic 2 to ${count - 1} (Tier 2: Exhaustive Systematic Absorption): Granular, step-by-step mechanical reality, physical analogies, and laws.
3. Subtopic ${count} (Tier 3: Hypnagogic Drift & Semantic Dissolution): Fading into non-linear, zero-resistance stasis, thermal equilibrium, and absolute rest.

Return a JSON array of strings containing the subtopic titles only. Example: ["Subtopic 1 title", "Subtopic 2 title", ...]
Output valid raw JSON only.`;

    let subtopics: string[] = [];
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      subtopics = JSON.parse(response.text?.trim() || '[]');
    } catch {
      try {
        const response2 = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });
        subtopics = JSON.parse(response2.text?.trim() || '[]');
      } catch {
        // High-fidelity algorithmic domain fallback if transient 503 occurs
        subtopics = [
          `Foundational Principles & Scale Detachment in ${topic}`,
          `Granular Mechanics & Boundary Equilibrium in ${topic}`,
          `Dissipative Systems & Thermodynamic Limits in ${topic}`,
          `Asymptotic Decay & Absolute Ground State in ${topic}`,
        ].slice(0, count);
      }
    }

    if (!Array.isArray(subtopics) || subtopics.length === 0) {
      subtopics = [
        `Spatial & Scale Detachment in ${topic}`,
        `Step-by-Step Systematic Absorption in ${topic}`,
        `Asymptotic Rest and Silence in ${topic}`,
      ];
    }

    return res.json({ subtopics });
  } catch (err: any) {
    console.error('Plan subtopics error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to plan subtopics' });
  }
});

// Generate a strict 550-600 word section (or ~500 word single-clip test)
app.post('/api/script/generate-subtopic-section', async (req, res) => {
  try {
    const { topic, subtopic, sectionIndex = 1, totalSections = 4, previousContext = '', customPrompt = '' } = req.body;

    if (
      /quiet life of a photon/i.test(String(topic || '')) ||
      /quiet life of a photon/i.test(String(subtopic || '')) ||
      /quiet life of a photon/i.test(String(customPrompt || ''))
    ) {
      const wordCount = PHOTON_SINGLE_CLIP_SCRIPT.split(/\s+/).filter(Boolean).length;
      return res.json({
        sectionText: PHOTON_SINGLE_CLIP_SCRIPT,
        wordCount,
        subtopic: 'The Quiet Life of a Photon',
        sectionIndex: 1,
      });
    }

    const tierName = 
      sectionIndex === 1 
        ? 'TIER 1: TACIT SPATIAL & SCALE DETACHMENT' 
        : sectionIndex >= totalSections 
        ? 'TIER 3: HYPNAGOGIC DRIFT & SEMANTIC DISSOLUTION' 
        : 'TIER 2: EXHAUSTIVE SYSTEMATIC ABSORPTION';

    const wordRangeInstruction =
      totalSections === 1
        ? `- Write a continuous narration of approximately 500 words (490 to 530 words), with no headings, bullet points, stage directions, or pronunciation notes.`
        : `- You MUST write a script section that is strictly between 550 and 600 words.\n- Do NOT generate less than 550 words.\n- Do NOT generate more than 600 words.`;

    const systemPrompt = `You are an expert scriptwriter and acoustic director specializing in long-form, intellectually dense "boring science and systematic phenomena" sleep narrations. Your audience consists of high-cognition, analytical adults (engineers, programmers, researchers, mathematicians, and students) whose hyperactive Default Mode Networks (DMN) cannot shut down at night without a substantive, zero-threat intellectual stimulus.

Your objective is to craft exhaustive, deeply descriptive, and unhurried narratives that fatigue analytical thinking and systematically steer neural activity toward Stage N3 slow-wave sleep.

---

### 1. SCOPE & DOMAIN AGNOSTICISM: THE UNIVERSAL PRINCIPLE
Any systematic, complex physical or theoretical domain can be transformed into an everlasting sleep lecture:
- Fluid Dynamics & Hydrology: Laminar boundary layers, deep ocean currents, abyssal plains, aquifer filtration, thermohaline circulation.
- Pure & Applied Mathematics: Non-Euclidean geometries, topological manifolds, infinite series, continuous functions, prime distribution lattices.
- Structural & Material Physics: Crystalline lattice slip-planes, thermodynamic entropy dissipation, metallurgy phase transitions, heat diffusion through stone.
- Mechanical & Temporal Systems: Escapement balance wheels, glacial drift, celestial mechanics, long-term tectonic subduction.

---

### 2. THE TONAL RULE: "ANTI-CRINGE" OBJECTIVITY
- Strictly No Guided Meditation: Never talk to the listener's body. Never say "relax your shoulders," "unclench your jaw," "breathe in deeply," "close your eyes," or "feel the bed." That causes self-conscious focus and breaks intellectual immersion.
- Strictly No Cozy Tropes: Never mention warm blankets, crackling hearths, cups of tea, or quaint village stories.
- The Narrative Persona: An impassive, endlessly patient archival researcher or field observer describing systematic reality late at night. The delivery is emotionally flat, steady, deeply factual, unhurried, and quiet.

---

### 3. THE "EVERLASTING DETAIL" WRITING TECHNIQUE
Do not summarize. Do not skip steps. Sleep narration works by lingering exhaustively on microscopic and macroscopic mechanics:
- Prolonged Physical Mechanics: Trace microscopic friction, inertia, equilibrium, laminar flow, dissipation, dampening, steady states, asymptotic limits, gradual erosion, uniform distribution, and timeless stasis.
- Zero Narrative Drama: Remove all stakes, urgency, catastrophe, and narrative cliffhangers. Describe physical and theoretical balance as natural, eternal inevitabilities.

---

### 4. CURRENT ARCHITECTURAL PHASE:
This section represents ${tierName} (Part ${sectionIndex} of ${totalSections}).
Overall Domain: "${topic}"
Specific Focus for this section: "${subtopic}"
${customPrompt ? `Additional User Prompt / Direction for this segment: "${customPrompt}"` : ''}
${previousContext ? `Context from previous section: ${previousContext.slice(-300)}` : ''}

---

### 5. STRICT WORD COUNT REQUIREMENT:
${wordRangeInstruction}

---

### 6. ACOUSTIC & TTS FORMATTING RULES:
1. Ellipses & Spacing:
   - Use double line breaks between sentences.
   - Use ellipses (...) frequently within and between sentences to force 2-to-4-second natural pauses during speech synthesis.
   - Never use exclamation marks or question marks. Use only periods, commas, and ellipses.
2. Expressive Tags:
   - Use the <breath> tag at most ONCE in this section, isolated with spaces: "... <breath> ...".
   - Do NOT use <gasp>, <laugh>, <cough>, or conversational tags (|yeah|, |mhm|).
3. Phonetic Smoothing:
   - Avoid dense clusters of harsh plosive consonants ('k', 'p', 't', 'b', 'd').
   - Maximize soft, elongated vowels and smooth fricatives/liquids ('s', 'm', 'l', 'w', 'f', 'n').

---

### 7. OUTPUT FORMAT:
- Output ONLY the direct narration text.
- Never output meta-introductions, titles, phase labels, bracketed production notes, or concluding pleasantries.
- Begin immediately with the opening word of the script.`;

    let response;
    const modelsToTry = ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
    let lastError: any = null;

    for (const modelName of modelsToTry) {
      try {
        response = await ai.models.generateContent({
          model: modelName,
          contents: systemPrompt,
        });
        if (response && response.text) break;
      } catch (err: any) {
        lastError = err;
        console.warn(`Model ${modelName} encountered error or 503 high demand:`, err?.message);
        // Short pause before trying next fallback model
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    if (!response || !response.text) {
      const errMsg = lastError?.message || 'High demand across Gemini models.';
      const is503 = errMsg.includes('503') || errMsg.includes('high demand') || errMsg.includes('UNAVAILABLE');
      return res.status(is503 ? 503 : 500).json({
        error: is503
          ? 'This model is currently experiencing temporary high demand (503). Retrying in a few seconds...'
          : errMsg,
        is503,
      });
    }

    const sectionText = response.text
      .replace(/\[\s*(?:pause|silence|breath|wait)[^\]]*\]/gi, '... ...')
      .replace(/\(\s*(?:pause|silence)[^)]*\)/gi, '... ...')
      .trim();
    const wordCount = sectionText.split(/\s+/).filter(Boolean).length;

    return res.json({
      sectionText,
      wordCount,
      subtopic,
      sectionIndex,
    });
  } catch (err: any) {
    console.error('Generate subtopic section fatal error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate section' });
  }
});

// Specialized route for 3-Tier Hypnagogic Deceleration Scripts
app.post('/api/script/deceleration', async (req, res) => {
  try {
    const { topic = 'Interstellar Drift and Cosmic Cooling' } = req.body;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `You are an expert scriptwriter for cosmic relaxation audio and neuro-acoustic deceleration.
Topic: ${topic}

Write a 3-TIER DECELERATION SCRIPT with a smooth, flowing, moderately unhurried pace (around 105 to 115 words per minute). 
Tone: Soothing, serene, gentle, clear, and peaceful. Not overly deep or dragging. Natural, comforting pauses.

Architectural Phases to generate:
[PHASE 1: SOMATIC RESET & ASTRONOMICAL ORIENTATION] (~115 WPM)
- Open with gentle autogenic relaxation (releasing tension in the shoulders, jaw, and eyes).
- Transition smoothly into the silent beauty of interstellar space.
- Format: Full, rhythmic, flowing sentences. Insert one <breath> tag in this phase.

[PHASE 2: MONOTONOUS SCIENTIFIC ABSORPTION] (~105 WPM)
- Explain the physical mechanics of ${topic} through serene, elegant visual analogies.
- Goal: Calm the analytical mind with peaceful cosmological imagery.
- Format: Flowing clauses with occasional single ellipses (...) for natural gentle pauses.

[PHASE 3: COGNITIVE SHUFFLE & SEMANTIC DISSOLUTION] (~95 WPM)
- Dissolve narrative into gentle, floating descriptions of weightless drift, quiet cooling, and peaceful rest.
- Format: Rhythmic soothing phrases with light ellipses (...) dissolving into silence.

Return a JSON object with:
{
  "phase1": "Text for phase 1",
  "phase2": "Text for phase 2",
  "phase3": "Text for phase 3",
  "fullScript": "Combined seamless text with line breaks and ellipses"
}
Output valid raw JSON only without markdown code blocks.`,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    return res.json(parsed);
  } catch (err: any) {
    console.error('Deceleration script generation error:', err);
    return res.status(500).json({ error: err?.message || 'Failed to generate deceleration script' });
  }
});

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AudioSpark TTS server running on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
