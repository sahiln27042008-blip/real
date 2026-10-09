import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Download,
  RefreshCw,
  Copy,
  Check,
  RotateCcw,
  Send,
  AlertCircle,
  CheckCircle2,
  Archive,
  BookOpen,
  CheckCheck,
  Bot,
  User,
  ChevronDown,
  ChevronUp,
  FastForward,
  PlusCircle,
  History,
  Trash2,
  FileText,
  Volume2,
  VolumeX,
  Repeat,
  Upload,
  Sparkles,
  Edit3,
  Clock,
  ExternalLink,
  LogOut,
  FolderOpen,
} from 'lucide-react';
import { getScriptSlug } from './utils/fileNaming';
import { DownloadPackageMode } from './utils/zipExport';
import {
  softenSingleWavBase64,
  softenWavInWorker,
  splitRawScriptInto550To600WordClips,
  AcousticWarmthMode,
} from './utils/wavMerger';
import {
  saveLocalSession,
  saveChunkAudioBricks,
  clearActiveLocalSession,
  loadLocalSession,
  loadSessionsHistory,
  deleteSessionFromHistory,
  rehydrateSessionAudioBricks,
  loadLocalChunkAudioBase64,
  exportSessionBackupJson,
  stripAudioForLightweightMeta,
  saveUserPreferences,
  loadUserPreferences,
  hasActiveSessionClearMarker,
} from './utils/sessionStorage';
import {
  googleSignIn,
  logout as googleLogout,
  initAuth as initGoogleAuth,
  uploadBlobToGoogleDrive,
  uploadUrlToGoogleDrive,
} from './utils/googleDrive';
import type { User as FirebaseUser } from 'firebase/auth';

interface Voice {
  id: string;
  name: string;
  badge: string;
  tone: string;
}

const VOICES: Voice[] = [
  { id: 'Charon', name: 'Charon', badge: 'Deep Velvet Bass', tone: 'Deep, calm, unsharp, resonant' },
  { id: 'Aoede', name: 'Aoede', badge: 'Soft Tranquil Alto', tone: 'Ultra-gentle, warm, peaceful' },
  { id: 'Kore', name: 'Kore', badge: 'Warm Soothing Mezzo', tone: 'Soft, rounded, restful' },
  { id: 'Fenrir', name: 'Fenrir', badge: 'Warm Baritone', tone: 'Grounded, steady, mellow' },
  { id: 'Puck', name: 'Puck', badge: 'Gentle Tenor', tone: 'Softened, light, calm' },
];

interface CompletedChunk {
  id: number;
  title: string;
  wordCount: number;
  text: string;
  audioUrl?: string;
  audioBase64?: string;
  customPrompt?: string;
  hasAudioSaved?: boolean;
  driveLink?: string;
}

interface SubtopicItem {
  title: string;
  movement: string;
  targetWords: string;
  customPrompt?: string;
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  text?: string;
  userPrompt?: string;
  requestedTargetWords?: number;
  isProcessing?: boolean;
  statusText?: string;
  progressPercent?: number;
  plan?: {
    topic: string;
    targetWords: number;
    subtopics: SubtopicItem[];
  };
  completedChunks?: CompletedChunk[];
  masterAudioBase64?: string;
  masterAudioUrl?: string;
  fullScriptText?: string;
  slug?: string;
  masterDriveLink?: string;
  scriptDriveLink?: string;
  zipDriveLink?: string;
}

const INITIAL_PROMPT_PRESET = `Write a complete, long-form, deeply exhaustive scientific sleep narration script on: "Stellar Collapse, Degeneracy Pressure, and the Schwarzschild Metric."

Target length: Approximately 4,000 words (or set any word/time limit). Execute the complete narrative across the full 3-Tier Deceleration Model where every single generated segment is strictly 550 to 600 words until the target mark is reached:

1. Movement I: The Quiescent Pre-Collapse (Tier 1)
- Focus on the scale of an aging supergiant star in absolute equilibrium.
- Detail the millions of years of stable hydrostatic balance, where outward photon radiation pressure matches inward gravitational pull with zero haste.
- Establish an unhurried, quiet atmosphere of deep astronomical scale.

2. Movement II: Microscopic Resistance and Mechanical Exhaustion (Tier 2)
- Provide exhaustive, microscopic descriptions of nuclear fuel exhaustion: hydrogen to helium, carbon burning, silicon shells, up to inert iron-56 core formation.
- Delve deep into quantum mechanics: phase space lattices, the Pauli Exclusion Principle, electron degeneracy pressure, relativistic Fermi momentum, and the Chandrasekhar threshold.
- Describe inverse beta decay, neutronization, Tolman-Oppenheimer-Volkoff balance, and the asymptotic surrender of the core to gravity without drama or urgency.
- Linger on gravitational redshift, light-cone tipping, photon orbits at 1.5 Schwarzschild radii, Eddington-Finkelstein coordinates, and how space and time coordinates quietly invert across the event horizon.

3. Movement III: The Asymptotic Boundary and Eternal Rest (Tier 3)
- Shift into semantic dissolution and hypnagogic drift.
- Sentences become short, slow, and cyclical.
- Focus on static horizons, infinite time dilation for an external observer, redshifted photons stretching out toward infinite wavelength, absolute cold, vanishing momentum, and complete thermodynamic stillness.

Formatting requirements:
- Use double line breaks between sentences.
- Use frequent ellipses (...) within and between thoughts to force 2-to-4-second natural pauses for the Gemini Charon voice.
- Zero guided meditation, zero cozy fluff, no mentions of the listener's body, no exclamation marks.
- Output ONLY the spoken narration starting with the very first word.`;

function cleanErrorMessage(raw: any): string {
  const str = String(raw?.message || raw || '');
  if (str.includes("Unexpected token '<'") || str.includes('is not valid JSON') || str.includes('<html')) {
    return 'Processing in-memory to bypass proxy limits. Your files and progress are safe.';
  }
  try {
    if (str.includes('{') && str.includes('}')) {
      const match = str.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed?.error?.message) return parsed.error.message;
        if (parsed?.error) return typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
        if (parsed?.message) return parsed.message;
      }
    }
  } catch {}
  return str;
}

function triggerSingleWavDownload(audioUrl: string, filename: string) {
  try {
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    console.warn('Auto-download clip warning:', e);
  }
}

function triggerTextFileDownload(textContent: string, filename: string) {
  try {
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    console.warn('Script download warning:', e);
  }
}

class CrashShieldErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMsg: '' };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorMsg: String(error?.message || error || 'Unexpected UI error') };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 font-sans">
          <div className="max-w-md w-full bg-slate-900 border border-cyan-500/40 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
              <AlertCircle className="w-5 h-5" />
              <span>Crash-Shield Recovery Activated</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Your scripts, clips, and project progress are safely stored in the triple-backed vault. Click below to reload and resume immediately.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  this.setState({ hasError: false, errorMsg: '' });
                  window.location.reload();
                }}
                className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl text-xs cursor-pointer"
              >
                Recover & Reload Studio
              </button>
              <button
                type="button"
                onClick={async () => {
                  const sess = await loadLocalSession();
                  if (sess) exportSessionBackupJson(sess, 'emergency-recovery');
                }}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 font-semibold rounded-xl text-xs cursor-pointer"
              >
                Download Emergency Backup (.json)
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const GoogleIcon = () => (
  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 48 48">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

const GoogleDriveLogo = () => (
  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 87.3 78">
    <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
    <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
    <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
    <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.25z" fill="#00832d"/>
    <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#26842a"/>
    <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
  </svg>
);

export function AppContent() {
  const savedPrefs = loadUserPreferences();

  const [inputPrompt, setInputPrompt] = useState<string>(savedPrefs.draftPrompt ?? INITIAL_PROMPT_PRESET);
  const [selectedVoice, setSelectedVoice] = useState<string>(savedPrefs.selectedVoice || 'Charon');

  // Acoustic Warmth & Anti-Sharpness DSP Mode ('velvet' | 'deep_warmth' | 'natural')
  const [acousticWarmth, setAcousticWarmth] = useState<AcousticWarmthMode>(
    (savedPrefs.acousticWarmth as AcousticWarmthMode) || 'velvet'
  );

  // Download Package Format Mode:
  const [downloadPackageMode, setDownloadPackageMode] = useState<DownloadPackageMode>(
    (savedPrefs.downloadPackageMode as DownloadPackageMode) || 'both_parts_and_master'
  );

  // Word or Time Limit input (optional override; if left in 'auto', reads from prompt)
  const [limitMode, setLimitMode] = useState<'auto' | 'words' | 'minutes'>(savedPrefs.limitMode || 'auto');
  const [limitValue, setLimitValue] = useState<string>(savedPrefs.limitValue || '4000');
  const [autoDownloadClips, setAutoDownloadClips] = useState<boolean>(savedPrefs.autoDownloadClips ?? false);

  // Google Drive Direct Cloud Storage State
  const [driveUser, setDriveUser] = useState<FirebaseUser | null>(null);
  const [isConnectingDrive, setIsConnectingDrive] = useState<boolean>(false);
  const [autoSaveToDrive, setAutoSaveToDrive] = useState<boolean>(savedPrefs.autoSaveToDrive ?? true);
  const [driveUploadingChunkId, setDriveUploadingChunkId] = useState<number | null>(null);
  const [driveUploadingAction, setDriveUploadingAction] = useState<string | null>(null);
  const [driveSuccessToast, setDriveSuccessToast] = useState<{ message: string; link?: string } | null>(null);
  const [driveSaveStatus, setDriveSaveStatus] = useState<string>('Drive not connected');

  // Mandatory confirmation dialog for Workspace mutations
  const [driveConfirmModal, setDriveConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    description: string;
    filename: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  // Input Mode: 'ai_prompt' or 'paste_script'
  const [inputMode, setInputMode] = useState<'ai_prompt' | 'paste_script'>('ai_prompt');
  // Inter-clip silence gap in seconds when merging Master WAV
  const [interClipPauseSec, setInterClipPauseSec] = useState<number>(1.5);
  // Inline editing buffer for individual clip scripts
  const [editingChunkTextMap, setEditingChunkTextMap] = useState<Record<string, string>>({});
  const [isTestingVoice, setIsTestingVoice] = useState<boolean>(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedScriptId, setExpandedScriptId] = useState<string | null>(null);
  const [expandedChunkTextId, setExpandedChunkTextId] = useState<string | null>(null);

  // "More Clips by New Prompt" state per message
  const [morePromptMap, setMorePromptMap] = useState<Record<string, string>>({});
  const [moreWordsMap, setMoreWordsMap] = useState<Record<string, string>>({});
  const [showMoreBoxMap, setShowMoreBoxMap] = useState<Record<string, boolean>>({});

  // History Drawer
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [historyList, setHistoryList] = useState<any[]>([]);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<string>('Ready');

  // Audio Playback & Baked-In WAV Speed
  const [activeAudioSrc, setActiveAudioSrc] = useState<string | null>(null);
  const [activeAudioLabel, setActiveAudioLabel] = useState<string>('Master Audio');
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(savedPrefs.playbackRate ?? 0.96);
  const [volume, setVolume] = useState<number>(1.0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isLooping, setIsLooping] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Listen to Google Auth state
  useEffect(() => {
    const unsub = initGoogleAuth(
      (user) => setDriveUser(user),
      () => setDriveUser(null)
    );
    return () => unsub();
  }, []);

  // Debounced auto-save of user controls & draft prompt so typing is silky smooth
  useEffect(() => {
    const timer = setTimeout(() => {
      saveUserPreferences({
        selectedVoice,
        acousticWarmth,
        downloadPackageMode,
        playbackRate,
        limitMode,
        limitValue,
        autoDownloadClips,
        autoSaveToDrive,
        draftPrompt: inputPrompt,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [
    selectedVoice,
    acousticWarmth,
    downloadPackageMode,
    playbackRate,
    limitMode,
    limitValue,
    autoDownloadClips,
    autoSaveToDrive,
    inputPrompt,
  ]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopRequestedRef = useRef<boolean>(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const backupFileInputRef = useRef<HTMLInputElement | null>(null);
  const txtScriptInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  const isChunkAudioReady = (c: any): boolean =>
    Boolean(c && (c.audioBase64 || c.hasAudioSaved || c.audioUrl));

  // Warn before accidental tab close & acquire Screen Wake Lock while actively generating
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isBusy) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    let wakeLock: any = null;
    if (isBusy && 'wakeLock' in navigator) {
      (navigator as any).wakeLock
        .request('screen')
        .then((lock: any) => {
          wakeLock = lock;
        })
        .catch(() => {});
    }

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
    };
  }, [isBusy]);

  const reconstructChunkAudioUrls = (
    chunks: CompletedChunk[],
    _warmth: AcousticWarmthMode = acousticWarmth,
    _speed: number = playbackRate,
    sessionId?: string
  ): CompletedChunk[] => {
    return chunks.map((chunk) => {
      if ((chunk as any).serverAudioAvailable && sessionId) {
        return {
          ...chunk,
          audioUrl: `/api/session/chunk-audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(chunk.id)}`,
        };
      }
      return { ...chunk, audioUrl: undefined };
    });
  };

  const refreshHistory = async () => {
    const list = await loadSessionsHistory();
    setHistoryList(list);
  };

  const convertSessionToMessages = (sess: any): ChatMessage[] => {
    const assistantMsgId = sess.id || 'session-assistant-1';
    const chunksWithUrls = reconstructChunkAudioUrls(
      sess.completedChunks || [],
      acousticWarmth,
      playbackRate,
      assistantMsgId
    );
    const userMsgId = sess.userMsgId || `user-${assistantMsgId}`;
    const totalWordsSoFar = chunksWithUrls.reduce((acc, c) => acc + (c.wordCount || 0), 0);
    const targetWords = sess.targetWords || (sess.subtopics?.length ? sess.subtopics.length * 575 : 4000);
    const pendingAudioCount = chunksWithUrls.filter(
      (c) => !c.audioBase64 && !(c as any).hasAudioSaved && !c.audioUrl
    ).length;

    const autoMasterUrl = chunksWithUrls.some((c) => (c as any).serverAudioAvailable || c.audioUrl?.startsWith('/api/session/chunk-audio/'))
      ? `/api/session/master-audio/${encodeURIComponent(assistantMsgId)}?gap=${encodeURIComponent(interClipPauseSec)}`
      : undefined;

    let statusText = `Saved (${totalWordsSoFar.toLocaleString()} / ${targetWords.toLocaleString()} words across ${chunksWithUrls.length} clips). Ready to resume.`;
    if (pendingAudioCount > 0) {
      statusText = `${chunksWithUrls.length} script clips saved (${pendingAudioCount} audio pending)! Click "Synthesize Pending Audio" or "Resume Generation".`;
    } else if (!sess.subtopics || sess.subtopics.length === 0) {
      statusText = `Prompt saved! Click Resume to generate 550–600 word segments.`;
    } else if (totalWordsSoFar >= targetWords && pendingAudioCount === 0) {
      statusText = `Complete! All ${chunksWithUrls.length} clips (${totalWordsSoFar.toLocaleString()} words) synthesized & ready to play or download.`;
    }

    const fullScript = sess.fullCombinedScript || chunksWithUrls.map((c) => c.text).join('\n\n');

    return [
      {
        id: userMsgId,
        sender: 'user',
        timestamp: sess.updatedAt || 'Saved Session',
        text: sess.userPrompt || INITIAL_PROMPT_PRESET,
      },
      {
        id: assistantMsgId,
        sender: 'assistant',
        timestamp: sess.updatedAt || 'In Progress',
        userPrompt: sess.userPrompt || INITIAL_PROMPT_PRESET,
        requestedTargetWords: targetWords,
        isProcessing: false,
        statusText,
        progressPercent: Math.min(100, Math.round((totalWordsSoFar / Math.max(1, targetWords)) * 100)),
        plan: sess.subtopics?.length
          ? {
              topic: sess.topic || 'Scientific Sleep Narration',
              targetWords,
              subtopics: sess.subtopics,
            }
          : undefined,
        completedChunks: chunksWithUrls,
        fullScriptText: fullScript,
        masterAudioUrl: autoMasterUrl,
        slug: getScriptSlug(sess.topic || fullScript || 'sleep-narration', 4),
      },
    ];
  };

  // Load saved session & history on initial mount (Picks the most complete version across Server, IndexedDB & localStorage!)
  useEffect(() => {
    const init = async () => {
      try {
        const localSessionWasCleared = hasActiveSessionClearMarker();
        const localHistory = await loadSessionsHistory();
        let combinedHistory = [...localHistory];
        let serverSess: any = null;
        let serverSessionWasCleared = false;

        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 3000);
          const res = await fetch('/api/session/current', { signal: ctrl.signal });
          clearTimeout(timer);
          const data = await res.json();
          serverSessionWasCleared = Boolean(data?.activeSessionCleared);
          if (Array.isArray(data?.history) && data.history.length > 0) {
            const existingIds = new Set(combinedHistory.map((h) => h.id));
            for (const hItem of data.history) {
              if (hItem && hItem.id && !existingIds.has(hItem.id)) {
                combinedHistory.push(hItem);
              }
            }
          }
          if (!serverSessionWasCleared && data?.session && (data.session.completedChunks?.length > 0 || data.session.userPrompt)) {
            serverSess = data.session;
          }
        } catch {}

        const localSess = await loadLocalSession();

        // Compare serverSess and localSess and pick whichever has MORE completed chunks / audio!
        const serverCount = serverSess?.completedChunks?.length || 0;
        const localCount = localSess?.completedChunks?.length || 0;
        const activeSessionWasCleared = localSessionWasCleared || serverSessionWasCleared;
        let sess: any = activeSessionWasCleared
          ? null
          : localCount >= serverCount
            ? localSess || serverSess
            : serverSess || localSess;

        // Recover from history only when active-session storage disappeared unexpectedly.
        if (!activeSessionWasCleared && !sess && combinedHistory.length > 0) {
          const bestHistoryItem =
            combinedHistory.find((h) => h.completedChunks && h.completedChunks.length > 0) ||
            combinedHistory[0];
          if (bestHistoryItem) {
            sess = bestHistoryItem;
          }
        }

        if (sess) {
          sess = await rehydrateSessionAudioBricks(sess);
        }

        setHistoryList(combinedHistory);

        if (sess) {
          setMessages(convertSessionToMessages(sess));
          if (sess.selectedVoice) setSelectedVoice(sess.selectedVoice);
          await saveLocalSession({ ...sess, id: sess.id || 'session-assistant-1' });
          await refreshHistory();
          const lightSess = stripAudioForLightweightMeta({ ...sess, id: sess.id || 'session-assistant-1' });
          fetch('/api/session/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: lightSess }),
          }).catch(() => {});
          setLastAutoSavedAt(
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          );
        }
      } catch (err) {
        console.error('Failed to load session:', err);
      }
    };

    init();
  }, []);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const persistSessionState = async (payload: {
    id: string;
    userPrompt: string;
    topic: string;
    targetWords: number;
    subtopics: SubtopicItem[];
    completedChunks: CompletedChunk[];
    fullCombinedScript: string;
    selectedVoice: string;
    masterAudioBase64?: string;
    isComplete?: boolean;
  }) => {
    const cleanChunks = payload.completedChunks.map((c) => ({
      id: c.id,
      title: c.title,
      wordCount: c.wordCount,
      text: c.text,
      audioBase64: undefined, // Keep memory lean and clean (< 50KB)
      hasAudioSaved: Boolean(c.hasAudioSaved || c.audioUrl || c.audioBase64),
      customPrompt: c.customPrompt,
      driveLink: c.driveLink,
    }));

    const sessionObj = {
      ...payload,
      completedChunks: cleanChunks,
    };

    await saveLocalSession(sessionObj);
    if (payload.isComplete) {
      await refreshHistory();
    }
    setLastAutoSavedAt(
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    );

    // Send lightweight metadata (< 50KB) to /api/session/save so browser & server never OOM on large sessions
    const lightSession = stripAudioForLightweightMeta(sessionObj);
    fetch('/api/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: lightSession }),
    }).catch(() => {});
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const handleAudioSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setCurrentTime(val);
    if (audioRef.current) audioRef.current.currentTime = val;
  };

  const toggleAudioPlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const handlePlayChunkAudio = async (sessionId: string, chunk: CompletedChunk) => {
    let audioUrl = chunk.audioUrl;
    if (!audioUrl && ((chunk as any).localAudioAvailable || chunk.hasAudioSaved)) {
      const localAudio = await loadLocalChunkAudioBase64(sessionId, chunk.id);
      if (localAudio) {
        audioUrl = URL.createObjectURL(new Blob([localAudio], { type: 'audio/wav' }));
      }
    }
    if (!audioUrl) {
      setError(`Clip ${chunk.id} audio is not available in server storage or this browser.`);
      return;
    }

    setActiveAudioLabel(`Clip ${chunk.id} (${chunk.wordCount}w)`);
    setActiveAudioSrc(audioUrl);
    setTimeout(() => {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
      }
    }, 100);
  };

  const rebuildAllMessagesAudioForSettings = (
    _warmth: AcousticWarmthMode,
    _speed: number,
    gapSeconds: number
  ) => {
    setMessages((previous) =>
      previous.map((message) =>
        message.completedChunks?.some((chunk) => isChunkAudioReady(chunk))
          ? {
              ...message,
              masterAudioUrl: `/api/session/master-audio/${encodeURIComponent(message.id)}?gap=${encodeURIComponent(gapSeconds)}`,
            }
          : message
      )
    );
  };

  const changeSpeed = (rate: number) => {
    setPlaybackRate(rate);
  };

  const skipAudioSeconds = (deltaSeconds: number) => {
    if (!audioRef.current) return;
    const next = Math.max(0, Math.min(duration || 999999, audioRef.current.currentTime + deltaSeconds));
    audioRef.current.currentTime = next;
    setCurrentTime(next);
  };

  const handleTestVoiceSample = async () => {
    if (isBusy || isTestingVoice) return;
    setIsTestingVoice(true);
    setError(null);
    try {
      const sampleText =
        'Across millions of years... hydrostatic equilibrium holds the stellar core in quiet, unhurried balance... where outward photon pressure meets inward gravity in deep stillness.';
      const res = await fetch('/api/tts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'single',
          text: sampleText,
          voiceName: selectedVoice,
          style:
            'Voice Persona: A deeply calm, peaceful, velvet-voiced bedtime narrator speaking softly in a quiet room late at night. ' +
            'Tone: Ultra-soft, unsharp, warm, rounded, gentle, soothing, and completely unhurried.',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.audioBase64) {
        throw new Error(data?.error || 'Voice sample failed');
      }
      const softened = softenSingleWavBase64(data.audioBase64, acousticWarmth, playbackRate);
      setActiveAudioLabel(`Voice Sample (${selectedVoice} · ${playbackRate.toFixed(2)}x)`);
      setActiveAudioSrc(softened.blobUrl);
      setTimeout(() => {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          audioRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
        }
      }, 100);
    } catch (e: any) {
      setError(cleanErrorMessage(e));
    } finally {
      setIsTestingVoice(false);
    }
  };

  const computeEffectiveTargetWords = (): number | undefined => {
    if (limitMode === 'words') {
      const w = parseInt(limitValue, 10);
      if (!isNaN(w) && w >= 500) return w;
    } else if (limitMode === 'minutes') {
      const m = parseFloat(limitValue);
      if (!isNaN(m) && m >= 5) return Math.round(m * 75); // ~75 words/min for slow sleep narration
    }
    return undefined;
  };

  // =========================================================================
  // SYNTHESIZE AUDIO FOR A SINGLE CHUNK (Used by pipeline & single-chunk retry)
  // =========================================================================
  const synthesizeChunkAudio = async (
    assistantMsgId: string,
    partNum: number,
    sectionText: string,
    sectionWords: number,
    topicSlug: string
  ): Promise<{ audioUrl: string; driveLink?: string }> => {
    let ttsData: any = null;
    let attempts = 0;
    const maxAttempts = 8;

    while (attempts < maxAttempts && !stopRequestedRef.current) {
      attempts++;
      const ttsRes = await fetch('/api/tts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'single',
          text: sectionText,
          voiceName: selectedVoice,
          style:
            'Voice Persona: A deeply calm, peaceful, velvet-voiced bedtime narrator speaking softly in a quiet room late at night. ' +
            'Tone: Ultra-soft, unsharp, warm, rounded, gentle, soothing, and completely unhurried. ' +
            'Delivery Constraints: Zero harsh consonants, zero sharp sibilance, zero vocal tension or metallic edge. ' +
            'Blend words smoothly with soft open vowels and gentle breath transitions. Treat ellipses (...) as 2-to-4-second peaceful pauses.',
        }),
      });

      ttsData = await ttsRes.json();

      if (ttsRes.status === 429 || ttsData?.isRateLimit) {
        let delay = ttsData?.retryDelaySeconds || 35;
        while (delay > 0 && !stopRequestedRef.current) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    statusText: `Quota cooling down for Clip ${partNum} audio: auto-resuming in ${delay}s (Script is safely saved)...`,
                  }
                : msg
            )
          );
          await new Promise((r) => setTimeout(r, 1000));
          delay--;
        }
        continue;
      }

      if (
        ttsRes.status === 503 ||
        ttsData?.is503 ||
        String(ttsData?.error || '').includes('503') ||
        String(ttsData?.error || '').includes('high demand')
      ) {
        let delay = 6 * attempts;
        while (delay > 0 && !stopRequestedRef.current) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    statusText: `API busy during Clip ${partNum} audio. Waiting for capacity (${delay}s remaining, attempt ${attempts}/${maxAttempts})...`,
                  }
                : msg
            )
          );
          await new Promise((r) => setTimeout(r, 1000));
          delay--;
        }
        continue;
      }

      if (!ttsRes.ok) {
        if (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 3000 * attempts));
          continue;
        }
        throw new Error(ttsData?.error || `TTS synthesis failed for Clip ${partNum} (Script is saved — click Resume to retry audio)`);
      }
      break;
    }

    if (!ttsData || !ttsData.audioBase64) {
      throw new Error(`Audio synthesis paused for Clip ${partNum}. Your 550–600w script is saved! Click Resume to synthesize audio.`);
    }

    const processedAudio = await softenWavInWorker(ttsData.audioBase64, acousticWarmth, playbackRate);
    let audioUrl: string | undefined;
    let driveLink: string | undefined;
    let serverSaved = false;
    let localSaved = false;

    try {
      const serverSave = await fetch('/api/session/save-chunk-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: assistantMsgId,
          chunkId: partNum,
          audioBase64: processedAudio.audioBase64,
        }),
      });
      if (!serverSave.ok) throw new Error(`Server audio save failed (${serverSave.status})`);
      const result = await serverSave.json();
      if (!result?.success) throw new Error('Server did not confirm audio save');
      serverSaved = true;
    } catch (saveError: any) {
      setDriveSaveStatus(`Clip ${partNum} server backup failed; trying browser backup`);
    }

    localSaved = await saveChunkAudioBricks(assistantMsgId, [{ id: partNum, audioBase64: processedAudio.audioBase64 }]);
    if (!serverSaved && !localSaved) {
      throw new Error(`Clip ${partNum} audio could not be saved to server or browser storage.`);
    }
    if (serverSaved) {
      audioUrl = `/api/session/chunk-audio/${encodeURIComponent(assistantMsgId)}/${encodeURIComponent(partNum)}`;
    } else {
      audioUrl = processedAudio.blobUrl;
    }

    if (autoSaveToDrive) {
      if (!driveUser) {
        setDriveSaveStatus(`Clip ${partNum} is backed up locally; connect Drive for cloud backup`);
      } else {
        setDriveUploadingChunkId(partNum);
        setDriveSaveStatus(`Uploading Clip ${partNum} to Google Drive...`);
        try {
          const upload = await uploadBlobToGoogleDrive({
            filename: `${topicSlug}-clip-${String(partNum).padStart(2, '0')}.wav`,
            blob: processedAudio.blob,
            mimeType: 'audio/wav',
            description: `AudioSpark generated clip ${partNum} for session ${assistantMsgId}`,
          });
          driveLink = upload.webViewLink || `https://drive.google.com/open?id=${upload.id}`;
          setDriveSaveStatus(`Clip ${partNum} backed up to Google Drive`);
        } catch (uploadError: any) {
          setDriveSaveStatus(`Clip ${partNum} Drive upload failed: ${uploadError?.message || 'unknown error'}`);
          stopRequestedRef.current = true;
        } finally {
          setDriveUploadingChunkId(null);
        }
      }
    }

    if (autoDownloadClips && downloadPackageMode !== 'single_master_wav') {
      const padded = String(partNum).padStart(2, '0');
      triggerSingleWavDownload(audioUrl, `${padded}-${topicSlug}-clip-${partNum}.wav`);
    }

    return { audioUrl, driveLink };
  };

  // =========================================================================
  // RE-SYNTHESIZE A SINGLE CLIP'S AUDIO ON DEMAND
  // =========================================================================
  const handleResynthesizeSingleClip = async (msgId: string, chunkId: number) => {
    if (isBusy) return;
    const targetMsg = messages.find((m) => m.id === msgId);
    if (!targetMsg || !targetMsg.completedChunks) return;
    const chunk = targetMsg.completedChunks.find((c) => c.id === chunkId);
    if (!chunk || !chunk.text) return;

    setIsBusy(true);
    stopRequestedRef.current = false;
    setError(null);

    try {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                isProcessing: true,
                statusText: `Re-synthesizing Clip ${chunkId} audio (${selectedVoice} · ${playbackRate.toFixed(2)}x)...`,
              }
            : m
        )
      );

      const topicSlug = getScriptSlug(targetMsg.plan?.topic || 'sleep-science', 4);
      const { audioUrl, driveLink } = await synthesizeChunkAudio(
        msgId,
        chunk.id,
        chunk.text,
        chunk.wordCount,
        topicSlug
      );

      const updatedChunks = targetMsg.completedChunks.map((c) =>
        c.id === chunkId ? { ...c, audioBase64: undefined, audioUrl, driveLink, hasAudioSaved: true } : c
      );
      const fullCombinedScript = updatedChunks.map((c) => c.text).join('\n\n');

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                isProcessing: false,
                completedChunks: updatedChunks,
                statusText: `Clip ${chunkId} audio re-synthesized & saved!`,
              }
            : m
        )
      );

      await persistSessionState({
        id: msgId,
        userPrompt: targetMsg.userPrompt || INITIAL_PROMPT_PRESET,
        topic: targetMsg.plan?.topic || 'Scientific Sleep Narration',
        targetWords: targetMsg.plan?.targetWords || 4000,
        subtopics: targetMsg.plan?.subtopics || [],
        completedChunks: updatedChunks,
        fullCombinedScript,
        selectedVoice,
      });
    } catch (e: any) {
      setError(cleanErrorMessage(e));
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, isProcessing: false } : m))
      );
    } finally {
      setIsBusy(false);
    }
  };

  // =========================================================================
  // SAVE EDITED CLIP SCRIPT & OPTIONALLY RE-SYNTHESIZE AUDIO
  // =========================================================================
  const handleSaveEditedClipScript = async (
    msgId: string,
    chunkId: number,
    newText: string,
    resynthesizeAudioNow: boolean
  ) => {
    if (isBusy || !newText.trim()) return;
    const targetMsg = messages.find((m) => m.id === msgId);
    if (!targetMsg || !targetMsg.completedChunks) return;

    const cleanedText = newText.trim();
    const newWordCount = cleanedText.split(/\s+/).filter(Boolean).length;

    const updatedChunks = targetMsg.completedChunks.map((c) =>
      c.id === chunkId ? { ...c, text: cleanedText, wordCount: newWordCount } : c
    );
    const fullCombinedScript = updatedChunks.map((c) => c.text).join('\n\n');

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              completedChunks: updatedChunks,
              fullScriptText: fullCombinedScript,
              statusText: `Clip ${chunkId} script updated (${newWordCount} words).`,
            }
          : m
      )
    );

    await persistSessionState({
      id: msgId,
      userPrompt: targetMsg.userPrompt || INITIAL_PROMPT_PRESET,
      topic: targetMsg.plan?.topic || 'Scientific Sleep Narration',
      targetWords: targetMsg.plan?.targetWords || 4000,
      subtopics: targetMsg.plan?.subtopics || [],
      completedChunks: updatedChunks,
      fullCombinedScript,
      selectedVoice,
    });

    if (resynthesizeAudioNow) {
      await handleResynthesizeSingleClip(msgId, chunkId);
    }
  };

  // =========================================================================
  // REGENERATE A SINGLE CLIP'S SCRIPT (AI) + AUDIO
  // =========================================================================
  const handleRegenerateSingleClipScript = async (msgId: string, chunkId: number) => {
    if (isBusy) return;
    const targetMsg = messages.find((m) => m.id === msgId);
    if (!targetMsg || !targetMsg.completedChunks) return;
    const chunkIndex = targetMsg.completedChunks.findIndex((c) => c.id === chunkId);
    if (chunkIndex === -1) return;
    const chunk = targetMsg.completedChunks[chunkIndex];

    setIsBusy(true);
    stopRequestedRef.current = false;
    setError(null);

    try {
      const topic = targetMsg.plan?.topic || 'Scientific Sleep Narration';
      const prevContext =
        chunkIndex > 0 ? targetMsg.completedChunks[chunkIndex - 1].text.slice(-300) : '';

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                isProcessing: true,
                statusText: `Regenerating 550–600w script for Clip ${chunkId} (${chunk.title})...`,
              }
            : m
        )
      );

      const secRes = await fetch('/api/script/generate-subtopic-section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          subtopic: chunk.title,
          sectionIndex: chunk.id,
          totalSections: Math.max(targetMsg.completedChunks.length, 7),
          previousContext: prevContext,
          customPrompt: chunk.customPrompt || '',
        }),
      });
      const secData = await secRes.json();
      if (!secRes.ok || !secData?.sectionText) {
        throw new Error(secData?.error || `Failed to regenerate script for Clip ${chunkId}`);
      }

      const newText = secData.sectionText;
      const newWords = secData.wordCount || newText.split(/\s+/).filter(Boolean).length;
      const topicSlug = getScriptSlug(topic, 4);

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                statusText: `Clip ${chunkId} new script ready (${newWords}w)! Synthesizing audio...`,
              }
            : m
        )
      );

      const { audioUrl, driveLink } = await synthesizeChunkAudio(
        msgId,
        chunk.id,
        newText,
        newWords,
        topicSlug
      );

      const updatedChunks = targetMsg.completedChunks.map((c) =>
        c.id === chunkId
          ? { ...c, text: newText, wordCount: newWords, audioBase64: undefined, audioUrl, driveLink, hasAudioSaved: true }
          : c
      );
      const fullCombinedScript = updatedChunks.map((c) => c.text).join('\n\n');

      setEditingChunkTextMap((prev) => ({
        ...prev,
        [`${msgId}-chunk-${chunkId}`]: newText,
      }));

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                isProcessing: false,
                completedChunks: updatedChunks,
                fullScriptText: fullCombinedScript,
                statusText: `Clip ${chunkId} script & audio regenerated (${newWords} words)!`,
              }
            : m
        )
      );

      await persistSessionState({
        id: msgId,
        userPrompt: targetMsg.userPrompt || INITIAL_PROMPT_PRESET,
        topic,
        targetWords: targetMsg.plan?.targetWords || 4000,
        subtopics: targetMsg.plan?.subtopics || [],
        completedChunks: updatedChunks,
        fullCombinedScript,
        selectedVoice,
      });
    } catch (e: any) {
      setError(cleanErrorMessage(e));
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, isProcessing: false } : m))
      );
    } finally {
      setIsBusy(false);
    }
  };

  // =========================================================================
  // DELETE A SINGLE CLIP FROM PROJECT
  // =========================================================================
  const handleDeleteSingleClip = async (msgId: string, chunkId: number) => {
    if (isBusy) return;
    const targetMsg = messages.find((m) => m.id === msgId);
    if (!targetMsg || !targetMsg.completedChunks) return;

    const remaining = targetMsg.completedChunks
      .filter((c) => c.id !== chunkId)
      .map((c, idx) => ({ ...c, id: idx + 1 }));
    const fullCombinedScript = remaining.map((c) => c.text).join('\n\n');

    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              completedChunks: remaining,
              fullScriptText: fullCombinedScript,
              statusText: `Deleted Clip ${chunkId}. ${remaining.length} clips remaining.`,
            }
          : m
      )
    );

    await persistSessionState({
      id: msgId,
      userPrompt: targetMsg.userPrompt || INITIAL_PROMPT_PRESET,
      topic: targetMsg.plan?.topic || 'Scientific Sleep Narration',
      targetWords: targetMsg.plan?.targetWords || 4000,
      subtopics: targetMsg.plan?.subtopics || [],
      completedChunks: remaining,
      fullCombinedScript,
      selectedVoice,
    });
  };

  // =========================================================================
  // CORE GENERATION PIPELINE:
  // Generates 550–600 word segments continuously until targetWords is reached
  // (whether that takes 4 segments or 400 segments!).
  // Also first finishes any saved segment whose script is ready but audio is pending!
  // =========================================================================
  const runGenerationPipeline = async (
    assistantMsgId: string,
    userPrompt: string,
    topic: string,
    targetWords: number,
    initialSubtopics: SubtopicItem[],
    initialChunks: CompletedChunk[]
  ) => {
    setIsBusy(true);
    stopRequestedRef.current = false;
    setError(null);

    const generatedChunks: CompletedChunk[] = [...initialChunks];
    const subtopicsList: SubtopicItem[] = [...initialSubtopics];
    const topicSlug = getScriptSlug(topic || 'sleep-science', 4);

    try {
      // STEP 1: Check if any existing chunk has script generated but audio NOT done yet!
      for (let idx = 0; idx < generatedChunks.length; idx++) {
        if (stopRequestedRef.current) break;
        const existing = generatedChunks[idx];
        const isAudioAlreadyDone = Boolean(
          existing.audioBase64 || (existing as any).hasAudioSaved || existing.audioUrl
        );
        if (existing.text && !isAudioAlreadyDone) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    isProcessing: true,
                    statusText: `Synthesizing pending audio for saved Clip ${existing.id} (${existing.wordCount} words)...`,
                  }
                : msg
            )
          );

          const { audioUrl, driveLink } = await synthesizeChunkAudio(
            assistantMsgId,
            existing.id,
            existing.text,
            existing.wordCount,
            topicSlug
          );

          generatedChunks[idx] = {
            ...existing,
            audioBase64: undefined, // Audio brick is safely on disk & IndexedDB
            audioUrl,
            driveLink,
            hasAudioSaved: true,
          };

          const fullCombinedScript = generatedChunks.map((c) => c.text).join('\n\n');
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    completedChunks: [...generatedChunks],
                    fullScriptText: fullCombinedScript,
                  }
                : msg
            )
          );

          await persistSessionState({
            id: assistantMsgId,
            userPrompt,
            topic,
            targetWords,
            subtopics: subtopicsList,
            completedChunks: generatedChunks,
            fullCombinedScript,
            selectedVoice,
          });
        }
      }

      // STEP 2: Keep generating 550–600 word segments until cumulativeWords >= targetWords
      // OR until all explicitly queued subtopics (from "Generate More Clips") are finished!
      let cumulativeWords = generatedChunks.reduce((sum, c) => sum + (c.wordCount || 0), 0);

      while (
        !stopRequestedRef.current &&
        (cumulativeWords < targetWords || generatedChunks.length < subtopicsList.length)
      ) {
        const i = generatedChunks.length;
        const partNum = i + 1;

        // If we need more segments beyond subtopicsList to hit targetWords, dynamically add a continuation subtopic
        if (i >= subtopicsList.length) {
          const isNearEnd = cumulativeWords + 600 >= targetWords;
          const movement = isNearEnd ? 'Movement III' : 'Movement II';
          subtopicsList.push({
            title: `${movement}: Deep Systematic Continuation & Equilibrium (Segment ${partNum})`,
            movement,
            targetWords: '550-600 words',
          });
        }

        const sub = subtopicsList[i];
        const progressPercent = Math.min(
          90,
          Math.max(8, Math.round((cumulativeWords / Math.max(1, targetWords)) * 88))
        );

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  isProcessing: true,
                  statusText: `Writing Clip ${partNum} (Strictly 550–600 words) · Progress: ${cumulativeWords.toLocaleString()} / ${targetWords.toLocaleString()} words...`,
                  progressPercent,
                  plan: {
                    topic,
                    targetWords,
                    subtopics: [...subtopicsList],
                  },
                }
              : msg
          )
        );

        const prevContext = generatedChunks.length > 0 ? generatedChunks[generatedChunks.length - 1].text.slice(-300) : '';

        // 2A. Generate 550-600 word Script Text
        let secData: any = null;
        let textAttempts = 0;
        const maxTextAttempts = 6;

        while (textAttempts < maxTextAttempts && !stopRequestedRef.current) {
          textAttempts++;
          try {
            const secRes = await fetch('/api/script/generate-subtopic-section', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                topic,
                subtopic: sub.title,
                sectionIndex: partNum,
                totalSections: Math.max(subtopicsList.length, Math.ceil(targetWords / 575)),
                previousContext: prevContext,
                customPrompt: sub.customPrompt || '',
              }),
            });

            secData = await secRes.json();

            if (
              secRes.status === 503 ||
              secRes.status === 429 ||
              secData?.is503 ||
              String(secData?.error || '').includes('503') ||
              String(secData?.error || '').includes('high demand')
            ) {
              let countdown = 5 * textAttempts;
              while (countdown > 0 && !stopRequestedRef.current) {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? {
                          ...msg,
                          statusText: `API busy. Waiting for quota (${countdown}s remaining, attempt ${textAttempts}/${maxTextAttempts})...`,
                        }
                      : msg
                  )
                );
                await new Promise((r) => setTimeout(r, 1000));
                countdown--;
              }
              continue;
            }

            if (!secRes.ok) throw new Error(secData?.error || `Failed to generate script for Clip ${partNum}`);
            break;
          } catch (e: any) {
            if (textAttempts >= maxTextAttempts) throw e;
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        if (stopRequestedRef.current) break;

        if (!secData || !secData.sectionText) {
          throw new Error(`Script for Clip ${partNum} could not be generated. Click Resume to continue.`);
        }

        const sectionText = secData.sectionText;
        const sectionWords = secData.wordCount || sectionText.split(/\s+/).filter(Boolean).length;

        // IMMEDIATELY SAVE SCRIPT CHUNK BEFORE TTS (So script is NEVER lost if audio fails!)
        const scriptReadyChunk: CompletedChunk = {
          id: partNum,
          title: sub.title,
          wordCount: sectionWords,
          text: sectionText,
          customPrompt: sub.customPrompt,
        };
        generatedChunks.push(scriptReadyChunk);
        const currentChunkIndex = generatedChunks.length - 1;
        const scriptSoFar = generatedChunks.map((c) => c.text).join('\n\n');

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  completedChunks: [...generatedChunks],
                  fullScriptText: scriptSoFar,
                  statusText: `Clip ${partNum} script ready (${sectionWords} words)! Synthesizing & downloading audio...`,
                }
              : msg
          )
        );

        await persistSessionState({
          id: assistantMsgId,
          userPrompt,
          topic,
          targetWords,
          subtopics: subtopicsList,
          completedChunks: generatedChunks,
          fullCombinedScript: scriptSoFar,
          selectedVoice,
        });

        // 2B. Synthesize Audio & Auto-Download Clip
        const { audioUrl, driveLink } = await synthesizeChunkAudio(
          assistantMsgId,
          partNum,
          sectionText,
          sectionWords,
          topicSlug
        );

        generatedChunks[currentChunkIndex] = {
          ...scriptReadyChunk,
          audioBase64: undefined, // Audio brick is safely on disk & IndexedDB
          audioUrl,
          driveLink,
          hasAudioSaved: true,
        };

        cumulativeWords = generatedChunks.reduce((sum, c) => sum + (c.wordCount || 0), 0);

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  completedChunks: [...generatedChunks],
                  fullScriptText: scriptSoFar,
                  statusText: `Clip ${partNum} complete (${cumulativeWords.toLocaleString()} / ${targetWords.toLocaleString()} words)!`,
                }
              : msg
          )
        );

        await persistSessionState({
          id: assistantMsgId,
          userPrompt,
          topic,
          targetWords,
          subtopics: subtopicsList,
          completedChunks: generatedChunks,
          fullCombinedScript: scriptSoFar,
          selectedVoice,
        });
      }

      const fullCombinedScript = generatedChunks.map((c) => c.text).join('\n\n');

      if (stopRequestedRef.current) {
        const totalWords = generatedChunks.reduce((sum, c) => sum + (c.wordCount || 0), 0);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  isProcessing: false,
                  statusText: `Paused. ${generatedChunks.length} clips (${totalWords.toLocaleString()} words) saved. Click Resume anytime!`,
                }
              : msg
          )
        );
        setIsBusy(false);
        return;
      }

      // STEP 3: Stitch Master Continuous WAV & Download according to selected Download Package Mode
      const finalSlug = getScriptSlug(fullCombinedScript, 5);
      const serverMasterUrl = `/api/session/master-audio/${encodeURIComponent(assistantMsgId)}?gap=${encodeURIComponent(interClipPauseSec)}`;
      const totalWords = generatedChunks.reduce((sum, c) => sum + (c.wordCount || 0), 0);

      if (downloadPackageMode === 'single_master_wav') {
        setActiveAudioLabel(`Master Audio (${generatedChunks.length} Clips)`);
        setActiveAudioSrc(serverMasterUrl);
        triggerSingleWavDownload(serverMasterUrl, `${finalSlug}-master.wav`);
      } else {
        const packageUrl = `/api/session/download-zip/${encodeURIComponent(assistantMsgId)}?mode=${encodeURIComponent(downloadPackageMode)}&gap=${encodeURIComponent(interClipPauseSec)}`;
        const packageName = downloadPackageMode === 'parts_only' ? 'parts-only.zip' : 'parts-and-master.zip';
        triggerSingleWavDownload(packageUrl, `${finalSlug}-${packageName}`);
        setActiveAudioLabel(`Master Audio (${generatedChunks.length} Clips)`);
        setActiveAudioSrc(serverMasterUrl);
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                isProcessing: false,
                statusText: `Complete! All ${generatedChunks.length} clips (${totalWords.toLocaleString()} words) saved; package download started.`,
                progressPercent: 100,
                masterAudioUrl: serverMasterUrl,
                fullScriptText: fullCombinedScript,
                slug: finalSlug,
              }
            : msg
        )
      );

      await persistSessionState({
        id: assistantMsgId,
        userPrompt,
        topic,
        targetWords,
        subtopics: subtopicsList,
        completedChunks: generatedChunks,
        fullCombinedScript,
        selectedVoice,
        isComplete: true,
      });
    } catch (err: any) {
      console.error('Pipeline error:', err);
      const cleaned = cleanErrorMessage(err);
      setError(cleaned);
      const fullCombinedScript = generatedChunks.map((c) => c.text).join('\n\n');
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                isProcessing: false,
                statusText: `Paused: ${cleaned}`,
                completedChunks: [...generatedChunks],
                fullScriptText: fullCombinedScript,
              }
            : msg
        )
      );
    } finally {
      setIsBusy(false);
    }
  };

  // =========================================================================
  // NEW PROJECT (Saves previous session safely in History & resets workspace)
  // =========================================================================
  const handleNewProject = async () => {
    if (isBusy) return;
    stopRequestedRef.current = true;
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
    setActiveAudioSrc(null);
    setIsBusy(false);
    setError(null);
    setMessages([]);
    setInputPrompt(INITIAL_PROMPT_PRESET);
    setExpandedScriptId(null);
    setExpandedChunkTextId(null);
    setShowHistory(false);

    await clearActiveLocalSession();
    await refreshHistory();

    fetch('/api/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearActiveOnly: true }),
    }).catch(() => {});
  };

  // =========================================================================
  // SEND NEW PROMPT OR DIRECT PASTED SCRIPT
  // (Saves immediately so even if interrupted, Resume works!)
  // =========================================================================
  const handleSendMessage = async () => {
    if (!inputPrompt.trim() || isBusy) return;

    const userText = inputPrompt.trim();
    const explicitWords = computeEffectiveTargetWords();
    setInputPrompt('');
    setError(null);
    setIsBusy(true);
    stopRequestedRef.current = false;

    const userMsgId = Date.now().toString();
    const assistantMsgId = (Date.now() + 1).toString();

    // DIRECT PASTE SCRIPT MODE: Split user's pasted script into ~550-600w segments and synthesize audio directly!
    if (inputMode === 'paste_script') {
      const splitClips = splitRawScriptInto550To600WordClips(userText);
      const totalPastedWords = splitClips.reduce((s, c) => s + c.wordCount, 0);
      const prebuiltChunks: CompletedChunk[] = splitClips.map((c, idx) => ({
        id: idx + 1,
        title: c.title,
        wordCount: c.wordCount,
        text: c.text,
      }));
      const prebuiltSubtopics: SubtopicItem[] = splitClips.map((c) => ({
        title: c.title,
        movement: 'Direct Script',
        targetWords: `${c.wordCount} words`,
      }));
      const topicTitle = `Direct Script (${splitClips.length} Clips · ${totalPastedWords.toLocaleString()} Words)`;

      const newMessages: ChatMessage[] = [
        ...messages,
        {
          id: userMsgId,
          sender: 'user',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          text: `[Direct Script-to-Audio · ${totalPastedWords.toLocaleString()} words]\n${userText.slice(0, 300)}${userText.length > 300 ? '...' : ''}`,
        },
        {
          id: assistantMsgId,
          sender: 'assistant',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          userPrompt: userText,
          requestedTargetWords: totalPastedWords,
          isProcessing: true,
          statusText: `Split pasted script into ${splitClips.length} clips (${totalPastedWords.toLocaleString()} words). Synthesizing audio...`,
          progressPercent: 10,
          plan: {
            topic: topicTitle,
            targetWords: totalPastedWords,
            subtopics: prebuiltSubtopics,
          },
          completedChunks: prebuiltChunks,
          fullScriptText: userText,
        },
      ];

      setMessages(newMessages);

      await persistSessionState({
        id: assistantMsgId,
        userPrompt: userText,
        topic: topicTitle,
        targetWords: totalPastedWords,
        subtopics: prebuiltSubtopics,
        completedChunks: prebuiltChunks,
        fullCombinedScript: userText,
        selectedVoice,
      });

      await runGenerationPipeline(
        assistantMsgId,
        userText,
        topicTitle,
        totalPastedWords,
        prebuiltSubtopics,
        prebuiltChunks
      );
      return;
    }

    const newMessages: ChatMessage[] = [
      ...messages,
      {
        id: userMsgId,
        sender: 'user',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        text: userText,
      },
      {
        id: assistantMsgId,
        sender: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        userPrompt: userText,
        requestedTargetWords: explicitWords,
        isProcessing: true,
        statusText: 'Analyzing prompt word/time target and planning 550–600 word segments...',
        progressPercent: 5,
        completedChunks: [],
      },
    ];

    setMessages(newMessages);

    // Save prompt immediately to history in case network drops before plan completes
    await persistSessionState({
      id: assistantMsgId,
      userPrompt: userText,
      topic: userText.slice(0, 70),
      targetWords: explicitWords || 4000,
      subtopics: [],
      completedChunks: [],
      fullCombinedScript: '',
      selectedVoice,
    });

    await planAndStartForMessage(assistantMsgId, userText, explicitWords, []);
  };

  const planAndStartForMessage = async (
    assistantMsgId: string,
    userText: string,
    explicitWords: number | undefined,
    existingChunks: CompletedChunk[]
  ) => {
    try {
      const planRes = await fetch('/api/chat/plan-orchestration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: userText,
          targetWords: explicitWords,
        }),
      });
      const planData = await planRes.json();
      if (!planRes.ok) throw new Error(planData.error || 'Failed to analyze prompt structure.');

      const subtopics: SubtopicItem[] = planData.subtopics || [];
      const topicName = planData.topic || 'Scientific Sleep Narration';
      const targetWords = planData.targetWords || explicitWords || 4000;

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                plan: {
                  topic: topicName,
                  targetWords,
                  subtopics,
                },
              }
            : msg
        )
      );

      await persistSessionState({
        id: assistantMsgId,
        userPrompt: userText,
        topic: topicName,
        targetWords,
        subtopics,
        completedChunks: existingChunks,
        fullCombinedScript: existingChunks.map((c) => c.text).join('\n\n'),
        selectedVoice,
      });

      await runGenerationPipeline(assistantMsgId, userText, topicName, targetWords, subtopics, existingChunks);
    } catch (err: any) {
      const cleaned = cleanErrorMessage(err);
      setError(cleaned);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                isProcessing: false,
                statusText: `Paused before script generation: ${cleaned}. Click Resume below to retry!`,
              }
            : msg
        )
      );
      setIsBusy(false);
    }
  };

  // =========================================================================
  // SYNTHESIZE ALL PENDING AUDIO FOR EXISTING SAVED SCRIPTS (Without adding new scripts)
  // =========================================================================
  const handleSynthesizePendingAudioOnly = async (msgId: string) => {
    setError(null);
    const targetMsg = messagesRef.current.find((m) => m.id === msgId) || messages.find((m) => m.id === msgId);
    if (!targetMsg || isBusy || !targetMsg.completedChunks) return;

    const currentChunks = [...targetMsg.completedChunks];
    const pendingCount = currentChunks.filter((c) => !isChunkAudioReady(c)).length;
    if (pendingCount === 0) return;

    setIsBusy(true);
    stopRequestedRef.current = false;
    const topic = targetMsg.plan?.topic || 'Scientific Sleep Narration';
    const topicSlug = getScriptSlug(topic, 4);

    try {
      for (let idx = 0; idx < currentChunks.length; idx++) {
        if (stopRequestedRef.current) break;
        const c = currentChunks[idx];
        if (c.text && !isChunkAudioReady(c)) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? {
                    ...m,
                    isProcessing: true,
                    statusText: `Synthesizing audio for saved Clip ${c.id} of ${currentChunks.length} (${c.wordCount} words)...`,
                  }
                : m
            )
          );

          const { audioUrl, driveLink } = await synthesizeChunkAudio(
            msgId,
            c.id,
            c.text,
            c.wordCount,
            topicSlug
          );

          currentChunks[idx] = { ...c, audioBase64: undefined, audioUrl, driveLink, hasAudioSaved: true };
          const fullCombinedScript = currentChunks.map((ch) => ch.text).join('\n\n');

          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? {
                    ...m,
                    completedChunks: [...currentChunks],
                    fullScriptText: fullCombinedScript,
                  }
                : m
            )
          );

          await persistSessionState({
            id: msgId,
            userPrompt: targetMsg.userPrompt || INITIAL_PROMPT_PRESET,
            topic,
            targetWords: targetMsg.plan?.targetWords || 4000,
            subtopics: targetMsg.plan?.subtopics || [],
            completedChunks: currentChunks,
            fullCombinedScript,
            selectedVoice,
          });
        }
      }

      const masterAudioUrl = currentChunks.some((c) => (c as any).serverAudioAvailable || c.audioUrl?.startsWith('/api/session/chunk-audio/'))
        ? `/api/session/master-audio/${encodeURIComponent(msgId)}?gap=${encodeURIComponent(interClipPauseSec)}`
        : undefined;

      const fullCombinedScript = currentChunks.map((ch) => ch.text).join('\n\n');
      const finalSlug = getScriptSlug(fullCombinedScript, 5);
      if (masterAudioUrl) {
        setActiveAudioLabel(`Master Audio (${currentChunks.length} Clips)`);
        setActiveAudioSrc(masterAudioUrl);
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                isProcessing: false,
                masterAudioUrl: masterAudioUrl || m.masterAudioUrl,
                slug: finalSlug,
                statusText: `All ${currentChunks.length} saved clips now have softened audio & Master WAV ready!`,
              }
            : m
        )
      );
    } catch (e: any) {
      setError(cleanErrorMessage(e));
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, isProcessing: false } : m))
      );
    } finally {
      setIsBusy(false);
    }
  };

  // =========================================================================
  // DIRECT RESUME ENGINE:
  // Receives hydrated session data directly so it never suffers from stale closures!
  // =========================================================================
  const executeDirectResume = async (sessionData: any) => {
    if (isBusy) return;
    setError(null);
    const assistantMsgId = sessionData.id || 'session-assistant-1';
    let targetWords = sessionData.targetWords || 4000;
    let topic = sessionData.topic || 'Scientific Sleep Narration';
    let subtopics: SubtopicItem[] = sessionData.subtopics || [];
    let completedChunks: CompletedChunk[] = sessionData.completedChunks || [];
    const userPrompt = sessionData.userPrompt || INITIAL_PROMPT_PRESET;

    // Case 1: Plan was never created (e.g. failed right after prompt was submitted)
    if (!subtopics || subtopics.length === 0) {
      setIsBusy(true);
      await planAndStartForMessage(assistantMsgId, userPrompt, targetWords, completedChunks);
      return;
    }

    // Case 2 & 3: Plan exists
    const cumulativeWords = completedChunks.reduce((sum: number, c: any) => sum + (c.wordCount || 0), 0);
    const hasUnfinishedAudio = completedChunks.some((c: any) => !isChunkAudioReady(c));

    // If target words & subtopics are ALREADY 100% completed, auto-extend by +2,000 words (4 clips)
    if (!hasUnfinishedAudio && cumulativeWords >= targetWords && completedChunks.length >= subtopics.length) {
      const extraWords = 2000;
      targetWords = cumulativeWords + extraWords;
      const extraCount = Math.max(1, Math.ceil(extraWords / 575));
      const nextSubtopics = [...subtopics];
      for (let k = 0; k < extraCount; k++) {
        const nextPartNum = nextSubtopics.length + 1;
        nextSubtopics.push({
          title: `Movement III: Asymptotic Rest & Quantum Thermal Stasis (Part ${nextPartNum})`,
          movement: 'Movement III',
          targetWords: '550-600 words',
        });
      }
      subtopics = nextSubtopics;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                requestedTargetWords: targetWords,
                plan: { topic, targetWords, subtopics },
                statusText: `Resuming and extending project to ${targetWords.toLocaleString()} words...`,
              }
            : m
        )
      );
    }

    await runGenerationPipeline(assistantMsgId, userPrompt, topic, targetWords, subtopics, completedChunks);
  };

  // =========================================================================
  // RESUME PIPELINE:
  // Handles all cases via executeDirectResume
  // =========================================================================
  const handleResume = async (msgId: string) => {
    setError(null);
    if (isBusy) return;
    const targetMsg =
      messagesRef.current.find((m) => m.id === msgId) ||
      messages.find((m) => m.id === msgId);
    if (!targetMsg) return;

    await executeDirectResume({
      id: msgId,
      userPrompt: targetMsg.userPrompt || INITIAL_PROMPT_PRESET,
      topic: targetMsg.plan?.topic || 'Scientific Sleep Narration',
      targetWords: targetMsg.plan?.targetWords || targetMsg.requestedTargetWords || 4000,
      subtopics: targetMsg.plan?.subtopics || [],
      completedChunks: targetMsg.completedChunks || [],
    });
  };

  // =========================================================================
  // LOAD & RESUME SESSION (Single point of truth for History & Restore Box)
  // =========================================================================
  const handleLoadSession = async (sessionItem: any, andResume: boolean = false) => {
    if (isBusy) return;
    setError(null);
    try {
      const hydrated = await rehydrateSessionAudioBricks(sessionItem);
      const msgs = convertSessionToMessages(hydrated);
      setMessages(msgs);
      messagesRef.current = msgs;
      await saveLocalSession(hydrated);
      setShowHistory(false);
      await refreshHistory();

      if (hydrated.selectedVoice) {
        setSelectedVoice(hydrated.selectedVoice);
      }

      const assistantMsg = msgs.find((m) => m.sender === 'assistant');
      if (assistantMsg?.masterAudioUrl) {
        setActiveAudioSrc(assistantMsg.masterAudioUrl);
        setActiveAudioLabel(`Master Audio (${assistantMsg.completedChunks?.length || 0} Clips)`);
      }

      const chunks = hydrated.completedChunks || [];
      const wordsDone = chunks.reduce((s: number, c: any) => s + (c.wordCount || 0), 0);
      const targetW = hydrated.targetWords || 4000;
      const pendingAudio = chunks.filter((c: any) => !isChunkAudioReady(c)).length;
      const isUnfinished =
        wordsDone < targetW ||
        pendingAudio > 0 ||
        chunks.length < (hydrated.subtopics?.length || 0) ||
        chunks.length === 0;

      if (andResume || isUnfinished) {
        await executeDirectResume(hydrated);
      }
    } catch (err: any) {
      setError(`Failed to load session: ${cleanErrorMessage(err)}`);
    }
  };

  // =========================================================================
  // GENERATE MORE CLIPS BY GIVING A NEW PROMPT
  // Appends new 550-600w segments based on the user's continuation prompt & word target
  // =========================================================================
  const handleGenerateMoreWithPrompt = async (msgId: string) => {
    setError(null);
    const targetMsg = messages.find((m) => m.id === msgId);
    if (!targetMsg || isBusy) return;

    const additionalPrompt = (morePromptMap[msgId] || '').trim();
    const rawMoreWords = parseInt(moreWordsMap[msgId] || '2000', 10);
    const additionalWords = !isNaN(rawMoreWords) && rawMoreWords >= 550 ? rawMoreWords : 2000;

    const existingSubtopics = targetMsg.plan?.subtopics || [];
    const currentTopic = targetMsg.plan?.topic || 'Scientific Sleep Narration';
    const completedChunks = targetMsg.completedChunks || [];
    const currentWords = completedChunks.reduce((sum, c) => sum + (c.wordCount || 0), 0);
    const newTargetWords = Math.max((targetMsg.plan?.targetWords || currentWords) + additionalWords, currentWords + additionalWords);

    setIsBusy(true);
    stopRequestedRef.current = false;

    try {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === msgId
            ? {
                ...msg,
                isProcessing: true,
                statusText: `Planning +${additionalWords.toLocaleString()} more words (strict 550–600w clips)${additionalPrompt ? ` for: "${additionalPrompt.slice(0, 45)}..."` : ''}...`,
              }
            : msg
        )
      );

      const res = await fetch('/api/chat/expand-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: currentTopic,
          existingSubtopics,
          additionalPrompt,
          additionalWords,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.subtopics) {
        throw new Error(data.error || 'Failed to plan additional clips.');
      }

      const updatedSubtopics: SubtopicItem[] = data.subtopics;

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === msgId
            ? {
                ...msg,
                plan: {
                  topic: currentTopic,
                  targetWords: newTargetWords,
                  subtopics: updatedSubtopics,
                },
              }
            : msg
        )
      );

      // Clear the "More" prompt input box
      setMorePromptMap((prev) => ({ ...prev, [msgId]: '' }));
      setShowMoreBoxMap((prev) => ({ ...prev, [msgId]: false }));

      await runGenerationPipeline(
        msgId,
        targetMsg.userPrompt || INITIAL_PROMPT_PRESET,
        currentTopic,
        newTargetWords,
        updatedSubtopics,
        completedChunks
      );
    } catch (e: any) {
      setError(cleanErrorMessage(e));
      setIsBusy(false);
    }
  };

  // =========================================================================
  // MERGE & DOWNLOAD ALL COMPLETED CLIPS SO FAR (Supports all 3 Download Modes!)
  // =========================================================================
  const handleMergeCurrentChunks = async (msgId: string, explicitMode?: DownloadPackageMode) => {
    setError(null);
    const targetMsg = messages.find((m) => m.id === msgId);
    if (!targetMsg || !targetMsg.completedChunks || targetMsg.completedChunks.length === 0) return;

    const chosenMode = explicitMode || downloadPackageMode;
    const finalSlug = getScriptSlug(targetMsg.fullScriptText || targetMsg.plan?.topic || 'narration', 5);
    const clipCount = targetMsg.completedChunks.length;

    // Fast Single Master WAV download
    if (chosenMode === 'single_master_wav') {
      const serverMasterUrl = `/api/session/master-audio/${encodeURIComponent(msgId)}?gap=${encodeURIComponent(interClipPauseSec)}`;
      setActiveAudioLabel(`Master Audio (${clipCount} Clips)`);
      setActiveAudioSrc(serverMasterUrl);
      triggerSingleWavDownload(serverMasterUrl, `${finalSlug}-master.wav`);
      return;
    }

    const packageUrl = `/api/session/download-zip/${encodeURIComponent(msgId)}?mode=${encodeURIComponent(chosenMode)}&gap=${encodeURIComponent(interClipPauseSec)}`;
    const filename = chosenMode === 'parts_only' ? 'parts-only.zip' : 'parts-and-master.zip';
    triggerSingleWavDownload(packageUrl, `${finalSlug}-${filename}`);
    const masterUrl = `/api/session/master-audio/${encodeURIComponent(msgId)}?gap=${encodeURIComponent(interClipPauseSec)}`;
    setActiveAudioLabel(`Master Audio (${clipCount} Clips)`);
    setActiveAudioSrc(masterUrl);
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === msgId
          ? {
              ...msg,
              masterAudioUrl: masterUrl,
              slug: finalSlug,
              statusText: `Started server-side ${filename} download for ${clipCount} clips.`,
            }
          : msg
      )
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-start p-2 sm:p-4 font-sans">
      {/* Hidden Master Audio Element */}
      {activeAudioSrc && (
        <audio
          ref={audioRef}
          src={activeAudioSrc}
          loop={isLooping}
          onTimeUpdate={() => {
            if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
          }}
          onLoadedMetadata={() => {
            if (audioRef.current) {
              setDuration(audioRef.current.duration);
              // Speed is already cleanly resampled into the WAV PCM samples (single-pass DSP), so keep HTML5 playbackRate at 1.0!
              audioRef.current.playbackRate = 1.0;
              audioRef.current.volume = isMuted ? 0 : volume;
            }
          }}
          onEnded={() => {
            if (!isLooping) setIsPlaying(false);
          }}
        />
      )}

      {/* Main Container */}
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[94vh] sm:h-[92vh] relative">
        {/* Top Header */}
        <div className="px-4 py-3 bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950/70 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 via-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm sm:text-base font-bold text-white tracking-tight">
                  AudioSpark Autonomous Studio
                </h1>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300">
                  550–600W / Clip · Uncapped
                </span>
                <span
                  className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300"
                  title="Every script & audio clip is saved immediately across LocalStorage, IndexedDB, and Server Disk"
                >
                  Crash-Guard Vault: {lastAutoSavedAt}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Word/Time Target Loop · Auto-Synthesize & Auto-Download · Resumable History
              </p>
            </div>
          </div>

          {/* Right Header Controls: Speed Slider (0.80x - 1.25x), Acoustic Warmth DSP, Download Mode, Voice, History */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Full-Range Speed Slider + Quick Presets (0.96x, 1.0x, 1.05x, 1.1x, 1.15x) */}
            <div
              className="flex flex-wrap items-center gap-1.5 bg-slate-950 border border-cyan-500/40 rounded-lg px-2.5 py-1 text-[11px]"
              title="Speed is baked into clips when generated; changing this affects clips generated from now on."
            >
              <span className="text-slate-400">Speed:</span>
              <input
                type="range"
                min="0.80"
                max="1.25"
                step="0.01"
                value={playbackRate}
                onChange={(e) => {
                  const nextRate = parseFloat(e.target.value);
                  changeSpeed(nextRate);
                }}
                onMouseUp={() => {
                  rebuildAllMessagesAudioForSettings(acousticWarmth, playbackRate, interClipPauseSec);
                }}
                onTouchEnd={() => {
                  rebuildAllMessagesAudioForSettings(acousticWarmth, playbackRate, interClipPauseSec);
                }}
                className="w-20 h-1 bg-slate-800 rounded appearance-none cursor-pointer accent-cyan-400"
              />
              <span className="font-mono font-bold text-cyan-300 w-10 text-right">
                {playbackRate.toFixed(2)}x
              </span>
              <div className="flex items-center gap-0.5 pl-1 border-l border-slate-800">
                {[0.96, 1.0, 1.05, 1.1].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      changeSpeed(preset);
                      rebuildAllMessagesAudioForSettings(acousticWarmth, preset, interClipPauseSec);
                    }}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer transition ${
                      Math.abs(playbackRate - preset) < 0.005
                        ? 'bg-cyan-500 text-slate-950 font-bold'
                        : 'bg-slate-900 text-slate-400 hover:text-white'
                    }`}
                  >
                    {preset === 1.0 ? '1.0x' : preset === 1.1 ? '1.1x' : `${preset}x`}
                  </button>
                ))}
              </div>
            </div>

            {/* Acoustic Warmth & Anti-Sharpness DSP Selector */}
            <select
              value={acousticWarmth}
              onChange={(e) => {
                const nextWarmth = e.target.value as AcousticWarmthMode;
                setAcousticWarmth(nextWarmth);
                rebuildAllMessagesAudioForSettings(nextWarmth, playbackRate, interClipPauseSec);
              }}
              className="bg-emerald-950/70 border border-emerald-500/40 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-emerald-300 focus:outline-none focus:border-emerald-400 cursor-pointer"
              title="Tone is baked into clips when generated; changing this affects clips generated from now on."
            >
              <option value="velvet">Audio Tone: Velvet Soft (Unsharp & Peaceful)</option>
              <option value="deep_warmth">Audio Tone: Deep Nocturnal Warmth (Ultra-Soft)</option>
              <option value="natural">Audio Tone: Raw Studio (Unfiltered)</option>
            </select>

            {/* Download Format Selector Tab */}
            <select
              value={downloadPackageMode}
              onChange={(e) => setDownloadPackageMode(e.target.value as DownloadPackageMode)}
              className="bg-indigo-950/70 border border-indigo-500/40 rounded-lg px-2.5 py-1 text-[11px] font-semibold text-indigo-200 focus:outline-none focus:border-indigo-400 cursor-pointer"
              title="Choose whether to download only the Single Master WAV, Parts + Single Master WAV, or Parts Only"
            >
              <option value="both_parts_and_master">Download Mode: Parts + Single Master WAV</option>
              <option value="single_master_wav">Download Mode: Single Master WAV Only (No Parts)</option>
              <option value="parts_only">Download Mode: Parts Only</option>
            </select>

            {/* Inter-Clip Silence Gap Selector */}
            <select
              value={interClipPauseSec}
              onChange={(e) => {
                const nextGap = parseFloat(e.target.value);
                setInterClipPauseSec(nextGap);
                rebuildAllMessagesAudioForSettings(acousticWarmth, playbackRate, nextGap);
              }}
              className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
              title="Silence/breath gap inserted between clips when stitching the Master WAV"
            >
              <option value={0}>Clip Gap: 0s (Seamless)</option>
              <option value={1.0}>Clip Gap: 1.0s</option>
              <option value={1.5}>Clip Gap: 1.5s (Natural)</option>
              <option value={2.5}>Clip Gap: 2.5s (Deep Sleep)</option>
              <option value={4.0}>Clip Gap: 4.0s (Extended)</option>
            </select>

            <label
              className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] text-slate-300 cursor-pointer select-none"
              title="Automatically download each individual 550-600w WAV clip as it finishes"
            >
              <input
                type="checkbox"
                checked={autoDownloadClips}
                onChange={(e) => setAutoDownloadClips(e.target.checked)}
                className="accent-cyan-400 rounded cursor-pointer"
              />
              <span>Auto-DL Each Part</span>
            </label>

            <div className="flex items-center gap-2 bg-slate-950 border border-emerald-800/70 rounded-lg px-2 py-1 text-[11px]">
              <button
                type="button"
                disabled={isConnectingDrive}
                onClick={async () => {
                  if (driveUser) {
                    await googleLogout();
                    setDriveUser(null);
                    setDriveSaveStatus('Drive disconnected');
                    return;
                  }
                  setIsConnectingDrive(true);
                  try {
                    const result = await googleSignIn();
                    if (result) {
                      setDriveUser(result.user);
                      setDriveSaveStatus('Drive connected; new clips will upload automatically');
                    }
                  } catch (driveError: any) {
                    setDriveSaveStatus(`Drive connection failed: ${driveError?.message || 'unknown error'}`);
                  } finally {
                    setIsConnectingDrive(false);
                  }
                }}
                className="flex items-center gap-1 text-emerald-300 hover:text-emerald-200 disabled:opacity-50"
                title={driveUser ? 'Disconnect Google Drive' : 'Connect Google Drive for per-clip backups'}
              >
                <GoogleDriveLogo />
                <span>{isConnectingDrive ? 'Connecting...' : driveUser ? 'Drive Connected' : 'Connect Drive'}</span>
              </button>
              <label className="flex items-center gap-1 text-slate-300" title="Upload each completed audio clip directly to your Google Drive">
                <input
                  type="checkbox"
                  checked={autoSaveToDrive}
                  onChange={(e) => setAutoSaveToDrive(e.target.checked)}
                  className="accent-emerald-400"
                />
                <span>Auto-save</span>
              </label>
            </div>
            <span className="max-w-48 truncate text-[10px] text-slate-500" title={driveSaveStatus}>
              {driveUploadingChunkId ? `Uploading clip ${driveUploadingChunkId}...` : driveSaveStatus}
            </span>

            <div className="flex items-center gap-1 bg-slate-950 border border-slate-800 rounded-lg p-0.5">
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="bg-transparent px-2 py-0.5 text-xs text-slate-200 focus:outline-none cursor-pointer"
              >
                {VOICES.map((v) => (
                  <option key={v.id} value={v.id} className="bg-slate-950">
                    {v.name} ({v.badge})
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleTestVoiceSample}
                disabled={isBusy || isTestingVoice}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-cyan-300 text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
                title="Hear a quick preview of the selected voice with current warmth & speed"
              >
                <Volume2 className="w-3 h-3" />
                <span>{isTestingVoice ? '...' : 'Test'}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleNewProject}
              disabled={isBusy}
              className="px-2.5 py-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-bold text-xs flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed shadow-sm shadow-cyan-500/20 transition"
              title={isBusy ? 'Pause generation and wait for the current clip to save before starting another project' : 'Start a brand new project (Current project remains safely saved in History)'}
            >
              <PlusCircle className="w-3.5 h-3.5" />
              <span>+ New Project</span>
            </button>

            <button
              type="button"
              onClick={() => {
                refreshHistory();
                setShowHistory(!showHistory);
              }}
              className={`px-2.5 py-1 rounded-lg border text-xs font-medium flex items-center gap-1.5 cursor-pointer transition ${
                showHistory
                  ? 'bg-cyan-500 text-slate-950 border-cyan-400 font-bold'
                  : 'bg-slate-950 text-cyan-300 border-slate-800 hover:border-cyan-500/50'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>History ({historyList.length})</span>
            </button>
          </div>
        </div>

        {/* Hidden Backup JSON File Input */}
        <input
          ref={backupFileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const imported = JSON.parse(text);
              if (imported && (imported.completedChunks || imported.userPrompt)) {
                const hydrated = await rehydrateSessionAudioBricks(imported);
                setMessages(convertSessionToMessages(hydrated));
                await saveLocalSession({ ...hydrated, id: hydrated.id || `restored-${Date.now()}` });
                await refreshHistory();
                setShowHistory(false);
                setError(null);
              } else {
                setError('Invalid backup JSON file format.');
              }
            } catch (err: any) {
              setError(`Failed to import backup file: ${err?.message || 'Invalid JSON'}`);
            } finally {
              e.target.value = '';
            }
          }}
        />

        {/* Collapsible Session History Drawer */}
        {showHistory && (
          <div className="bg-slate-950 border-b border-slate-800 p-3 max-h-72 overflow-y-auto space-y-2 flex-shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" />
                Crash-Proof Vault & History (Triple-Backed in LocalStorage, IndexedDB & Server)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => backupFileInputRef.current?.click()}
                  className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/30 rounded text-[11px] font-semibold cursor-pointer"
                  title="Import a previously exported .json project backup file"
                >
                  Import Backup (.json)
                </button>
                <button
                  type="button"
                  onClick={() => setShowHistory(false)}
                  className="text-[11px] text-slate-400 hover:text-white underline cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>

            {historyList.length === 0 ? (
              <p className="text-xs text-slate-500 py-2">No saved sessions yet.</p>
            ) : (
              <div className="space-y-1.5">
                {historyList.map((item) => {
                  const chunks: CompletedChunk[] = item.completedChunks || [];
                  const wordsDone = chunks.reduce((s, c) => s + (c.wordCount || 0), 0);
                  const audioDone = chunks.filter((c) => isChunkAudioReady(c)).length;
                  const targetW = item.targetWords || 4000;
                  const isCompleted = wordsDone >= targetW && (chunks.length === 0 || audioDone >= chunks.length);
                  return (
                    <div
                      key={item.id}
                      className="p-2.5 bg-slate-900 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-200 truncate">
                          {item.topic || item.userPrompt?.slice(0, 60) || 'Untitled Session'}
                        </div>
                        <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-2 mt-0.5">
                          <span className="text-cyan-400 font-mono">
                            {wordsDone.toLocaleString()} / {targetW.toLocaleString()} words
                          </span>
                          <span>·</span>
                          <span>
                            {chunks.length} script clips ({audioDone} audio ready)
                          </span>
                          {item.updatedAt && (
                            <>
                              <span>·</span>
                              <span>{item.updatedAt}</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleLoadSession(item, false)}
                          disabled={isBusy}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/30 rounded-lg text-[11px] font-semibold cursor-pointer"
                          title="Load project into view with audio player and download options"
                        >
                          Load Project
                        </button>
                        <button
                          type="button"
                          onClick={() => handleLoadSession(item, true)}
                          disabled={isBusy}
                          className="px-2.5 py-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-lg text-[11px] cursor-pointer flex items-center gap-1 shadow-sm"
                          title={isCompleted ? 'Extend project by +2,000 words and resume generation' : 'Resume generation for this project'}
                        >
                          <FastForward className="w-3 h-3 fill-slate-950" />
                          <span>{isCompleted ? 'Resume & Extend (+2kw)' : 'Resume Generation'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const hydrated = await rehydrateSessionAudioBricks(item);
                            const slug = getScriptSlug(hydrated.topic || 'project', 3);
                            exportSessionBackupJson(hydrated, slug);
                          }}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 rounded-lg text-[11px] cursor-pointer"
                          title="Download portable .json backup file of this session"
                        >
                          Backup JSON
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const updated = await deleteSessionFromHistory(item.id);
                            setHistoryList(updated);
                          }}
                          disabled={isBusy}
                          className="p-1.5 bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 rounded-lg cursor-pointer"
                          title="Delete session from history"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Global Error Banner */}
        {error && (
          <div className="p-3 bg-rose-500/10 border-b border-rose-500/30 text-rose-300 text-xs flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => setError(null)}
              className="underline text-rose-400 hover:text-rose-200 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Active Project Banner */}
        {(() => {
          const ongoing = messages.find((m) => m.sender === 'assistant' && !m.isProcessing);
          if (!ongoing) return null;
          const chunks = ongoing.completedChunks || [];
          const wordsDone = chunks.reduce((s, c) => s + (c.wordCount || 0), 0);
          const targetW = ongoing.plan?.targetWords || ongoing.requestedTargetWords || 4000;
          const pendingAudio = chunks.filter((c) => !isChunkAudioReady(c)).length;
          const readyAudioCount = chunks.filter((c) => isChunkAudioReady(c)).length;
          const isAllDone = chunks.length > 0 && pendingAudio === 0 && wordsDone >= targetW;

          return (
            <div className="px-4 py-2.5 bg-gradient-to-r from-cyan-950/80 via-slate-900 to-indigo-950/80 border-b border-cyan-800/40 flex flex-wrap items-center justify-between gap-2 flex-shrink-0">
              <div className="flex items-center gap-2 text-cyan-300 text-xs font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span>
                  {chunks.length === 0
                    ? `Prompt saved (${targetW.toLocaleString()} word target) — ready to generate!`
                    : pendingAudio > 0
                    ? `${chunks.length} script clips saved (${pendingAudio} audio pending) · ${wordsDone.toLocaleString()} / ${targetW.toLocaleString()} words`
                    : isAllDone
                    ? `Project Complete: ${chunks.length} clips (${wordsDone.toLocaleString()} words) synthesized & ready to play/download!`
                    : `Session Active: ${chunks.length} clips (${wordsDone.toLocaleString()} / ${targetW.toLocaleString()} words) saved!`}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {readyAudioCount > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleMergeCurrentChunks(ongoing.id, 'single_master_wav')}
                      disabled={isBusy}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-cyan-300 border border-cyan-500/40 font-semibold text-xs rounded-lg flex items-center gap-1 cursor-pointer shadow-sm transition"
                      title="Download 1 continuous Single Master WAV file (No separate parts)"
                    >
                      <Download className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Single Frame WAV</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMergeCurrentChunks(ongoing.id, 'both_parts_and_master')}
                      disabled={isBusy}
                      className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-emerald-300 border border-emerald-500/40 font-semibold text-xs rounded-lg flex items-center gap-1 cursor-pointer shadow-sm transition"
                      title="Download both individual parts and entire Single Master WAV in one ZIP"
                    >
                      <Archive className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Parts + Single Frame ZIP</span>
                    </button>
                  </>
                )}
                {chunks.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const scriptTxt =
                        ongoing.fullScriptText || chunks.map((c) => c.text).join('\n\n');
                      const slug = getScriptSlug(ongoing.plan?.topic || scriptTxt || 'script', 4);
                      triggerTextFileDownload(scriptTxt, `${slug}-script-so-far.txt`);
                    }}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold text-xs rounded-lg flex items-center gap-1 cursor-pointer shadow-sm transition"
                    title="Download all generated scripts (.txt) immediately"
                  >
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Script (.txt)</span>
                  </button>
                )}
                {pendingAudio > 0 && (
                  <button
                    type="button"
                    onClick={() => handleSynthesizePendingAudioOnly(ongoing.id)}
                    disabled={isBusy}
                    className="px-2.5 py-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-lg flex items-center gap-1 cursor-pointer shadow-sm transition"
                    title="Synthesize WAV audio for the already-saved script clips without generating new script clips yet"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Synthesize {pendingAudio} Pending Audio Only</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleResume(ongoing.id)}
                  disabled={isBusy}
                  className="px-3 py-1 bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-lg flex items-center gap-1.5 shadow-sm shadow-cyan-400/30 cursor-pointer transition"
                >
                  <FastForward className="w-3.5 h-3.5 fill-slate-950" />
                  <span>
                    {chunks.length === 0
                      ? 'Start / Resume Prompt'
                      : pendingAudio > 0
                      ? `Synthesize Clip ${chunks.length} Audio & Resume`
                      : wordsDone >= targetW
                      ? 'Extend & Resume (+2,000w)'
                      : `Resume Generation (Clip ${chunks.length + 1})`}
                  </span>
                </button>
              </div>
            </div>
          );
        })()}

        {/* Chat Message Stream */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                <Bot className="w-6 h-6" />
              </div>
              <div className="max-w-md space-y-1">
                <h3 className="text-sm font-semibold text-slate-200">
                  Autonomous Word/Time-Driven Sleep Engine
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Give any word limit (e.g., <strong>2,000 words, 8,000 words</strong>) or time limit (e.g., <strong>1 hour, 2 hours</strong>). Every clip generated is strictly <strong>550–600 words</strong>, continuing automatically until your entire target mark is completed — whether that takes 4 clips or 400 clips.
                </p>
              </div>

              {/* Instant Restore Previous Project Box if History exists */}
              {historyList.length > 0 && (
                <div className="w-full max-w-lg p-3.5 bg-slate-950/90 border border-cyan-500/40 rounded-xl text-left space-y-2 shadow-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-cyan-300 flex items-center gap-1.5">
                      <History className="w-4 h-4 text-cyan-400" />
                      Restore Your Previous Project Progress ({historyList.length} Saved):
                    </span>
                  </div>
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {historyList.map((item) => {
                      const chunks: CompletedChunk[] = item.completedChunks || [];
                      const wordsDone = chunks.reduce((s, c) => s + (c.wordCount || 0), 0);
                      const audioDone = chunks.filter((c) => isChunkAudioReady(c)).length;
                      const targetW = item.targetWords || 4000;
                      const isCompleted = wordsDone >= targetW && (chunks.length === 0 || audioDone >= chunks.length);
                      return (
                        <div
                          key={item.id}
                          className="p-2.5 bg-slate-900 border border-slate-800 rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-slate-200 truncate">
                              {item.topic || item.userPrompt?.slice(0, 55) || 'Saved Project'}
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono">
                              {wordsDone.toLocaleString()} / {targetW.toLocaleString()} words · {chunks.length} clips ({audioDone} audio ready)
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleLoadSession(item, false)}
                              disabled={isBusy}
                              className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/30 rounded-lg text-xs font-semibold cursor-pointer"
                              title="Load project into view"
                            >
                              Load
                            </button>
                            <button
                              type="button"
                              onClick={() => handleLoadSession(item, true)}
                              disabled={isBusy}
                              className="px-3 py-1.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold rounded-lg text-xs cursor-pointer flex items-center gap-1 shadow-sm"
                              title={isCompleted ? 'Extend project with +2,000 words & resume' : 'Restore & resume generation'}
                            >
                              <FastForward className="w-3.5 h-3.5 fill-slate-950" />
                              <span>{isCompleted ? 'Extend (+2kw)' : 'Restore & Resume'}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setInputPrompt(INITIAL_PROMPT_PRESET)}
                  className="text-xs text-cyan-400 hover:text-cyan-300 underline font-mono bg-cyan-950/40 px-3 py-1.5 rounded-lg border border-cyan-800/40 cursor-pointer"
                >
                  Load "Stellar Collapse & Schwarzschild Metric" Prompt
                </button>
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const chunks = msg.completedChunks || [];
              const wordsDone = chunks.reduce((s, c) => s + (c.wordCount || 0), 0);
              const targetW = msg.plan?.targetWords || msg.requestedTargetWords || 4000;
              const pendingAudioChunks = chunks.filter((c) => !isChunkAudioReady(c));
              const isIncomplete =
                !msg.plan ||
                chunks.length === 0 ||
                pendingAudioChunks.length > 0 ||
                wordsDone < targetW ||
                chunks.length < (msg.plan?.subtopics.length || 0);

              return (
                <div
                  key={msg.id}
                  className={`flex gap-3 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {msg.sender === 'assistant' && (
                    <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white flex-shrink-0 mt-0.5">
                      <Bot className="w-4 h-4" />
                    </div>
                  )}

                  <div
                    className={`max-w-[95%] sm:max-w-[88%] rounded-2xl p-3.5 sm:p-4 space-y-3 text-xs leading-relaxed ${
                      msg.sender === 'user'
                        ? 'bg-cyan-600 text-white shadow-md'
                        : 'bg-slate-950/90 border border-slate-800 text-slate-200 shadow-xl w-full'
                    }`}
                  >
                    {/* User Message Text */}
                    {msg.sender === 'user' && (
                      <div className="whitespace-pre-wrap font-sans text-xs">{msg.text}</div>
                    )}

                    {/* Assistant Response Content */}
                    {msg.sender === 'assistant' && (
                      <div className="space-y-3">
                        {/* Live Status Header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2">
                          <div className="flex items-center gap-2">
                            {msg.isProcessing ? (
                              <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400 flex-shrink-0" />
                            ) : !isIncomplete ? (
                              <CheckCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                            ) : (
                              <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                            )}
                            <span className="font-semibold text-slate-100">{msg.statusText}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-cyan-300">
                              <span>{wordsDone.toLocaleString()} /</span>
                              <input
                                type="number"
                                min={550}
                                step={550}
                                disabled={msg.isProcessing}
                                value={targetW}
                                onChange={async (e) => {
                                  const nextTarget = Math.max(550, parseInt(e.target.value, 10) || 4000);
                                  setMessages((prev) =>
                                    prev.map((m) =>
                                      m.id === msg.id
                                        ? {
                                            ...m,
                                            requestedTargetWords: nextTarget,
                                            plan: m.plan
                                              ? { ...m.plan, targetWords: nextTarget }
                                              : {
                                                  topic: m.userPrompt?.slice(0, 60) || 'Scientific Sleep Narration',
                                                  targetWords: nextTarget,
                                                  subtopics: [],
                                                },
                                          }
                                        : m
                                    )
                                  );
                                  await persistSessionState({
                                    id: msg.id,
                                    userPrompt: msg.userPrompt || INITIAL_PROMPT_PRESET,
                                    topic: msg.plan?.topic || 'Scientific Sleep Narration',
                                    targetWords: nextTarget,
                                    subtopics: msg.plan?.subtopics || [],
                                    completedChunks: chunks,
                                    fullCombinedScript: msg.fullScriptText || chunks.map((c) => c.text).join('\n\n'),
                                    selectedVoice,
                                  });
                                }}
                                className="w-20 bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-cyan-300 focus:outline-none focus:border-cyan-400"
                                title="Click to edit Target Word Limit for this project at any time"
                              />
                              <span>words (~{Math.round(targetW / 75)} min)</span>
                            </div>
                            {msg.isProcessing && (
                              <button
                                type="button"
                                onClick={() => {
                                  stopRequestedRef.current = true;
                                }}
                                className="px-2.5 py-1 bg-rose-600/20 border border-rose-500/40 text-rose-300 rounded text-[11px] hover:bg-rose-600/30 cursor-pointer"
                              >
                                Pause
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Progress Bar */}
                        {msg.isProcessing && (
                          <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 transition-all duration-300"
                              style={{
                                width: `${Math.min(100, Math.max(5, Math.round((wordsDone / Math.max(1, targetW)) * 100)))}%`,
                              }}
                            />
                          </div>
                        )}

                        {/* Generated Clips List (Each strictly 550–600 words) */}
                        {chunks.length > 0 && (
                          <div className="space-y-1.5 pt-1">
                            <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">
                              Generated 550–600W Clips ({chunks.length} Clips · {wordsDone.toLocaleString()} Words Total):
                            </span>
                            <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                              {chunks.map((chunk) => {
                                const chunkKey = `${msg.id}-chunk-${chunk.id}`;
                                const isExpanded = expandedChunkTextId === chunkKey;
                                return (
                                  <div
                                    key={chunk.id}
                                    className="p-2.5 bg-slate-900 border border-slate-800 rounded-lg space-y-2"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex-1 min-w-0">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <span className="font-bold text-slate-200">Clip {chunk.id}</span>
                                          <span className="text-[10px] text-cyan-400 font-mono">
                                            ({chunk.wordCount} words)
                                          </span>
                                          {chunk.audioUrl ? (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono">
                                              Audio & Script Ready
                                            </span>
                                          ) : (
                                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono">
                                              Script Saved · Audio Pending
                                            </span>
                                          )}
                                          {chunk.driveLink && (
                                            <a
                                              href={chunk.driveLink}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="text-[9px] text-emerald-300 hover:text-emerald-200 underline"
                                              title="Open this backed-up clip in Google Drive"
                                            >
                                              Drive backup
                                            </a>
                                          )}
                                        </div>
                                        <p className="text-[11px] text-slate-400 truncate mt-0.5">
                                          {chunk.title}
                                        </p>
                                      </div>

                                      <div className="flex items-center gap-1">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            if (!isExpanded) {
                                              setEditingChunkTextMap((prev) => ({
                                                ...prev,
                                                [chunkKey]: prev[chunkKey] ?? chunk.text,
                                              }));
                                            }
                                            setExpandedChunkTextId(isExpanded ? null : chunkKey);
                                          }}
                                          className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded cursor-pointer"
                                          title="View / Edit clip script text"
                                        >
                                          <Edit3 className="w-3.5 h-3.5" />
                                        </button>

                                        <button
                                          type="button"
                                          onClick={() => {
                                            navigator.clipboard.writeText(chunk.text);
                                            setCopiedId(chunkKey);
                                            setTimeout(() => setCopiedId(null), 1500);
                                          }}
                                          className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded cursor-pointer"
                                          title="Copy this clip's script text"
                                        >
                                          {copiedId === chunkKey ? (
                                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                                          ) : (
                                            <Copy className="w-3.5 h-3.5" />
                                          )}
                                        </button>

                                        {chunk.audioUrl || (chunk as any).localAudioAvailable ? (
                                          <>
                                            <button
                                              type="button"
                                              onClick={() => handlePlayChunkAudio(msg.id, chunk)}
                                              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded cursor-pointer"
                                              title="Play clip audio"
                                            >
                                              <Play className="w-3.5 h-3.5 fill-cyan-300" />
                                            </button>
                                            {chunk.audioUrl && (
                                              <a
                                                href={chunk.audioUrl}
                                                download={`${String(chunk.id).padStart(2, '0')}-${msg.slug || 'clip'}-part-${chunk.id}.wav`}
                                                className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-cyan-300 rounded cursor-pointer"
                                                title="Download clip WAV"
                                              >
                                                <Download className="w-3.5 h-3.5" />
                                              </a>
                                            )}
                                            <button
                                              type="button"
                                              onClick={() => handleResynthesizeSingleClip(msg.id, chunk.id)}
                                              disabled={isBusy}
                                              className="p-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-400 hover:text-emerald-300 rounded cursor-pointer"
                                              title="Re-synthesize this clip's audio with current voice & speed"
                                            >
                                              <RefreshCw className="w-3.5 h-3.5" />
                                            </button>
                                          </>
                                        ) : (
                                          <button
                                            type="button"
                                            onClick={() => handleResume(msg.id)}
                                            disabled={isBusy}
                                            className="px-2 py-1 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-[10px] rounded flex items-center gap-1 cursor-pointer"
                                            title="Synthesize audio for this saved script"
                                          >
                                            <Volume2 className="w-3 h-3" />
                                            <span>Synthesize Audio</span>
                                          </button>
                                        )}

                                        <button
                                          type="button"
                                          onClick={() => handleDeleteSingleClip(msg.id, chunk.id)}
                                          disabled={isBusy}
                                          className="p-1.5 bg-slate-800 hover:bg-rose-950 disabled:opacity-40 text-slate-400 hover:text-rose-300 rounded cursor-pointer"
                                          title="Delete this clip from project"
                                        >
                                          <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                      </div>
                                    </div>

                                    {isExpanded && (
                                      <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-400">
                                          <span>
                                            Edit Clip {chunk.id} Script (
                                            {(editingChunkTextMap[chunkKey] ?? chunk.text)
                                              .split(/\s+/)
                                              .filter(Boolean).length}{' '}
                                            words):
                                          </span>
                                          <div className="flex flex-wrap items-center gap-1.5">
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleSaveEditedClipScript(
                                                  msg.id,
                                                  chunk.id,
                                                  editingChunkTextMap[chunkKey] ?? chunk.text,
                                                  false
                                                )
                                              }
                                              disabled={isBusy}
                                              className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded font-semibold cursor-pointer"
                                            >
                                              Save Text Only
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                handleSaveEditedClipScript(
                                                  msg.id,
                                                  chunk.id,
                                                  editingChunkTextMap[chunkKey] ?? chunk.text,
                                                  true
                                                )
                                              }
                                              disabled={isBusy}
                                              className="px-2 py-0.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 rounded font-bold cursor-pointer"
                                            >
                                              Save & Re-Synthesize Audio
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => handleRegenerateSingleClipScript(msg.id, chunk.id)}
                                              disabled={isBusy}
                                              className="px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-semibold cursor-pointer"
                                              title="Have AI rewrite this 550-600w clip and synthesize fresh audio"
                                            >
                                              AI Rewrite Clip + Audio
                                            </button>
                                          </div>
                                        </div>
                                        <textarea
                                          value={editingChunkTextMap[chunkKey] ?? chunk.text}
                                          onChange={(e) =>
                                            setEditingChunkTextMap((prev) => ({
                                              ...prev,
                                              [chunkKey]: e.target.value,
                                            }))
                                          }
                                          rows={5}
                                          className="w-full bg-slate-900 border border-slate-800 rounded p-2 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
                                        />
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* RESUME / RECOVERY / DOWNLOAD OPTIONS / GENERATE MORE CLIPS PANEL */}
                        {!msg.isProcessing && (
                          <div className="p-3 bg-slate-900/90 border border-slate-800 rounded-xl space-y-3">
                            {/* Download Format Selection Tabs & Direct Action Buttons */}
                            {chunks.length > 0 && (
                              <div className="p-2.5 bg-slate-950/90 border border-slate-800/90 rounded-lg space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-[11px] font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1.5">
                                    <Download className="w-3.5 h-3.5" />
                                    Select Download Format (Softened & Unsharp Velvet Audio):
                                  </span>
                                  <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-2 py-0.5 rounded">
                                    {acousticWarmth === 'velvet'
                                      ? 'Velvet Anti-Sharpness Active'
                                      : acousticWarmth === 'deep_warmth'
                                      ? 'Deep Nocturnal Warmth Active'
                                      : 'Raw Studio Audio'}
                                  </span>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-0.5">
                                  {/* Option 1: Single Frame Master Audio Only (No Parts) */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDownloadPackageMode('single_master_wav');
                                      handleMergeCurrentChunks(msg.id, 'single_master_wav');
                                    }}
                                    disabled={isBusy}
                                    className={`p-2 rounded-lg border text-left transition cursor-pointer flex flex-col justify-between ${
                                      downloadPackageMode === 'single_master_wav'
                                        ? 'bg-cyan-500/15 border-cyan-400 text-white shadow-sm'
                                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-1">
                                      <span className="font-bold text-xs text-cyan-300">
                                        1. Single Frame Only
                                      </span>
                                      <Download className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                                    </div>
                                    <span className="text-[10px] text-slate-400 mt-1 block">
                                      No parts — downloads 1 continuous merged WAV file + script
                                    </span>
                                  </button>

                                  {/* Option 2: Both Parts + Entire Single Frame Master WAV */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDownloadPackageMode('both_parts_and_master');
                                      handleMergeCurrentChunks(msg.id, 'both_parts_and_master');
                                    }}
                                    disabled={isBusy}
                                    className={`p-2 rounded-lg border text-left transition cursor-pointer flex flex-col justify-between ${
                                      downloadPackageMode === 'both_parts_and_master'
                                        ? 'bg-cyan-500/15 border-cyan-400 text-white shadow-sm'
                                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-1">
                                      <span className="font-bold text-xs text-emerald-300">
                                        2. Parts + Single Frame
                                      </span>
                                      <Archive className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                                    </div>
                                    <span className="text-[10px] text-slate-400 mt-1 block">
                                      All {chunks.length} individual part clips + 1 continuous Master WAV in ZIP
                                    </span>
                                  </button>

                                  {/* Option 3: Individual Parts Only */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDownloadPackageMode('parts_only');
                                      handleMergeCurrentChunks(msg.id, 'parts_only');
                                    }}
                                    disabled={isBusy}
                                    className={`p-2 rounded-lg border text-left transition cursor-pointer flex flex-col justify-between ${
                                      downloadPackageMode === 'parts_only'
                                        ? 'bg-cyan-500/15 border-cyan-400 text-white shadow-sm'
                                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-1">
                                      <span className="font-bold text-xs text-indigo-300">
                                        3. Parts Only ({chunks.length} Clips)
                                      </span>
                                      <Archive className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                                    </div>
                                    <span className="text-[10px] text-slate-400 mt-1 block">
                                      Downloads separate 550–600w part WAV files + script in ZIP
                                    </span>
                                  </button>
                                </div>
                              </div>
                            )}

                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleResume(msg.id)}
                                  disabled={isBusy}
                                  className="px-3.5 py-1.5 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-bold rounded-lg flex items-center gap-1.5 shadow-md shadow-cyan-500/20 cursor-pointer"
                                >
                                  <FastForward className="w-3.5 h-3.5 fill-slate-950" />
                                  <span>
                                    {isIncomplete
                                      ? chunks.length === 0
                                        ? 'Resume & Generate Script'
                                        : pendingAudioChunks.length > 0
                                        ? `Synthesize Audio & Continue to ${targetW.toLocaleString()}w`
                                        : `Resume Generation (Clip ${chunks.length + 1} · Keep All ${chunks.length} Clips)`
                                      : `Resume & Extend Project (+2,000w / 4 Clips)`}
                                  </span>
                                </button>

                                {pendingAudioChunks.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => handleSynthesizePendingAudioOnly(msg.id)}
                                    disabled={isBusy}
                                    className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold rounded-lg flex items-center gap-1.5 shadow-md shadow-amber-500/20 cursor-pointer"
                                    title="Synthesize WAV audio for all saved script clips right now without generating new script segments"
                                  >
                                    <Volume2 className="w-3.5 h-3.5" />
                                    <span>
                                      Synthesize Pending Audio Only ({pendingAudioChunks.length} Clips)
                                    </span>
                                  </button>
                                )}
                              </div>

                              {/* "More" Button & Instant Backup / Script Buttons */}
                              <div className="flex flex-wrap items-center gap-2">
                                {chunks.length > 0 && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const scriptTxt =
                                          msg.fullScriptText || chunks.map((c) => c.text).join('\n\n');
                                        const slug = getScriptSlug(msg.plan?.topic || scriptTxt || 'script', 4);
                                        triggerTextFileDownload(scriptTxt, `${slug}-complete-script.txt`);
                                      }}
                                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
                                      title="Download complete text script (.txt)"
                                    >
                                      <FileText className="w-3.5 h-3.5 text-cyan-400" />
                                      <span>Download Script (.txt)</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const slug = getScriptSlug(msg.plan?.topic || 'sleep-project', 3);
                                        exportSessionBackupJson(
                                          {
                                            id: msg.id,
                                            userPrompt: msg.userPrompt,
                                            topic: msg.plan?.topic,
                                            targetWords: msg.plan?.targetWords,
                                            subtopics: msg.plan?.subtopics,
                                            completedChunks: msg.completedChunks,
                                            fullCombinedScript: msg.fullScriptText,
                                            selectedVoice,
                                          },
                                          slug
                                        );
                                      }}
                                      className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-emerald-500/30 font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
                                      title="Save portable .json backup file of this entire project"
                                    >
                                      <Download className="w-3.5 h-3.5 text-emerald-400" />
                                      <span>Save Backup (.json)</span>
                                    </button>
                                  </>
                                )}

                                <button
                                  type="button"
                                  onClick={() =>
                                    setShowMoreBoxMap((prev) => ({
                                      ...prev,
                                      [msg.id]: !prev[msg.id],
                                    }))
                                  }
                                  disabled={isBusy}
                                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer shadow-sm"
                                >
                                  <PlusCircle className="w-3.5 h-3.5" />
                                  <span>More Clips (+ New Prompt)</span>
                                </button>
                              </div>
                            </div>

                            {/* Expandable "More Clips with New Prompt" Box */}
                            {showMoreBoxMap[msg.id] && (
                              <div className="p-3 bg-slate-950 border border-indigo-500/40 rounded-xl space-y-2.5">
                                <div className="text-[11px] font-semibold text-indigo-300 flex items-center justify-between">
                                  <span>
                                    Generate More 550–600 Word Clips (Appends to this session & auto-downloads)
                                  </span>
                                </div>
                                <textarea
                                  value={morePromptMap[msg.id] || ''}
                                  onChange={(e) =>
                                    setMorePromptMap((prev) => ({
                                      ...prev,
                                      [msg.id]: e.target.value,
                                    }))
                                  }
                                  rows={2}
                                  placeholder="Enter new prompt or direction for the next clips (or leave blank to continue current topic deeply)..."
                                  className="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-400"
                                />
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 text-xs">
                                    <span className="text-slate-400">Additional Words to Generate:</span>
                                    <input
                                      type="number"
                                      min={550}
                                      step={550}
                                      value={moreWordsMap[msg.id] || '2000'}
                                      onChange={(e) =>
                                        setMoreWordsMap((prev) => ({
                                          ...prev,
                                          [msg.id]: e.target.value,
                                        }))
                                      }
                                      className="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-400"
                                    />
                                    <span className="text-[10px] text-slate-500 font-mono">
                                      (Each clip = 550–600 words)
                                    </span>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => handleGenerateMoreWithPrompt(msg.id)}
                                    disabled={isBusy}
                                    className="px-3.5 py-1.5 bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5 cursor-pointer"
                                  >
                                    <Send className="w-3.5 h-3.5" />
                                    <span>Generate More Clips Now</span>
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* MASTER AUDIO CONTROLS & FULL SCRIPT VIEWER */}
                        {(msg.masterAudioUrl || msg.fullScriptText) && (
                          <div className="p-3 bg-slate-900 border border-cyan-500/30 rounded-xl space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                {msg.masterAudioUrl && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveAudioSrc(msg.masterAudioUrl!);
                                      setTimeout(() => {
                                        if (audioRef.current) {
                                          audioRef.current.currentTime = 0;
                                          audioRef.current
                                            .play()
                                            .then(() => setIsPlaying(true))
                                            .catch(() => {});
                                        }
                                      }, 100);
                                    }}
                                    className="px-3 py-1.5 bg-cyan-500 text-slate-950 font-bold rounded-lg flex items-center gap-1.5 hover:bg-cyan-400 cursor-pointer"
                                  >
                                    <Play className="w-3.5 h-3.5 fill-slate-950" />
                                    <span>Play Full Master Audio</span>
                                  </button>
                                )}

                                {msg.masterAudioUrl && (
                                  <a
                                    href={msg.masterAudioUrl}
                                    download={`${msg.slug || 'master'}-complete.wav`}
                                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 font-semibold rounded-lg flex items-center gap-1.5 cursor-pointer"
                                  >
                                    <Download className="w-3.5 h-3.5" />
                                    <span>Master WAV</span>
                                  </a>
                                )}
                              </div>

                              {msg.fullScriptText && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedScriptId(expandedScriptId === msg.id ? null : msg.id)
                                  }
                                  className="px-3 py-1.5 bg-slate-800 text-slate-300 border border-slate-700 rounded-lg flex items-center gap-1 hover:text-white cursor-pointer"
                                >
                                  <BookOpen className="w-3.5 h-3.5" />
                                  <span>
                                    {expandedScriptId === msg.id ? 'Hide Full Script' : 'View Full Script'}
                                  </span>
                                  {expandedScriptId === msg.id ? (
                                    <ChevronUp className="w-3 h-3" />
                                  ) : (
                                    <ChevronDown className="w-3 h-3" />
                                  )}
                                </button>
                              )}
                            </div>

                            {expandedScriptId === msg.id && msg.fullScriptText && (
                              <div className="mt-2 p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-2">
                                <div className="flex items-center justify-between text-[11px] text-slate-400">
                                  <span>Full Combined Script ({wordsDone.toLocaleString()} words)</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      navigator.clipboard.writeText(msg.fullScriptText!);
                                      setCopiedId(msg.id);
                                      setTimeout(() => setCopiedId(null), 2000);
                                    }}
                                    className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
                                  >
                                    {copiedId === msg.id ? (
                                      <Check className="w-3 h-3 text-emerald-400" />
                                    ) : (
                                      <Copy className="w-3 h-3" />
                                    )}
                                    <span>{copiedId === msg.id ? 'Copied' : 'Copy Text'}</span>
                                  </button>
                                </div>
                                <textarea
                                  readOnly
                                  value={msg.fullScriptText}
                                  rows={8}
                                  className="w-full bg-slate-900 border border-slate-800 rounded p-2 text-[11px] font-mono text-slate-200 leading-relaxed"
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {msg.sender === 'user' && (
                    <div className="w-8 h-8 rounded-lg bg-cyan-700 flex items-center justify-center text-white flex-shrink-0 mt-0.5">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                </div>
              );
            })
          )}
          <div ref={chatBottomRef} />
        </div>

        {/* Global Bottom Audio Player Bar */}
        {activeAudioSrc && (
          <div className="px-4 py-2 bg-slate-950 border-t border-cyan-500/40 flex flex-wrap items-center justify-between gap-2 flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleAudioPlay}
                className="w-8 h-8 rounded-full bg-cyan-500 text-slate-950 flex items-center justify-center hover:bg-cyan-400 cursor-pointer"
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 fill-slate-950" />
                ) : (
                  <Play className="w-4 h-4 fill-slate-950 ml-0.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => skipAudioSeconds(-15)}
                className="px-1.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded text-[10px] font-mono cursor-pointer"
                title="Rewind 15 seconds"
              >
                -15s
              </button>
              <button
                type="button"
                onClick={() => skipAudioSeconds(15)}
                className="px-1.5 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 rounded text-[10px] font-mono cursor-pointer"
                title="Forward 15 seconds"
              >
                +15s
              </button>
              <button
                type="button"
                onClick={() => {
                  if (audioRef.current) {
                    audioRef.current.currentTime = 0;
                    audioRef.current
                      .play()
                      .then(() => setIsPlaying(true))
                      .catch(() => {});
                  }
                }}
                className="p-1.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                title="Restart from 0:00"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setIsLooping(!isLooping)}
                className={`p-1.5 rounded cursor-pointer ${
                  isLooping ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Loop audio continuously all night"
              >
                <Repeat className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] font-mono text-slate-300">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <span className="hidden sm:inline-block text-[10px] text-cyan-400 font-mono truncate max-w-[130px] pl-1">
                {activeAudioLabel}
              </span>
            </div>

            <div className="flex-1 min-w-[120px] max-w-xs px-1">
              <input
                type="range"
                min="0"
                max={duration || 1}
                step="0.01"
                value={currentTime}
                onChange={handleAudioSeek}
                className="w-full h-1 bg-slate-800 rounded appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {/* Volume & Mute Control */}
              <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-lg">
                <button
                  type="button"
                  onClick={() => {
                    const nextMute = !isMuted;
                    setIsMuted(nextMute);
                    if (audioRef.current) audioRef.current.volume = nextMute ? 0 : volume;
                  }}
                  className="text-slate-400 hover:text-white cursor-pointer"
                  title={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setVolume(v);
                    setIsMuted(v === 0);
                    if (audioRef.current) audioRef.current.volume = v;
                  }}
                  className="w-12 h-1 bg-slate-800 rounded appearance-none cursor-pointer accent-cyan-400"
                  title="Volume"
                />
              </div>

              <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-lg">
                <span className="text-slate-400 text-[10px]">Speed:</span>
                <input
                  type="range"
                  min="0.80"
                  max="1.25"
                  step="0.01"
                  value={playbackRate}
                  onChange={(e) => changeSpeed(parseFloat(e.target.value))}
                  onMouseUp={() => rebuildAllMessagesAudioForSettings(acousticWarmth, playbackRate, interClipPauseSec)}
                  onTouchEnd={() => rebuildAllMessagesAudioForSettings(acousticWarmth, playbackRate, interClipPauseSec)}
                  className="w-16 h-1 bg-slate-800 rounded appearance-none cursor-pointer accent-cyan-400"
                />
                <span className="font-mono text-cyan-300 font-bold w-10 text-right">
                  {playbackRate.toFixed(2)}x
                </span>
              </div>
              {[0.92, 0.96, 1.0, 1.05, 1.1, 1.15].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => {
                    changeSpeed(rate);
                    rebuildAllMessagesAudioForSettings(acousticWarmth, rate, interClipPauseSec);
                  }}
                  className={`px-1.5 py-0.5 rounded font-mono cursor-pointer ${
                    Math.abs(playbackRate - rate) < 0.005
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {rate === 1.0 ? '1.0x' : rate === 1.1 ? '1.1x' : `${rate}x`}
                </button>
              ))}
              <a
                href={activeAudioSrc}
                download="audiospark-playing-audio.wav"
                className="p-1 bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-800 rounded cursor-pointer"
                title="Download currently playing WAV audio"
              >
                <Download className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        )}

        {/* Hidden .txt Script File Input */}
        <input
          ref={txtScriptInputRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              if (text.trim()) {
                setInputMode('paste_script');
                setInputPrompt(text.trim());
              }
            } catch {}
            e.target.value = '';
          }}
        />

        {/* Chat Input Bar with Mode Tabs, Presets & Word / Time Limit Input */}
        <div className="p-3 bg-slate-950 border-t border-slate-800 flex-shrink-0 space-y-2">
          {/* Mode Switcher + Target Length Limit Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {/* Mode Toggle: AI Generate Script vs Paste Own Script */}
              <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5">
                <button
                  type="button"
                  onClick={() => setInputMode('ai_prompt')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition ${
                    inputMode === 'ai_prompt'
                      ? 'bg-cyan-500 text-slate-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span>AI Script + Audio</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('paste_script')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition ${
                    inputMode === 'paste_script'
                      ? 'bg-emerald-500 text-slate-950 font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Paste your own finished script and convert it directly into 550–600w audio clips + Master WAV"
                >
                  <FileText className="w-3 h-3" />
                  <span>Paste Own Script → Audio</span>
                </button>
              </div>

              {inputMode === 'ai_prompt' && (
                <>
                  <span className="text-slate-400 flex items-center gap-1 text-[11px] font-medium">
                    <Clock className="w-3.5 h-3.5 text-cyan-400" />
                    Target Limit:
                  </span>
                  <select
                    value={limitMode}
                    onChange={(e) => {
                      const mode = e.target.value as 'auto' | 'words' | 'minutes';
                      setLimitMode(mode);
                      if (mode === 'words') setLimitValue('4000');
                      if (mode === 'minutes') setLimitValue('60');
                    }}
                    className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-cyan-300 font-semibold focus:outline-none focus:border-cyan-500"
                  >
                    <option value="auto">Auto-Detect from Prompt (Words or Hours/Mins)</option>
                    <option value="words">Set Word Limit (e.g. 2000, 4000, 10000 words)</option>
                    <option value="minutes">Set Time Limit in Minutes (e.g. 60, 120 mins)</option>
                  </select>

                  {limitMode !== 'auto' && (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={limitMode === 'words' ? 550 : 5}
                        step={limitMode === 'words' ? 500 : 10}
                        value={limitValue}
                        onChange={(e) => setLimitValue(e.target.value)}
                        className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs font-mono text-white focus:outline-none focus:border-cyan-400"
                      />
                      <span className="text-[11px] text-slate-400 font-mono">
                        {limitMode === 'words'
                          ? `words (~${Math.max(1, Math.ceil((parseInt(limitValue, 10) || 550) / 575))} clips)`
                          : `mins (~${Math.round((parseFloat(limitValue) || 10) * 75).toLocaleString()} words)`}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => txtScriptInputRef.current?.click()}
                className="px-2 py-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
                title="Upload a .txt script file from your computer"
              >
                <Upload className="w-3 h-3 text-cyan-400" />
                <span>Upload .txt</span>
              </button>
              {inputPrompt.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => setInputPrompt('')}
                  className="px-2 py-1 bg-slate-900 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-800 rounded-lg text-[10px] font-semibold cursor-pointer"
                  title="Clear input text box"
                >
                  Clear Box
                </button>
              )}
              <span className="text-[10px] text-cyan-400 font-mono bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                {inputPrompt.trim() ? inputPrompt.trim().split(/\s+/).length.toLocaleString() : 0} words in box
              </span>
            </div>
          </div>

          <div className="flex items-end gap-2">
            <textarea
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              rows={2}
              placeholder={
                inputMode === 'paste_script'
                  ? 'Paste your complete script here (any length). It will automatically split into ~550–600w segments and synthesize audio + Master WAV...'
                  : "Enter your prompt with any word or time limit (e.g., '2000 words on Quantum Entanglement' or '2 hours on Stellar Collapse')..."
              }
              className="flex-1 bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500 leading-relaxed font-sans resize-none"
            />

            <button
              type="button"
              onClick={handleSendMessage}
              disabled={isBusy || !inputPrompt.trim()}
              className={`p-3 active:scale-95 text-slate-950 font-bold rounded-xl shadow-lg disabled:opacity-50 transition-all flex items-center justify-center cursor-pointer flex-shrink-0 ${
                inputMode === 'paste_script'
                  ? 'bg-emerald-500 hover:bg-emerald-400 shadow-emerald-500/20'
                  : 'bg-cyan-500 hover:bg-cyan-400 shadow-cyan-500/20'
              }`}
              title={inputMode === 'paste_script' ? 'Convert Pasted Script to Audio' : 'Send Prompt (or Ctrl+Enter)'}
            >
              {isBusy ? (
                <RefreshCw className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <CrashShieldErrorBoundary>
      <AppContent />
    </CrashShieldErrorBoundary>
  );
}
