const DB_NAME = 'AudioSparkSessionsDB';
const STORE_NAME = 'sessions';
const CHUNK_AUDIO_STORE = 'chunk_audio_blobs';
const CURRENT_KEY = 'active_session';
const HISTORY_KEY = 'sessions_history_list';

// Synchronous localStorage emergency backup keys (Survives instant tab crash / refresh!)
const LS_EMERGENCY_META_KEY = 'audiospark_emergency_session_meta_v2';
const LS_EMERGENCY_HISTORY_KEY = 'audiospark_emergency_history_meta_v2';
const LS_USER_PREFS_KEY = 'audiospark_user_prefs_v2';

// Track which chunk audio bricks have already been written in this browser session to avoid redundant IDB writes
const writtenAudioBrickKeys = new Set<string>();

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
        return reject(new Error('IndexedDB unavailable'));
      }
      const timer = setTimeout(() => {
        reject(new Error('IndexedDB open timed out'));
      }, 1000);

      const req = indexedDB.open(DB_NAME, 2);
      req.onblocked = () => {
        clearTimeout(timer);
        reject(new Error('IndexedDB blocked'));
      };
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
          if (!db.objectStoreNames.contains(CHUNK_AUDIO_STORE)) {
            db.createObjectStore(CHUNK_AUDIO_STORE);
          }
        } catch {}
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error || new Error('IndexedDB request error'));
      };
    } catch (err) {
      reject(err);
    }
  });
}

export interface PersistedUserPrefs {
  selectedVoice?: string;
  acousticWarmth?: string;
  downloadPackageMode?: string;
  playbackRate?: number;
  limitMode?: 'auto' | 'words' | 'minutes';
  limitValue?: string;
  autoDownloadClips?: boolean;
  autoSaveToDrive?: boolean;
  draftPrompt?: string;
}

export function saveUserPreferences(prefs: PersistedUserPrefs): void {
  try {
    const existingRaw = localStorage.getItem(LS_USER_PREFS_KEY);
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    localStorage.setItem(LS_USER_PREFS_KEY, JSON.stringify({ ...existing, ...prefs }));
  } catch {}
}

