import { useEffect, useState } from 'react';
import { Check, ExternalLink, Eye, EyeOff, FolderOpen, RefreshCw, AlertCircle } from 'lucide-react';
import { PageHeader, useToast } from '../App.jsx';
import { kit } from '../lib/kit.js';
import { DEFAULT_EXPRESSIONS } from '../lib/segment.js';

const SOURCES = [
  { id: 'pexels', name: 'Pexels', what: 'Vidéos', url: 'https://www.pexels.com/api/new/', steps: 'Optionnel : Pexels a suspendu les nouvelles clés. Sans clé, utilise le bouton « Pexels » dans B-roll.' },
  { id: 'pixabay', name: 'Pixabay', what: 'Vidéos', url: 'https://pixabay.com/api/docs/#api_search_images', steps: 'Connecte-toi → la clé apparaît en vert dans la section « Parameters ».' },
];

export async function loadSettings() {
  const [s, d] = await Promise.all([kit.store.get('settings', {}), kit.defaults()]);
  return { keys: {}, downloadsDir: d.downloadsDir, model: 'sonnet', hookEngine: 'claude', openaiModel: 'gpt-6.1-sol', expressions: DEFAULT_EXPRESSIONS, ...(s || {}) };
}

export default function Settings() {
  const notify = useToast();
  const [s, setS] = useState(null);
  const [show, setShow] = useState({});
  const [claude, setClaude] = useState(null);
  const [openai, setOpenai] = useState(null); // result of "Tester": { ok, error, model } | 'checking'
  const [version, setVersion] = useState('');
  useEffect(() => { kit.version().then(setVersion); }, []);

  const checkClaude = () => { setClaude(null); kit.claude.status().then(setClaude); };
  useEffect(() => { loadSettings().then(setS); checkClaude(); }, []);

  const save = (patch) => {
    const next = { ...s, ...patch };
    setS(next);
    kit.store.set('settings', next);
  };

  if (!s) return null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Réglages" sub={`MARCUUS ${version} · tout est stocké en local sur ton Mac.`} />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        <div className="flex max-w-3xl flex-col gap-4">
          <section className="card rise p-5">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold">Claude</h2>
              <button className="btn btn-ghost h-7 px-2" onClick={checkClaude}><RefreshCw size={12} /> Vérifier</button>
            </div>
            <p className="mb-4 text-mute">Utilisé pour les idées de B-roll et l’onglet Hook. Passe par ton compte Claude (Claude Code), sans clé API ni coût en plus.</p>
            {!claude ? (
              <div className="skeleton h-9 rounded-lg" />
            ) : claude.loggedIn ? (
              <div className="flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-ok">
                <Check size={14} /> Connecté{claude.plan ? ` · ${claude.plan.toUpperCase()}` : ''}{claude.email ? ` · ${claude.email}` : ''}
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-warn">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  {claude.installed ? 'Claude Code est installé mais pas connecté.' : 'Claude Code n’est pas installé.'}
                  <div className="mt-1 text-mute">Dans le Terminal : <span className="kbd" data-selectable>{claude.installed ? 'claude' : 'curl -fsSL https://claude.ai/install.sh | bash'}</span> puis connecte-toi avec ton compte Claude.</div>
                </div>
              </div>
            )}
            <div className="mt-4 flex items-center gap-3">
              <span className="text-mute">Modèle</span>
              <div className="seg">
                {[['haiku', 'Rapide'], ['sonnet', 'Équilibré'], ['opus', 'Le meilleur']].map(([id, l]) => (
                  <button key={id} data-on={s.model === id} onClick={() => save({ model: id })}>{l}</button>
                ))}
              </div>
            </div>
          </section>

          <section className="card rise p-5" style={{ animationDelay: '20ms' }}>
            <h2 className="mb-1 text-[14px] font-semibold">Onglet Hook</h2>
            <p className="mb-4 text-mute">L’IA qui lit la transcription et trouve le hook, le body, les titres et la légende.</p>
            <div className="flex items-center gap-3">
              <span className="text-mute">Analyse avec</span>
              <div className="seg">
                {[['claude', 'Claude (ton abonnement)'], ['openai', 'ChatGPT (clé API)']].map(([id, l]) => (
                  <button key={id} data-on={(s.hookEngine || 'claude') === id} onClick={() => save({ hookEngine: id })}>{l}</button>
                ))}
              </div>
            </div>
            {s.hookEngine === 'openai' && (<>
            <div className="mt-4 mb-1.5 flex items-center justify-between">
              <p className="text-[12px] text-mute">Clé API créée sur platform.openai.com : séparée de ChatGPT Plus, payée à l’usage (quelques centimes par analyse).</p>
              <button className="flex shrink-0 items-center gap-1 text-[11.5px] text-accent hover:underline" onClick={() => kit.open('https://platform.openai.com/api-keys')}>
                Obtenir une clé <ExternalLink size={11} />
              </button>
            </div>
            <div className="flex gap-2">
              <input
                className="field flex-1 font-mono"
                type={show.openai ? 'text' : 'password'}
                placeholder="Clé API OpenAI (sk-…)"
                value={s.keys.openai || ''}
                onChange={(e) => { setOpenai(null); save({ keys: { ...s.keys, openai: e.target.value.trim() } }); }}
                spellCheck={false}
              />
              <button className="btn btn-icon" onClick={() => setShow((x) => ({ ...x, openai: !x.openai }))}>
                {show.openai ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button className="btn" disabled={!s.keys.openai || openai === 'checking'} onClick={async () => { setOpenai('checking'); setOpenai(await kit.openai.status()); }}>
                {openai === 'checking' ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} Tester
              </button>
            </div>
            {openai && openai !== 'checking' && (
              <div className={`mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] ${openai.ok ? 'bg-ok/10 text-ok' : 'bg-bad/10 text-bad'}`}>
                {openai.ok ? <><Check size={13} /> Clé valide · {openai.model} disponible</> : <><AlertCircle size={13} /> {openai.error}</>}
              </div>
            )}
            <div className="mt-4 flex items-center gap-3">
              <span className="text-mute">Modèle</span>
              <div className="seg">
                {[['gpt-6-luna', 'Rapide'], ['gpt-6.1-sol', 'Équilibré'], ['gpt-6-astra', 'Le meilleur']].map(([id, l]) => (
                  <button key={id} data-on={s.openaiModel === id} onClick={() => { setOpenai(null); save({ openaiModel: id }); }}>{l}</button>
                ))}
              </div>
            </div>
            </>)}
          </section>

          <section className="card rise p-5" style={{ animationDelay: '40ms' }}>
            <h2 className="mb-1 text-[14px] font-semibold">Banques de vidéos gratuites</h2>
            <p className="mb-4 text-mute">Vidéos libres de droits. Chaque site donne une clé gratuite en 2 minutes, une seule suffit. Envato Elements s’ouvre dans ton navigateur depuis chaque recherche (pas d’API publique).</p>
            <div className="flex flex-col gap-4">
              {SOURCES.map((src) => (
                <div key={src.id}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="font-medium">{src.name}</span>
                    <span className="text-[11.5px] text-faint">{src.what}</span>
                    {s.keys[src.id] && <Check size={13} className="text-ok" />}
                    <button className="ml-auto flex items-center gap-1 text-[11.5px] text-accent hover:underline" onClick={() => kit.open(src.url)}>
                      Obtenir une clé <ExternalLink size={11} />
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      className="field flex-1 font-mono"
                      type={show[src.id] ? 'text' : 'password'}
                      placeholder={`Clé API ${src.name}`}
                      value={s.keys[src.id] || ''}
                      onChange={(e) => save({ keys: { ...s.keys, [src.id]: e.target.value.trim() } })}
                      spellCheck={false}
                    />
                    <button className="btn btn-icon" onClick={() => setShow((x) => ({ ...x, [src.id]: !x[src.id] }))}>
                      {show[src.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <p className="mt-1 text-[11.5px] text-faint">{src.steps}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="card rise p-5" style={{ animationDelay: '60ms' }}>
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold">Expressions à garder ensemble</h2>
              <button className="btn btn-ghost h-7 px-2 text-[12px]" onClick={() => { save({ expressions: DEFAULT_EXPRESSIONS }); notify('Liste par défaut rétablie'); }}>Rétablir la liste</button>
            </div>
            <p className="mb-3 text-mute">Le découpage intelligent ne coupe jamais au milieu de ces expressions. Une par ligne : ajoute les phrases fétiches de tes vidéos.</p>
            <textarea
              className="field w-full font-mono text-[12px]"
              rows={7}
              spellCheck={false}
              key={(s.expressions || []).join('|')}
              defaultValue={(s.expressions || []).join('\n')}
              onBlur={(e) => {
                const list = [...new Set(e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))];
                save({ expressions: list });
                notify(`${list.length} expressions enregistrées`);
              }}
            />
          </section>

          <section className="card rise p-5" style={{ animationDelay: '80ms' }}>
            <h2 className="mb-1 text-[14px] font-semibold">Téléchargements</h2>
            <p className="mb-3 text-mute">Les B-roll sont rangés dans un sous-dossier au nom de la vidéo.</p>
            <div className="flex gap-2">
              <input className="field flex-1 font-mono" value={s.downloadsDir} readOnly />
              <button
                className="btn"
                onClick={async () => { const p = await kit.pickFolder(s.downloadsDir); if (p) { save({ downloadsDir: p }); notify('Dossier mis à jour'); } }}
              >
                <FolderOpen size={14} /> Changer
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
