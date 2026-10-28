import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Palette, Captions, Clapperboard, Settings as Cog, Check, AudioLines, FishingHook } from 'lucide-react';
import Palettes from './pages/Palettes.jsx';
import Transcribe from './pages/Transcribe.jsx';
import SrtFixer from './pages/SrtFixer.jsx';
import Broll from './pages/Broll.jsx';
import Hook from './pages/Hook.jsx';
import Settings from './pages/Settings.jsx';
import { kit } from './lib/kit.js';
import avatar from './assets/avatar.png?inline';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

const NAV = [
  { id: 'transcribe', label: 'Transcrire', icon: AudioLines },
  { id: 'srt', label: 'SRT Fixer', icon: Captions },
  { id: 'broll', label: 'B-roll', icon: Clapperboard },
  { id: 'hook', label: 'Hook', icon: FishingHook },
  { id: 'palettes', label: 'Palettes', icon: Palette },
];

export default function App() {
  const [update, setUpdate] = useState(null); // a newer version exists → the app is locked until updated
  useEffect(() => {
    kit.update.check().then((u) => u && setUpdate(u));
    return kit.update.onAvailable((u) => setUpdate(u));
  }, []);
  if (update) return <UpdateGate update={update} />;
  return <Main />;
}

function Main() {
  const [page, setPage] = useState('palettes');
  const [toast, setToast] = useState(null);
  const [brollInput, setBrollInput] = useState(null); // { name, path, cues }
  const [fixerInput, setFixerInput] = useState(null); // { name, path, raw }
  const [hookInput, setHookInput] = useState(null); // { name, path, words, duration }
  const timer = useRef();

  const notify = useCallback((msg, opts = {}) => {
    clearTimeout(timer.current);
    setToast({ msg, swatch: opts.swatch, tone: opts.tone, action: opts.action, key: Date.now() });
    timer.current = setTimeout(() => setToast(null), opts.ms || 1600);
  }, []);

  useEffect(() => {
    kit.store.get('ui', {}).then((ui) => ui?.page && setPage(ui.page));
  }, []);
  const go = (p) => { setPage(p); kit.store.set('ui', { page: p }); };

  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey) return;
      const ids = [...NAV.map((n) => n.id), 'settings'];
      const i = e.key === ',' ? ids.length - 1 : Number(e.key) - 1;
      if (!(i >= 0 && i < ids.length)) return;
      e.preventDefault();
      go(ids[i]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sendToBroll = (payload) => { setBrollInput({ ...payload, at: Date.now() }); go('broll'); };
  const sendToFixer = (payload) => { setFixerInput({ ...payload, at: Date.now() }); go('srt'); };
  const sendToHook = (payload) => { setHookInput({ ...payload, at: Date.now() }); go('hook'); };

  return (
    <ToastCtx.Provider value={notify}>
      <div className="flex h-full">
        <aside className="drag flex w-[212px] shrink-0 flex-col border-r border-line bg-panel/60 px-3 pt-[54px] pb-3">
          <div className="no-drag mb-5 flex items-center gap-2.5 px-2">
            <img src={avatar} alt="" className="size-8 rounded-lg object-cover ring-1 ring-white/10" />
            <div className="leading-tight">
              <div className="text-[13px] font-bold tracking-[0.06em]">MARCUUS</div>
              <div className="text-[11px] text-faint">workflow de montage</div>
            </div>
          </div>
          <nav className="no-drag flex flex-col gap-0.5">
            {NAV.map((n, i) => (
              <NavItem key={n.id} {...n} active={page === n.id} onClick={() => go(n.id)} shortcut={`⌘${i + 1}`} />
            ))}
          </nav>
          <div className="mt-auto no-drag">
            <NavItem id="settings" label="Réglages" icon={Cog} active={page === 'settings'} onClick={() => go('settings')} shortcut="⌘," />
          </div>
        </aside>

        <main className="relative min-w-0 flex-1">
          <div className="drag absolute inset-x-0 top-0 h-[38px]" />
          {/* Transcrire and Hook stay mounted so running jobs and edits survive tab switches */}
          <div className="h-full" hidden={page !== 'transcribe'}>
            <Transcribe onSendToBroll={sendToBroll} onSendToFixer={sendToFixer} onSendToHook={sendToHook} />
          </div>
          <div className="h-full" hidden={page !== 'hook'}>
            <Hook active={page === 'hook'} input={hookInput} goSettings={() => go('settings')} goTranscribe={() => go('transcribe')} />
          </div>
          <div className="h-full" key={page} hidden={page === 'transcribe' || page === 'hook'}>
            {page === 'palettes' && <Palettes />}
            {page === 'srt' && <SrtFixer onSendToBroll={sendToBroll} input={fixerInput} />}
            {page === 'broll' && <Broll input={brollInput} goSettings={() => go('settings')} />}
            {page === 'settings' && <Settings />}
          </div>
        </main>
      </div>

      {toast && (
        <div
          key={toast.key}
          className={`${toast.action ? '' : 'pointer-events-none '}fixed bottom-6 left-1/2 z-50 flex items-center gap-2.5 rounded-full border border-line-2 bg-[#1b1b20]/95 py-2 pr-4 pl-2.5 shadow-2xl shadow-black/60 backdrop-blur`}
          style={{ animation: 'toast-in 0.35s var(--ease-out-expo) both' }}
        >
          {toast.swatch ? (
            <span className="size-5 rounded-full ring-1 ring-white/15" style={{ background: toast.swatch }} />
          ) : (
            <span className={`grid size-5 place-items-center rounded-full ${toast.tone === 'bad' ? 'bg-bad/20 text-bad' : 'bg-ok/15 text-ok'}`}>
              <Check size={12} strokeWidth={3} />
            </span>
          )}
          <span className="text-[12.5px] font-medium">{toast.msg}</span>
          {toast.action && (
            <button
              onClick={() => { toast.action.onClick(); setToast(null); }}
              className="-my-1 ml-1 rounded-full bg-white/10 px-2.5 py-1 text-[12px] font-medium text-accent-2 transition-colors hover:bg-white/15"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

function NavItem({ label, icon: Icon, active, onClick, shortcut }) {
  return (
    <button
      onClick={onClick}
      className={`group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors ${
        active ? 'bg-panel-2 text-ink' : 'text-mute hover:bg-panel-2/60 hover:text-ink'
      }`}
    >
      <Icon size={15} className={active ? 'text-accent' : ''} />
      <span className="flex-1">{label}</span>
      <span className="text-[10.5px] text-faint opacity-0 transition-opacity group-hover:opacity-100">{shortcut}</span>
    </button>
  );
}

export function PageHeader({ title, sub, children }) {
  return (
    <header className="flex items-end justify-between gap-4 px-8 pt-[46px] pb-5">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
        {sub && <p className="mt-1 text-[12.5px] text-mute">{sub}</p>}
      </div>
      <div className="no-drag relative z-10 flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}

// Full-screen lock shown when a newer version is published (every version is required).
function UpdateGate({ update }) {
  const [state, setState] = useState(null); // { stage, got, total } | { error }
  useEffect(() => kit.update.onProgress((p) => setState(p)), []);
  const busy = state && !state.error;
  const pct = state?.total ? Math.round((state.got / state.total) * 100) : 0;
  const run = async () => {
    setState({ stage: 'download', got: 0, total: 0 });
    try { await kit.update.install(); } catch (e) {
      setState({ error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
    }
  };
  return (
    <div className="drag grid h-full place-items-center bg-bg px-6">
      <div className="no-drag rise w-full max-w-md text-center">
        <img src={avatar} alt="" className="mx-auto mb-5 size-16 rounded-2xl object-cover ring-1 ring-white/10" />
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Mise à jour requise</h1>
        <p className="mt-1.5 text-mute">MARCUUS {update.version} est disponible. Tu as la version {update.current}.<br />Mets à jour pour continuer, tes réglages et fichiers sont conservés.</p>
        {update.notes && (
          <div className="card mt-5 max-h-40 overflow-y-auto p-4 text-left text-[12.5px] whitespace-pre-line text-mute" data-selectable>{update.notes}</div>
        )}
        {state?.error ? (
          <div className="mt-5 rounded-lg bg-bad/10 px-3 py-2 text-left text-[12px] text-bad" data-selectable>{state.error}</div>
        ) : busy ? (
          <div className="mt-6">
            <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${state.stage === 'download' ? Math.max(3, pct) : 100}%` }} />
            </div>
            <div className="mt-2 text-[12px] text-mute">
              {state.stage === 'download' ? `Téléchargement… ${pct}%${state.total ? ` · ${(state.got / 1e6).toFixed(0)} / ${(state.total / 1e6).toFixed(0)} Mo` : ''}`
                : state.stage === 'unpack' ? 'Vérification…' : 'Redémarrage…'}
            </div>
          </div>
        ) : null}
        {!busy && (
          <div className="mt-6 flex justify-center gap-2">
            <button className="btn btn-primary h-9 px-5" onClick={run}>{state?.error ? 'Réessayer' : 'Mettre à jour'}</button>
            {state?.error && <button className="btn h-9" onClick={() => kit.update.openPage()}>Télécharger manuellement</button>}
          </div>
        )}
      </div>
    </div>
  );
}
