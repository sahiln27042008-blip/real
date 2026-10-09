export interface VoiceOption {
  id: string;
  name: string;
  tone: string;
  gender: string;
  avatarColor: string;
  description: string;
}

export interface DialogueLine {
  id: string;
  speaker: string;
  text: string;
  style?: string;
}

export interface HistoryItem {
  id: string;
  timestamp: number;
  mode: 'single' | 'dual';
  textSummary: string;
  fullText?: string;
  dialogueLines?: DialogueLine[];
  voiceName: string;
  secondaryVoice?: string;
  style?: string;
  audioBase64: string;
  duration?: number;
}
