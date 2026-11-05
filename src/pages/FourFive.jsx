import { useEffect, useRef, useState } from 'react';
import { Crop, FolderOpen, Upload, Loader2, Check, AlertCircle, Folder, X } from 'lucide-react';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';

const mo = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} Mo`;
const base = (p) => p.split('/').pop();

/**
 * 4x5: drop folders or videos → 4:5 copies cropped in the middle. A folder is rebuilt next to it as
 * "<folder> 4x5" with the same subfolders (a deliverables tree's "9x16" folders get their "4x5" twin instead);
 * files are converted one at a time, never overwritten.
 */
export default function FourFive() {
  const notify = useToast();
  const [jobs, setJobs] = useState([]);
  const [planning, setPlanning] = useState(false);
  const [run, setRun] = useState(false); // "Convertir" pressed: work through the list
  const [over, setOver] = useState(false);
  const [gpu, setGpu] = useState(false); // remembered: "Rapide" = the Mac's hardware encoder
  const busy = useRef(false);
  const stopped = useRef(false);
  const inputRef = useRef();

  const update = (src, patch) => setJobs((js) => js.map((j) => (j.src === src ? { ...j, ...patch } : j)));
  useEffect(() => kit.fourfive.onProgress((p) => update(p.src, { pct: p.pct })), []);
  useEffect(() => { kit.store.get('fourfiveOpts', {}).then((o) => setGpu(!!o?.gpu)); }, []);
  const chooseGpu = (on) => { setGpu(on); kit.store.set('fourfiveOpts', { gpu: on }); };

  async function add(paths) {
    if (!paths.length) return;
    setPlanning(true);
    const found = await kit.fourfive.plan(paths);
    setPlanning(false);
    const fresh = found.map((j) => ({ ...j, state: j.error ? 'error' : j.done ? 'skipped' : !j.crop ? 'same' : 'todo' }));
    setJobs((js) => [...js, ...fresh.filter((j) => !js.some((x) => x.src === j.src))]);
    if (!found.length) notify('Aucune vidéo trouvée', { tone: 'bad' });
  }

  // one video at a time: x264 already uses every core
  useEffect(() => {
    if (!run || busy.current) return;
    const next = jobs.find((j) => j.state === 'todo');
    if (!next) {
      setRun(false);
      const done = jobs.filter((j) => j.state === 'done');
      if (done.length && !stopped.current) {
        const last = done.at(-1).out;
        notify(`${done.length} vidéo${done.length > 1 ? 's' : ''} en 4:5`, { ms: 5000, action: { label: 'Afficher', onClick: () => kit.reveal(last) } });
      }
      return;
    }
    busy.current = true;
    update(next.src, { state: 'running', pct: 0 });
    kit.fourfive.convert({ ...next, gpu }).then((r) => {
      busy.current = false;
      if (r.ok) update(next.src, { state: r.skipped ? 'skipped' : 'done', outSize: r.size });
      else if (r.cancelled) { update(next.src, { state: 'todo' }); setRun(false); }
      else update(next.src, { state: 'error', error: r.error });
    });
  }, [jobs, run]);

  const start = () => { stopped.current = false; setRun(true); };
  const cancel = () => { stopped.current = true; kit.fourfive.cancel(); };
  const todo = jobs.filter((j) => j.state === 'todo').length;
  const running = jobs.find((j) => j.state === 'running');
  const groups = [...new Set(jobs.map((j) => j.root ?? ''))];

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); add([...e.dataTransfer.files].map((f) => kit.pathFor(f)).filter(Boolean)); }}
    >
      <PageHeader title="4x5" sub="Vidéos verticales → 4:5, recadrées au milieu, sans perte visible et environ deux fois plus légères. Un dossier est recréé à côté avec « 4x5 » dans le nom ; un dossier de livrables remplit le « 4x5 » à côté de chaque « 9x16 ».">
        <input ref={inputRef} type="file" multiple hidden accept="video/*,.mxf,.mts" onChange={(e) => { add([...e.target.files].map((f) => kit.pathFor(f)).filter(Boolean)); e.target.value = ''; }} />
        {!run && <button className="btn" onClick={async () => { const p = await kit.pickFolder(); if (p) add([p]); }}><FolderOpen size={14} /> Ajouter un dossier</button>}
        {!run && <button className="btn" onClick={() => inputRef.current.click()}><Upload size={14} /> Ajouter des vidéos</button>}
        {run ? <button className="btn" onClick={cancel}>Annuler</button>
          : todo > 0 && <button className="btn btn-primary" onClick={start}><Crop size={14} /> Convertir ({todo})</button>}
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-8 pb-6">
        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-mute">Encodage</span>
          <div className="seg">
            <button data-on={!gpu} disabled={run} onClick={() => chooseGpu(false)}>Qualité (CPU)</button>
            <button data-on={gpu} disabled={run} onClick={() => chooseGpu(true)}>Rapide (GPU)</button>
          </div>
          <span className="text-faint">{gpu ? 'Puce graphique du Mac : 2× plus rapide, qualité identique à l’œil, fichier parfois un peu plus lourd.' : 'Taille la plus régulière, sans perte visible.'}</span>
        </div>
        {jobs.length === 0 ? (
          <button
            onClick={() => inputRef.current.click()}
            className={`rise grid flex-1 place-items-center rounded-2xl border-2 border-dashed transition-all duration-300 ${over ? 'scale-[0.99] border-accent bg-accent/5' : 'border-line hover:border-line-2'}`}
          >
            <div className="text-center">
              <div className={`mx-auto mb-4 grid size-14 place-items-center rounded-2xl ${over ? 'bg-accent text-[#140802]' : 'bg-panel-2 text-mute'}`}>
                {planning ? <Loader2 size={22} className="animate-spin" /> : <Crop size={22} />}
              </div>
              <div className="text-[15px] font-semibold">Glisse un dossier ou des vidéos ici</div>
              <div className="mt-1 text-mute">Les sous-dossiers sont gardés. Chaque vidéo devient « nom 4x5.mp4 ».</div>
            </div>
          </button>
        ) : (
          <div className="card flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center gap-3 border-b border-line px-4 py-3 text-[12px] text-mute">
              {running ? <Loader2 size={14} className="animate-spin text-accent" /> : <Crop size={14} className="text-faint" />}
              <span className="flex-1">
                {jobs.length} vidéo{jobs.length > 1 ? 's' : ''}
                {todo ? ` · ${todo} à convertir` : ''}
                {running ? ` · en cours : ${base(running.src)} ${running.pct || 0} %` : ''}
                {planning ? ' · analyse…' : ''}
              </span>
              {!run && <button className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => setJobs([])}>Vider la liste</button>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {groups.map((g) => {
                const list = jobs.filter((j) => (j.root ?? '') === g);
                const paired = list.some((j) => j.paired); // deliverables: 9x16 → its 4x5 twin
                const outRoot = g ? (paired ? '4x5' : `${g} 4x5`) : null;
                return (
                  <div key={g || 'files'} className="mb-2">
                    <div className="flex items-center gap-2 px-2 py-1.5 text-[12px]">
                      <Folder size={13} className="shrink-0 text-faint" />
                      <span className="truncate font-medium">{g ? (paired ? `${base(g)} → dossiers 4x5 à côté des 9x16` : `${base(g)} → ${base(outRoot)}`) : 'Vidéos seules (copie à côté de chaque vidéo)'}</span>
                      {outRoot && list.some((j) => j.state === 'done' || j.state === 'skipped') && (
                        <button className="ml-auto shrink-0 text-[11.5px] text-accent hover:underline" onClick={() => kit.reveal(list.find((j) => j.state === 'done' || j.state === 'skipped').out)}>Afficher</button>
                      )}
                    </div>
                    {list.map((j) => <Row key={j.src} job={j} onRemove={!run && j.state !== 'running' ? () => setJobs((js) => js.filter((x) => x.src !== j.src)) : null} />)}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ job, onRemove }) {
  const s = job.state;
  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-panel">
      {s === 'done' || s === 'skipped' ? <Check size={14} className="shrink-0 text-ok" />
        : s === 'error' ? <AlertCircle size={14} className="shrink-0 text-bad" />
        : s === 'running' ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
        : <span className="size-3.5 shrink-0 rounded-full border border-line-2" />}
      <span className="min-w-0 flex-1 truncate text-[12.5px]" title={job.src}>{job.rel}</span>
      <span className={`shrink-0 text-[11.5px] ${s === 'error' ? 'text-bad' : 'text-faint'}`} title={job.error || ''}>
        {s === 'done' ? `${mo(job.size)} → ${mo(job.outSize)}`
          : s === 'skipped' ? 'déjà fait'
          : s === 'same' ? 'déjà en 4:5'
          : s === 'running' ? `${job.pct || 0} %`
          : s === 'error' ? 'erreur'
          : `${job.info ? `${job.info.width}×${job.info.height} → ${job.crop.w}×${job.crop.h}` : ''} · ${mo(job.size)}`}
      </span>
      {onRemove && <button onClick={onRemove} className="shrink-0 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-ink"><X size={12} /></button>}
    </div>
  );
}
