import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, Copy, ImagePlus, Search, X, ClipboardPaste, MoreHorizontal } from 'lucide-react';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';
import { normalizeHex, formatColor, isLight, parseColorList, extractPalette } from '../lib/colors.js';

const uid = () => Math.random().toString(36).slice(2, 10);
const FORMATS = [
  { id: 'hex', label: 'HEX' },
  { id: 'hexplain', label: 'HEX sans #' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hsl', label: 'HSL' },
];

export default function Palettes() {
  const notify = useToast();
  const [palettes, setPalettes] = useState(null);
  const [format, setFormat] = useState('hex');
  const [q, setQ] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    kit.store.get('palettes', []).then((p) => setPalettes(p || []));
    kit.store.get('paletteFormat', 'hex').then((f) => f && setFormat(f));
  }, []);

  const save = (next) => {
    setPalettes(next);
    kit.store.set('palettes', next);
  };
  const update = (id, fn) => save(palettes.map((p) => (p.id === id ? fn(p) : p)));
  const setFmt = (f) => { setFormat(f); kit.store.set('paletteFormat', f); };

  const create = (name = 'Nouvelle palette', colors = []) => {
    const p = { id: uid(), name, colors: colors.map((hex) => ({ id: uid(), hex })), createdAt: Date.now() };
    save([p, ...(palettes || [])]);
    return p;
  };

  const fromImage = async (file) => {
    if (!file?.type.startsWith('image/')) return;
    const colors = await extractPalette(file, 6);
    create(file.name.replace(/\.[^.]+$/, ''), colors);
    notify(`Palette extraite · ${colors.length} couleurs`);
  };

  const copy = async (hex) => {
    const text = formatColor(hex, format);
    await kit.copy(text);
    notify(`${text} copié`, { swatch: hex });
  };

  const filtered = useMemo(() => {
    if (!palettes) return [];
    const s = q.trim().toLowerCase();
    if (!s) return palettes;
    return palettes.filter((p) => p.name.toLowerCase().includes(s) || p.colors.some((c) => c.hex.includes(s.replace('#', ''))));
  }, [palettes, q]);

  if (!palettes) return null;

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => {
        setDragOver(false);
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
        if (f && !e.defaultPrevented) { e.preventDefault(); fromImage(f); }
      }}
    >
      <PageHeader title="Palettes" sub="Clique sur une couleur pour la copier. Glisse une image pour en extraire la palette.">
        <div className="relative">
          <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <input className="field w-44 pl-7" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg">
          {FORMATS.map((f) => (
            <button key={f.id} data-on={format === f.id} onClick={() => setFmt(f.id)}>{f.label}</button>
          ))}
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { fromImage(e.target.files[0]); e.target.value = ''; }} />
        <button className="btn" onClick={() => fileRef.current.click()}><ImagePlus size={14} /> Depuis une image</button>
        <button className="btn btn-primary" onClick={() => create()}><Plus size={14} strokeWidth={2.5} /> Palette</button>
      </PageHeader>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        {palettes.length === 0 ? (
          <Empty onCreate={() => create()} onImage={() => fileRef.current.click()} />
        ) : (
          <div className="flex flex-col gap-4">
            {filtered.map((p, i) => (
              <PaletteCard
                key={p.id}
                palette={p}
                index={i}
                format={format}
                onCopy={copy}
                onChange={(fn) => update(p.id, fn)}
                onDelete={() => { save(palettes.filter((x) => x.id !== p.id)); notify(`« ${p.name} » supprimée`); }}
                onCopyAll={async () => {
                  await kit.copy(p.colors.map((c) => formatColor(c.hex, format)).join('\n'));
                  notify(`${p.colors.length} couleurs copiées`);
                }}
                onImage={async (file) => {
                  const colors = await extractPalette(file, 6);
                  update(p.id, (x) => ({ ...x, colors: [...x.colors, ...colors.map((hex) => ({ id: uid(), hex }))] }));
                  notify(`${colors.length} couleurs ajoutées`);
                }}
              />
            ))}
            {filtered.length === 0 && <p className="py-16 text-center text-mute">Aucune palette ne correspond à « {q} ».</p>}
          </div>
        )}
        {dragOver && (
          <div className="pointer-events-none fixed inset-0 left-[212px] z-40 grid place-items-center bg-bg/70 backdrop-blur-sm">
            <div className="rounded-2xl border-2 border-dashed border-accent px-10 py-8 text-center">
              <ImagePlus className="mx-auto mb-2 text-accent" />
              <div className="font-medium">Dépose l’image pour créer une palette</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ onCreate, onImage }) {
  const demo = ['#0b0b0d', '#ff6a3d', '#ffd166', '#06d6a0', '#118ab2', '#ededf0'];
  return (
    <div className="rise mx-auto mt-16 max-w-md text-center">
      <div className="mx-auto mb-6 flex h-14 w-64 overflow-hidden rounded-xl ring-1 ring-line">
        {demo.map((c) => <div key={c} className="flex-1" style={{ background: c }} />)}
      </div>
      <h2 className="text-[16px] font-semibold">Aucune palette pour l’instant</h2>
      <p className="mt-1.5 text-mute">Crée une palette pour un client ou un étalonnage, ou glisse une image pour en extraire les couleurs.</p>
      <div className="mt-5 flex justify-center gap-2">
        <button className="btn" onClick={onImage}><ImagePlus size={14} /> Depuis une image</button>
        <button className="btn btn-primary" onClick={onCreate}><Plus size={14} strokeWidth={2.5} /> Nouvelle palette</button>
      </div>
    </div>
  );
}