export function loadUserPreferences(): PersistedUserPrefs {
  try {
    const raw = localStorage.getItem(LS_USER_PREFS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

/**
 * Strips heavy base64 audio from session metadata so synchronous localStorage, IndexedDB metadata,
 * and HTTP JSON payloads can save 100% of scripts, prompts, plans, and word counts in < 1ms without ever hitting OOM or quota!
 */
export function stripAudioForLightweightMeta(sessionData: any): any {
  if (!sessionData) return null;
  const lightChunks = Array.isArray(sessionData.completedChunks)
    ? sessionData.completedChunks.map((c: any) => ({
        id: c.id,
        title: c.title,
        wordCount: c.wordCount,
        text: c.text,
        customPrompt: c.customPrompt,
        hasAudioSaved: Boolean(c.audioBase64 || c.hasAudioSaved),
        driveLink: c.driveLink,
        audioUrl: c.audioUrl,
      }))
    : [];

  const copy = {
    ...sessionData,
    completedChunks: lightChunks,
  };
  delete copy.masterAudioBase64;
  return copy;
}

/**
 * Saves individual chunk audio base64 in its own dedicated IndexedDB key
 * so even 50+ clips never blow up a single object transaction or cause browser OOM crashes.
 */
export async function saveChunkAudioBricks(sessionId: string, chunks: any[]): Promise<void> {
  if (!Array.isArray(chunks) || chunks.length === 0) return;
  const toWrite = chunks.filter((c) => {
    if (!c || !c.id || !c.audioBase64) return false;
    const brickKey = `${sessionId}_chunk_${c.id}_${c.audioBase64.length}`;
    if (writtenAudioBrickKeys.has(brickKey)) return false;
    return true;
  });

  if (toWrite.length === 0) return;

  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(CHUNK_AUDIO_STORE, 'readwrite');
      const store = tx.objectStore(CHUNK_AUDIO_STORE);
      for (const c of toWrite) {
        store.put(c.audioBase64, `${sessionId}_chunk_${c.id}`);
        writtenAudioBrickKeys.add(`${sessionId}_chunk_${c.id}_${c.audioBase64.length}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {}
}

/**
 * Rehydrates audio state & URLs from dedicated IndexedDB audio bricks and server disk store.
 */
export async function rehydrateSessionAudioBricks(sessionData: any): Promise<any> {
  if (!sessionData || !Array.isArray(sessionData.completedChunks)) return sessionData;
  const sessionId = sessionData.id || 'session-assistant-1';
  let hydratedChunks = [...sessionData.completedChunks];

  // 1. Check local IndexedDB audio brick store
  try {
    const db = await openDB();
    hydratedChunks = await Promise.all(
      hydratedChunks.map(async (c: any) => {
        if (c.audioBase64) return { ...c, hasAudioSaved: true };
        return new Promise<any>((resolve) => {
          let resolved = false;
          const done = (val: any) => {
            if (!resolved) {
              resolved = true;
              resolve(val);
            }
          };
          const safetyTimer = setTimeout(() => done(c), 500);
          try {
            const tx = db.transaction(CHUNK_AUDIO_STORE, 'readonly');
            const store = tx.objectStore(CHUNK_AUDIO_STORE);
            const req = store.get(`${sessionId}_chunk_${c.id}`);
            req.onsuccess = () => {
              clearTimeout(safetyTimer);
              if (req.result) {
                done({ ...c, audioBase64: req.result, hasAudioSaved: true });
              } else {
                done(c);
              }
            };
            req.onerror = () => {
              clearTimeout(safetyTimer);
              done(c);
            };
          } catch {
            clearTimeout(safetyTimer);
            done(c);
          }
        });
      })
    );
  } catch {}

  // 2. Query server session metadata to detect audio chunks already stored on server disk
  try {
    const ctrl = new AbortController();
    const fetchTimer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`/api/session/load/${encodeURIComponent(sessionId)}`, { signal: ctrl.signal });
    clearTimeout(fetchTimer);
    if (res.ok) {
      const data = await res.json();
      const serverChunks: any[] = data?.session?.completedChunks || [];
      if (serverChunks.length > 0) {
        hydratedChunks = hydratedChunks.map((c: any) => {
          const sc = serverChunks.find((item: any) => item.id === c.id);
          const hasAudioOnServer = Boolean(sc?.hasAudioSaved || sc?.audioUrl);
          const audioUrl = c.audioUrl || sc?.audioUrl || (hasAudioOnServer ? `/api/session/chunk-audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(c.id)}` : undefined);
          return {
            ...c,
            text: c.text || sc?.text || '',
            title: c.title || sc?.title || `Clip ${c.id}`,
            wordCount: c.wordCount || sc?.wordCount || 0,
            hasAudioSaved: Boolean(c.audioBase64 || c.hasAudioSaved || hasAudioOnServer),
            audioUrl: c.audioUrl || audioUrl,
          };
        });
      }
    }
  } catch {}

  // 3. Ensure hasAudioSaved and audioUrl are valid for all completed clips
  hydratedChunks = hydratedChunks.map((c: any) => {
    const hasAudio = Boolean(c.audioBase64 || c.hasAudioSaved || c.audioUrl);
    const audioUrl = c.audioUrl || (hasAudio ? `/api/session/chunk-audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(c.id)}` : undefined);
    return {
      ...c,
      hasAudioSaved: hasAudio,
      audioUrl,
    };
  });

  return {
    ...sessionData,
    completedChunks: hydratedChunks,
  };
}

export async function fetchChunkAudioBase64(sessionId: string, chunkId: number | string): Promise<string | null> {
  try {
    const res = await fetch(`/api/session/chunk-audio-b64/${encodeURIComponent(sessionId)}/${encodeURIComponent(chunkId)}`);
    if (res.ok) {
      const data = await res.json();
      return data?.audioBase64 || null;
    }
  } catch {}
  return null;
}

export async function saveLocalSession(sessionData: any): Promise<void> {
  if (!sessionData) return;
  const sessionId = sessionData.id || 'session-assistant-1';
  const normalized = { ...sessionData, id: sessionId };
  const lightMeta = stripAudioForLightweightMeta(normalized);

  // LAYER 1: Instant Synchronous localStorage write of scripts + plan (0ms, crash-proof!)
  try {
    localStorage.setItem(LS_EMERGENCY_META_KEY, JSON.stringify(lightMeta));

    const rawHist = localStorage.getItem(LS_EMERGENCY_HISTORY_KEY);
    const histList: any[] = rawHist ? JSON.parse(rawHist) : [];
    const updatedLight = {
      ...lightMeta,
      updatedAt: new Date().toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    const nextLightHist = [updatedLight, ...histList.filter((item) => item.id !== sessionId)].slice(0, 30);
    localStorage.setItem(LS_EMERGENCY_HISTORY_KEY, JSON.stringify(nextLightHist));
  } catch (e) {
    console.warn('Emergency localStorage sync warning:', e);
  }

  // LAYER 2: Dedicated per-clip audio brick storage in IndexedDB (never rewrites unchanged clips!)
  await saveChunkAudioBricks(sessionId, normalized.completedChunks || []);

  // LAYER 3: Fast IndexedDB session metadata storage (keeps CURRENT_KEY & HISTORY_KEY lightweight to prevent browser OOM!)
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(lightMeta, CURRENT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await upsertSessionInHistory(lightMeta);
  } catch (err) {
    console.warn('IndexedDB save fallback:', err);
  }
}

export async function clearActiveLocalSession(): Promise<void> {
  try {
    localStorage.removeItem(LS_EMERGENCY_META_KEY);
  } catch {}
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(CURRENT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB clear active session fallback:', err);
  }
}

export async function loadLocalSession(): Promise<any | null> {
  let idbSession: any = null;
  try {
    const db = await openDB();
    idbSession = await new Promise<any>((resolve) => {
      const timer = setTimeout(() => resolve(null), 800);
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(CURRENT_KEY);
        req.onsuccess = () => {
          clearTimeout(timer);
          resolve(req.result || null);
        };
        req.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
  } catch (err) {
    console.warn('IndexedDB load fallback:', err);
  }

  // If legacy idbSession had inline audioBase64 in completedChunks, migrate those bricks to CHUNK_AUDIO_STORE
  if (idbSession?.completedChunks?.some((c: any) => c.audioBase64)) {
    await saveChunkAudioBricks(idbSession.id || 'session-assistant-1', idbSession.completedChunks);
  }

  // Also check synchronous localStorage emergency backup in case tab crashed mid-transaction
  let lsSession: any = null;
  try {
    const raw = localStorage.getItem(LS_EMERGENCY_META_KEY);
    if (raw) lsSession = JSON.parse(raw);
  } catch {}

  // Pick whichever has more completed script chunks!
  const idbCount = idbSession?.completedChunks?.length || 0;
  const lsCount = lsSession?.completedChunks?.length || 0;
  const chosen = lsCount > idbCount ? lsSession : idbSession || lsSession;

  if (!chosen) return null;
  return await rehydrateSessionAudioBricks(chosen);
}

export async function loadSessionsHistory(): Promise<any[]> {
  let idbList: any[] = [];
  try {
    const db = await openDB();
    idbList = await new Promise<any[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), 800);
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(HISTORY_KEY);
        req.onsuccess = () => {
          clearTimeout(timer);
          resolve(Array.isArray(req.result) ? req.result : []);
        };
        req.onerror = () => {
          clearTimeout(timer);
          resolve([]);
        };
      } catch {
        clearTimeout(timer);
        resolve([]);
      }
    });
  } catch {}

  let lsList: any[] = [];
  try {
    const raw = localStorage.getItem(LS_EMERGENCY_HISTORY_KEY);
    if (raw) lsList = JSON.parse(raw);
  } catch {}

  const mergedMap = new Map<string, any>();
  for (const item of [...idbList, ...lsList]) {
    if (!item || !item.id) continue;
    // Migrate any inline audioBase64 to brick storage
    if (item.completedChunks?.some((c: any) => c.audioBase64)) {
      await saveChunkAudioBricks(item.id, item.completedChunks);
    }
    const lightItem = stripAudioForLightweightMeta(item);
    const existing = mergedMap.get(lightItem.id);
    if (!existing || (lightItem.completedChunks?.length || 0) >= (existing.completedChunks?.length || 0)) {
      mergedMap.set(lightItem.id, lightItem);
    }
  }

  return Array.from(mergedMap.values());
}

export async function upsertSessionInHistory(sessionData: any): Promise<any[]> {
  try {
    const currentList = await loadSessionsHistory();
    const id = sessionData.id || 'default-session';
    const cleanCopy = stripAudioForLightweightMeta(sessionData);

    const updatedItem = {
      ...cleanCopy,
      id,
      updatedAt: new Date().toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    const filtered = currentList.filter((item) => item.id !== id);
    const nextList = [updatedItem, ...filtered].slice(0, 25);

    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(nextList, HISTORY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return nextList;
  } catch {
    return [];
  }
}

export async function deleteSessionFromHistory(sessionId: string): Promise<any[]> {
  fetch(`/api/session/delete/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
  try {
    const raw = localStorage.getItem(LS_EMERGENCY_HISTORY_KEY);
    if (raw) {
      const lsList: any[] = JSON.parse(raw);
      localStorage.setItem(
        LS_EMERGENCY_HISTORY_KEY,
        JSON.stringify(lsList.filter((item) => item.id !== sessionId))
      );
    }
  } catch {}

  try {
    const currentList = await loadSessionsHistory();
    const nextList = currentList.filter((item) => item.id !== sessionId);
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(nextList, HISTORY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return nextList;
  } catch {
    return [];
  }
}

/**
 * Export a session as a portable .json backup file so the user can save or restore across any browser/device.
 */
export function exportSessionBackupJson(sessionData: any, filenameSlug: string = 'sleep-project') {
  try {
    const jsonStr = JSON.stringify(sessionData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenameSlug}-recovery-backup.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    console.error('Failed to export backup JSON:', e);
  }
}
