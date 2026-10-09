export interface ScriptChunk {
  id: number;
  text: string;
  wordCount: number;
  preview: string;
  status: 'idle' | 'processing' | 'done' | 'error';
  audioBase64?: string;
  audioUrl?: string;
  errorMessage?: string;
}

/**
 * Splits long scripts (up to 10,000+ words) into clean, logical chunks for Gemini TTS.
 * Prioritizes natural paragraph breaks (\n\n), then line breaks (\n), then sentence punctuation.
 * Preserves all internal line breaks and ellipses so Gemini TTS respects natural breathing pauses.
 */
export function chunkScript(
  fullText: string,
  targetWordsPerChunk: number = 650
): ScriptChunk[] {
  if (!fullText || !fullText.trim()) return [];

  // Normalize Windows line endings to \n
  const text = fullText.replace(/\r\n/g, '\n');

  // Split into paragraphs by double line breaks first
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentChunk = '';
  let currentWordCount = 0;

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    const paraWords = trimmedPara.split(/\s+/).filter(Boolean).length;

    // If paragraph itself is huge (> targetWordsPerChunk * 1.3), split by sentence boundaries
    if (paraWords > targetWordsPerChunk * 1.3) {
      const sentences = trimmedPara.split(/(?<=[.!?…])\s+/);
      for (const sent of sentences) {
        const sentWords = sent.split(/\s+/).filter(Boolean).length;
        if (currentWordCount + sentWords > targetWordsPerChunk && currentWordCount > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = sent;
          currentWordCount = sentWords;
        } else {
          currentChunk = currentChunk ? `${currentChunk} ${sent}` : sent;
          currentWordCount += sentWords;
        }
      }
    } else {
      // Normal paragraph handling
      if (currentWordCount + paraWords > targetWordsPerChunk && currentWordCount > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = trimmedPara;
        currentWordCount = paraWords;
      } else {
        currentChunk = currentChunk ? `${currentChunk}\n\n${trimmedPara}` : trimmedPara;
        currentWordCount += paraWords;
      }
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.map((chunkText, idx) => {
    const words = chunkText.split(/\s+/).filter(Boolean).length;
    const preview = chunkText.replace(/\s+/g, ' ').slice(0, 80) + '...';
    return {
      id: idx + 1,
      text: chunkText,
      wordCount: words,
      preview,
      status: 'idle',
    };
  });
}
