import { useState } from 'react';
import { Check, ListChecks, Save } from 'lucide-react';

/** Pick several files in a list (items have a `key`) to run one action on them. */
export function useBatchSelect(items, selectable = () => true) {
  const [on, setOn] = useState(false);
  const [keys, setKeys] = useState(() => new Set());
  const pool = items.filter(selectable);
  const picked = pool.filter((x) => keys.has(x.key));
  const all = pool.length > 0 && picked.length === pool.length;
  return {
    on,
    picked,
    all,
    count: pool.length,
    start: () => setOn(true),
    stop: () => { setOn(false); setKeys(new Set()); },
    toggle: (key) => setKeys((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    }),
    toggleAll: () => setKeys(new Set(all ? [] : pool.map((x) => x.key))),
    keep: (list) => setKeys(new Set(list.map((x) => x.key))),
  };
}

export function BatchButtons({ batch, label, busy, onRun }) {
  if (!batch.on) {
    return batch.count > 1 ? <button className="btn" onClick={batch.start}><ListChecks size={14} /> Sélectionner</button> : null;
  }
  return (
    <>
      <button className="btn btn-ghost" onClick={batch.toggleAll}>{batch.all ? 'Tout désélectionner' : 'Tout sélectionner'}</button>
      <button className="btn btn-ghost" disabled={busy} onClick={batch.stop}>Annuler</button>
      <button className="btn btn-primary" disabled={busy || !batch.picked.length} onClick={onRun}><Save size={14} /> {label} ({batch.picked.length})</button>
    </>
  );
}

export function Tick({ on }) {
  return (
    <span className={`mt-px grid size-[15px] shrink-0 place-items-center rounded-[4px] border transition-colors ${on ? 'border-accent bg-accent text-[#140802]' : 'border-line-2'}`}>
      {on && <Check size={11} strokeWidth={3.5} />}
    </span>
  );
}
