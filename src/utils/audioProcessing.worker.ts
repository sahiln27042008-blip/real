import { softenSingleWavBase64, type AcousticWarmthMode } from './wavMerger';

interface AudioProcessingRequest {
  id: number;
  audioBase64: string;
  warmthMode: AcousticWarmthMode;
  speedFactor: number;
}

interface AudioProcessingResponse {
  id: number;
  audioBase64?: string;
  audioBuffer?: ArrayBuffer;
  error?: string;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<AudioProcessingRequest>) => void) | null;
  postMessage(message: AudioProcessingResponse, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event) => {
  const { id, audioBase64, warmthMode, speedFactor } = event.data;
  try {
    const processed = softenSingleWavBase64(audioBase64, warmthMode, speedFactor);
    workerScope.postMessage(
      { id, audioBase64: processed.audioBase64, audioBuffer: processed.audioBytes.buffer as ArrayBuffer },
      [processed.audioBytes.buffer as ArrayBuffer]
    );
  } catch (error: any) {
    workerScope.postMessage({ id, error: error?.message || 'Audio processing failed.' });
  }
};
