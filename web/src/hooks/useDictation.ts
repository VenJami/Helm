// Speech-to-text for the mic button, using the browser's built-in Web Speech
// API. Chosen because Claude has no audio input — the subscription can polish
// the words but cannot hear them — and this is the only engine that costs
// nothing, installs nothing, and needs no API key.
//
// The trade, documented here and in SECURITY.md rather than buried: while the
// mic is on, Chrome and Edge stream the audio to their vendor's speech service.
// It is the second thing in Helm to leave loopback (the tunnel was the first),
// it only runs between your click and your stop, and Helm itself never records,
// stores or forwards audio.
//
// Constraints that shape the API below:
//   · Chrome and Edge implement it; Firefox does not, and Brave ships Chromium
//     without the speech keys. The caller hides the button where `supported`
//     is false — the same pattern the pop-out button uses.
//   · It needs a user gesture and the mic permission; a denial is terminal for
//     the page, so it surfaces as an error rather than a silent no-op.
//   · Recognition auto-stops after a pause. We restart it while the user still
//     has the button held on, so a thinking pause doesn't end the dictation.

import { useCallback, useEffect, useRef, useState } from 'react';

// Not in TS's DOM lib. Kept local rather than augmenting Window globally,
// which would collide the day the lib ships it.
interface SpeechRecognitionAlt {
  transcript: string;
}
interface SpeechRecognitionRes {
  readonly length: number;
  isFinal: boolean;
  [i: number]: SpeechRecognitionAlt;
}
interface SpeechRecognitionEv extends Event {
  resultIndex: number;
  results: { readonly length: number; [i: number]: SpeechRecognitionRes };
}
interface SpeechRecognitionErrEv extends Event {
  error: string;
}
interface SpeechRecognitionApi extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEv) => void) | null;
  onerror: ((e: SpeechRecognitionErrEv) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionApi;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export const dictationSupported = (): boolean => recognitionCtor() !== null;

// Browser error codes are terse and a couple are actively misleading
// ("network" really means the vendor's speech service was unreachable).
function errorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone blocked — allow mic access for this site and try again';
    case 'no-speech':
      return "Didn't catch anything — try again a bit closer to the mic";
    case 'audio-capture':
      return 'No microphone found';
    case 'network':
      return 'Speech service unreachable — dictation needs an internet connection';
    default:
      return `Dictation failed (${code})`;
  }
}

export interface Dictation {
  supported: boolean;
  listening: boolean;
  /** Everything heard this session: settled text plus the live tail. */
  transcript: string;
  start: () => void;
  /** Resolves with the final transcript ('' if nothing was heard). */
  stop: () => string;
}

export function useDictation(onError?: (message: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const recRef = useRef<SpeechRecognitionApi | null>(null);
  const finalRef = useRef(''); // settled text; interim results are appended live
  const wantRef = useRef(false); // user still holding the button on
  const errRef = useRef(onError);
  errRef.current = onError;

  const teardown = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) return;
    rec.onresult = rec.onerror = rec.onend = null;
    try {
      rec.abort();
    } catch {
      /* already stopped */
    }
  }, []);

  // A pane can unmount mid-dictation (minimize, pop-out, workspace switch) —
  // the recogniser must not outlive it holding the mic open.
  useEffect(() => {
    return () => {
      wantRef.current = false;
      teardown();
    };
  }, [teardown]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    finalRef.current = '';
    setTranscript('');
    wantRef.current = true;

    const build = (): void => {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || 'en-US';
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (!r.length) continue;
          if (r.isFinal) finalRef.current += r[0].transcript;
          else interim += r[0].transcript;
        }
        setTranscript((finalRef.current + interim).trimStart());
      };
      rec.onerror = (e) => {
        // A pause between sentences fires 'no-speech'; only report it if the
        // user has already stopped, otherwise the restart below covers it.
        if (e.error === 'no-speech' && wantRef.current) return;
        wantRef.current = false;
        setListening(false);
        teardown();
        errRef.current?.(errorMessage(e.error));
      };
      rec.onend = () => {
        // Recognition self-stops after a pause. Rebuild while the user still
        // wants it, so thinking mid-sentence doesn't end the dictation.
        if (!wantRef.current) return;
        recRef.current = null;
        try {
          build();
        } catch {
          wantRef.current = false;
          setListening(false);
        }
      };
      recRef.current = rec;
      rec.start();
    };

    try {
      build();
      setListening(true);
    } catch (err) {
      wantRef.current = false;
      teardown();
      errRef.current?.((err as Error).message || 'Could not start dictation');
    }
  }, [teardown]);

  const stop = useCallback((): string => {
    wantRef.current = false;
    setListening(false);
    teardown();
    return (finalRef.current || transcript).trim();
  }, [teardown, transcript]);

  return { supported: recognitionCtor() !== null, listening, transcript, start, stop };
}
