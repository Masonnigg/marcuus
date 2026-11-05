// The RYACHA panel for Premiere: it ships inside the app, this installs it (and the app keeps it up to date).
import { useEffect, useState } from 'react';
import { Check, Loader2, Download } from 'lucide-react';
import { kit } from '../lib/kit.js';

export function usePanelStatus() {
  const [st, setSt] = useState(null);
  useEffect(() => { kit.premiere.status().then(setSt).catch(() => setSt(null)); }, []);
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try { setSt(await kit.premiere.install()); } finally { setBusy(false); }
  };
  return { st, busy, install };
}

export function InstallButton({ st, busy, install, className = 'btn h-8' }) {
  return (
    <button className={className} disabled={busy || !st?.available} onClick={install}>
      {busy ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> : <Download size={13} />}
      {st?.installed ? 'Réinstaller' : 'Installer le panneau'}
    </button>
  );
}

/** Réglages: what is installed, and the button. */
export function PremierePanelSection() {
  const { st, busy, install } = usePanelStatus();
  if (!st) return null;
  const label = st.linked ? 'Lien de développement : suit le code directement'
    : st.installed ? (st.version === st.appVersion ? `Installé, à jour (${st.version})` : 'Installé, mise à jour au prochain lancement')
    : 'Pas installé';
  return (
    <section className="card rise p-5">
      <h2 className="mb-1 text-[14px] font-semibold">Panneau Premiere</h2>
      <p className="mb-4 text-mute">Le panneau RYACHA construit, sous-titre, zoome et exporte tes pubs dans Premiere. L’app le met à jour toute seule.</p>
      <div className="flex items-center gap-3">
        <span className={`flex items-center gap-1.5 ${st.installed ? 'text-ok' : 'text-mute'}`}>{st.installed && <Check size={14} />}{label}</span>
        {!st.linked && <span className="ml-auto"><InstallButton st={st} busy={busy} install={install} /></span>}
      </div>
      {st.ok && !st.dev && <p className="mt-3 text-[12px] text-mute">Redémarre Premiere, puis Fenêtre › Extensions › RYACHA.</p>}
      {st.error && <p className="mt-3 text-[12px] text-bad" data-selectable>{st.error}</p>}
    </section>
  );
}
