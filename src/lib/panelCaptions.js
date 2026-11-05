// RYACHA's Premiere panel makes captions with exactly the Transcrire rules: this file is bundled into
// premiere/lib/captions.cjs (npm run build:panel), because the panel can only load plain CommonJS.
import { wordsFromWhisper, cuesFromWords } from './transcribe.js';
import { serializeSrt } from './srt.js';

/** The engine's transcription of a part's audio → SRT text ('' when nothing is said). opts = Transcrire's options. */
export function srtFromEngine(result, opts = {}) {
  const words = wordsFromWhisper(result);
  if (!words.length) return '';
  return serializeSrt(cuesFromWords(words, opts));
}
