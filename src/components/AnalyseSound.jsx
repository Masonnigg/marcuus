// The sound Pubs plays when the editor presses "Analyser": once, to its end. Its volume (or mute) is kept, and
// the control shows next to Analyser and on the progress screen, where the sound plays.
import { useEffect, useState } from 'react';
import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { kit } from '../lib/kit.js';
import soundUrl from '../assets/analyse.mp3';

const audio = typeof Audio === 'undefined' ? null : new Audio(soundUrl);
let pref = { volume: 0.6, muted: false };
const shown = new Set();
const apply = () => {
  if (audio) { audio.volume = pref.volume; audio.muted = pref.muted; }
  shown.forEach((set) => set(pref));
};
kit.store.get('analyseSound', null).then((p) => { if (p) pref = { ...pref, ...p }; apply(); }).catch(() => {});
const update = (p) => { pref = { ...pref, ...p }; apply(); kit.store.set('analyseSound', pref); };

/** From the click on Analyser (a user gesture, so the browser lets it play). A sound that can't play never stops the analysis. */
export function playAnalyseSound() {
  if (!audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

export function SoundControl() {
  const [p, setP] = useState(pref);
  useEffect(() => { shown.add(setP); setP(pref); return () => shown.delete(setP); }, []);
  const off = p.muted || p.volume === 0;
  const Icon = off ? VolumeX : p.volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex items-center gap-1" title="Son de l’analyse">
      <button
        className="grid size-8 place-items-center rounded-lg text-mute transition-colors hover:bg-panel-2 hover:text-ink"
        aria-label={off ? 'Remettre le son de l’analyse' : 'Couper le son de l’analyse'}
        aria-pressed={off}
        onClick={() => update(off ? { muted: false, volume: p.volume || 0.6 } : { muted: true })}
      >
        <Icon size={15} />
      </button>
      <input
        type="range" min="0" max="1" step="0.05"
        value={p.muted ? 0 : p.volume}
        onChange={(e) => update({ volume: +e.target.value, muted: +e.target.value === 0 })}
        aria-label="Volume du son de l’analyse"
        className="w-20 accent-ink"
      />
    </div>
  );
}
