import JSZip from 'jszip';
import { softenSingleWavBase64, AcousticWarmthMode } from './wavMerger';

export type DownloadPackageMode =
  | 'single_master_wav'     // No parts, just 1 single continuous Master WAV file + script
  | 'both_parts_and_master' // All individual part clips + entire Single Master WAV in one ZIP
  | 'parts_only';           // Individual part clips only + script

function triggerBrowserBlobDownload(blob: Blob, filename: string) {
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 8000);
}

export async function downloadAudioOutput(options: {
  mode: DownloadPackageMode;
  baseSlug: string;
  fullScriptText: string;
  chunks: Array<{ id: number; audioBase64?: string; wordCount: number }>;
  masterAudioBase64?: string;
  masterAudioBytes?: Uint8Array;
  warmthMode?: AcousticWarmthMode;
  speedFactor?: number;
}): Promise<void> {
  const {
    mode,
    baseSlug,
    fullScriptText,
    chunks,
    masterAudioBase64,
    masterAudioBytes,
    warmthMode = 'velvet',
    speedFactor = 0.96,
  } = options;

  // Resolve master bytes if provided
  let resolvedMasterBytes: Uint8Array | undefined = masterAudioBytes;
  if (!resolvedMasterBytes && masterAudioBase64) {
    const binaryString = atob(masterAudioBase64);
    resolvedMasterBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      resolvedMasterBytes[i] = binaryString.charCodeAt(i);
    }
  }

  // OPTION 1: "Single Frame / Master Audio Only" (No parts, direct single continuous WAV + script)
  if (mode === 'single_master_wav') {
    if (resolvedMasterBytes) {
      const wavBlob = new Blob([resolvedMasterBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
      triggerBrowserBlobDownload(wavBlob, `${baseSlug}-single-master-complete.wav`);
    }
    if (fullScriptText) {
      const txtBlob = new Blob([fullScriptText], { type: 'text/plain;charset=utf-8' });
      setTimeout(() => {
        triggerBrowserBlobDownload(txtBlob, `${baseSlug}-complete-script.txt`);
      }, 350);
    }
    return;
  }

  // OPTION 2 & 3: ZIP archive containing either "Parts + Single Master WAV" or "Parts Only"
  const zip = new JSZip();

  // Always include the full script text
  zip.file(`${baseSlug}-script.txt`, fullScriptText);

  // Include individual part clips if mode is 'both_parts_and_master' or 'parts_only'
  if (mode === 'both_parts_and_master' || mode === 'parts_only') {
    for (const chunk of chunks) {
      if (chunk.audioBase64) {
        const softenedPart = softenSingleWavBase64(chunk.audioBase64, warmthMode, speedFactor);
        const partNum = String(chunk.id).padStart(2, '0');
        zip.file(`parts/${partNum}-${baseSlug}-part-${chunk.id}.wav`, softenedPart.audioBytes);
        URL.revokeObjectURL(softenedPart.blobUrl);
      }
    }
  }

  // Include the entire stitched Single Master WAV if mode is 'both_parts_and_master'
  if (mode === 'both_parts_and_master' && resolvedMasterBytes) {
    zip.file(`${baseSlug}-single-master-complete.wav`, resolvedMasterBytes);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const suffix = mode === 'parts_only' ? 'parts-only.zip' : 'parts-and-single-master.zip';
  triggerBrowserBlobDownload(blob, `${baseSlug}-${suffix}`);
}

// Keep backward-compatible alias
export async function downloadAllFilesZip(options: {
  baseSlug: string;
  fullScriptText: string;
  chunks: Array<{ id: number; audioBase64?: string; wordCount: number }>;
  masterAudioBase64?: string;
  masterAudioBytes?: Uint8Array;
  mode?: DownloadPackageMode;
}): Promise<void> {
  return downloadAudioOutput({
    mode: options.mode || 'both_parts_and_master',
    ...options,
  });
}
