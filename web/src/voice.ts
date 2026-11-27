// Ask Saans by voice: the browser's speech recognition, Indian English (Hinglish works too).
import { h } from './dom.ts';
import { icon } from './icons.ts';

/** The parts of the Web Speech API used here (not in TypeScript's DOM types yet). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

/** Speak a question instead of typing it (Web Speech API, Indian English; Hinglish works too). */
export function micButton(input: HTMLInputElement, send: (t: string) => void): HTMLElement | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!SR) return null;
  const btn = h(
    'button',
    { class: 'saans-mic', type: 'button', 'aria-label': 'Ask by voice', 'aria-pressed': 'false' },
    icon('mic', 18),
  );
  let rec: Recognition | null = null;
  btn.addEventListener('click', () => {
    if (rec) {
      rec.stop();
      return;
    }
    rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    btn.classList.add('on');
    btn.setAttribute('aria-pressed', 'true');
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      input.value = r[0].transcript;
      if (r.isFinal) {
        const t = input.value;
        input.value = '';
        send(t);
      }
    };
    rec.onend = rec.onerror = () => {
      rec = null;
      btn.classList.remove('on');
      btn.setAttribute('aria-pressed', 'false');
    };
    try {
      rec.start();
    } catch {
      rec = null;
      btn.classList.remove('on');
    }
  });
  return btn;
}