function PaletteCard({ palette, index, format, onCopy, onChange, onDelete, onCopyAll, onImage }) {
  const [adding, setAdding] = useState(palette.colors.length === 0);
  const [menu, setMenu] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [imgOver, setImgOver] = useState(false);
  const imgRef = useRef();

  const addColors = (hexes) => {
    if (!hexes.length) return;
    onChange((p) => ({ ...p, colors: [...p.colors, ...hexes.map((hex) => ({ id: uid(), hex }))] }));
  };
  const remove = (id) => onChange((p) => ({ ...p, colors: p.colors.filter((c) => c.id !== id) }));
  const move = (fromId, toId) => {
    if (fromId === toId) return;
    onChange((p) => {
      const cs = [...p.colors];
      const from = cs.findIndex((c) => c.id === fromId);
      const to = cs.findIndex((c) => c.id === toId);
      const [it] = cs.splice(from, 1);
      cs.splice(to, 0, it);
      return { ...p, colors: cs };
    });
  };

  return (
    <section
      className={`card rise group/card p-4 transition-colors ${imgOver ? 'border-accent' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
      onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) { e.preventDefault(); e.stopPropagation(); setImgOver(true); } }}
      onDragLeave={() => setImgOver(false)}
      onDrop={(e) => {
        setImgOver(false);
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
        if (f) { e.preventDefault(); e.stopPropagation(); onImage(f); }
      }}
    >
      <div className="mb-3 flex items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-[14px] font-semibold outline-none hover:bg-panel-2 focus:bg-panel-2"
          value={palette.name}
          onChange={(e) => onChange((p) => ({ ...p, name: e.target.value }))}
          spellCheck={false}
        />
        <span className="text-[11.5px] text-faint">{palette.colors.length} couleurs</span>
        <button className="btn btn-ghost h-7 px-2" onClick={onCopyAll} disabled={!palette.colors.length} title="Copier toutes les couleurs"><Copy size={13} /> Tout copier</button>
        <div className="relative">
          <button className="btn btn-ghost btn-icon h-7 w-7" onClick={() => setMenu((m) => !m)}><MoreHorizontal size={15} /></button>
          {menu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
              <div className="rise absolute right-0 z-20 mt-1 w-48 rounded-xl border border-line-2 bg-[#1a1a1f] p-1 shadow-2xl shadow-black/50" style={{ animationDuration: '0.2s' }}>
                <MenuItem icon={ImagePlus} onClick={() => { setMenu(false); imgRef.current.click(); }}>Ajouter depuis une image</MenuItem>
                <MenuItem icon={Trash2} danger onClick={() => { setMenu(false); onDelete(); }}>Supprimer la palette</MenuItem>
              </div>
            </>
          )}
          <input ref={imgRef} type="file" accept="image/*" hidden onChange={(e) => { if (e.target.files[0]) onImage(e.target.files[0]); e.target.value = ''; }} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {palette.colors.map((c) => (
          <Swatch
            key={c.id}
            color={c}
            label={formatColor(c.hex, format)}
            onCopy={() => onCopy(c.hex)}
            onRemove={() => remove(c.id)}
            dragging={dragId === c.id}
            onDragStart={() => setDragId(c.id)}
            onDragEnd={() => setDragId(null)}
            onDragEnterSwatch={() => dragId && move(dragId, c.id)}
          />
        ))}
        {adding ? (
          <AddColor onAdd={addColors} onClose={() => setAdding(false)} />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="grid h-[104px] w-[92px] place-items-center rounded-xl border border-dashed border-line-2 text-faint transition-colors hover:border-accent hover:text-accent"
            title="Ajouter une couleur"
          >
            <Plus size={18} />
          </button>
        )}
      </div>
    </section>
  );
}

function MenuItem({ icon: Icon, children, onClick, danger }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] hover:bg-panel-2 ${danger ? 'text-bad' : ''}`}>
      <Icon size={13} /> {children}
    </button>
  );
}

function Swatch({ color, label, onCopy, onRemove, dragging, onDragStart, onDragEnd, onDragEnterSwatch }) {
  const [pulse, setPulse] = useState(0);
  const light = isLight(color.hex);
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', color.hex); onDragStart(); }}
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnterSwatch}
      onDragOver={(e) => e.preventDefault()}
      className={`group relative w-[92px] transition-opacity ${dragging ? 'opacity-30' : ''}`}
    >
      <button
        key={pulse}
        onClick={() => { onCopy(); setPulse((p) => p + 1); }}
        className={`${pulse ? 'pop' : ''} relative block h-[76px] w-full overflow-hidden rounded-xl ring-1 ring-white/10 ring-inset transition-transform duration-200 hover:-translate-y-0.5`}
        style={{ background: color.hex, transitionTimingFunction: 'var(--ease-out-expo)' }}
        title={`Copier ${label}`}
      >
        <span
          className={`absolute inset-x-0 bottom-0 py-1 text-[10.5px] font-semibold tracking-wide opacity-0 transition-opacity group-hover:opacity-100 ${light ? 'text-black/70' : 'text-white/85'}`}
        >
          COPIER
        </span>
      </button>
      <div className="mt-1.5 truncate px-0.5 font-mono text-[11px] text-mute" data-selectable>{label}</div>
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 grid size-5 scale-75 place-items-center rounded-full border border-line-2 bg-[#1f1f25] text-mute opacity-0 transition-all group-hover:scale-100 group-hover:opacity-100 hover:text-bad"
        title="Retirer"
      >
        <X size={11} strokeWidth={2.5} />
      </button>
    </div>
  );
}

function AddColor({ onAdd, onClose }) {
  const [hex, setHex] = useState('#ff6a3d');
  const [text, setText] = useState('');
  const inputRef = useRef();
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = () => {
    const list = parseColorList(text);
    const one = normalizeHex(text);
    if (list.length) onAdd(list);
    else if (one) onAdd([one]);
    else if (!text.trim()) onAdd([hex]);
    else return;
    setText('');
  };

  return (
    <div className="rise flex h-[104px] items-stretch gap-2 rounded-xl border border-line-2 bg-bg p-2" style={{ animationDuration: '0.25s' }}>
      <label className="relative w-[60px] cursor-pointer overflow-hidden rounded-lg ring-1 ring-white/10" style={{ background: normalizeHex(text) || hex }}>
        <input type="color" value={hex} onChange={(e) => { setHex(e.target.value); setText(''); }} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      <div className="flex w-[210px] flex-col gap-1.5">
        <input
          ref={inputRef}
          className="field h-7 font-mono"
          placeholder="#hex, liste, ou lien coolors"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            const list = parseColorList(t);
            if (list.length > 1) { e.preventDefault(); onAdd(list); }
          }}
        />
        <div className="flex items-center gap-1 text-[10.5px] text-faint"><ClipboardPaste size={11} /> Colle plusieurs codes d’un coup</div>
        <div className="mt-auto flex gap-1.5">
          <button className="btn btn-primary h-7 flex-1 justify-center" onClick={submit}>Ajouter</button>
          <button className="btn h-7" onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}
