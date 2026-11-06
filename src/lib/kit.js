// Bridge to the Electron main process. In a plain browser (dev preview) a
// localStorage-backed mock keeps the UI usable.
const mock = {
  isMock: true,
  store: {
    get: async (k, f) => { try { const v = localStorage.getItem('kit:' + k); return v ? JSON.parse(v) : f; } catch { return f; } },
    set: async (k, v) => { localStorage.setItem('kit:' + k, JSON.stringify(v)); return true; },
  },
  copy: async (t) => navigator.clipboard?.writeText(t),
  open: async (u) => window.open(u, '_blank'),
  reveal: async () => {},
  openFolder: async () => {},
  pathFor: () => null,
  writeFile: async () => null,
  exists: async () => false,
  saveAs: async (name, content) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    a.download = name.split('/').pop();
    a.click();
    return name;
  },
  saveText: async (name, content) => mock.saveAs(name, content),
  pickFolder: async () => null,
  defaults: async () => ({ downloadsDir: '~/Downloads/B-roll', claudePath: null }),
  claude: {
    ask: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }),
    cancel: async () => {},
    status: async () => ({ installed: false, loggedIn: false }),
  },
  openai: {
    ask: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }),
    cancel: async () => {},
    status: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }),
  },
  probe: async () => { throw new Error('Disponible uniquement dans l’app RYACHA.'); },
  fourfive: { plan: async () => [], convert: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }), cancel: async () => {}, onProgress: () => () => {} },
  ads: {
    prepare: async () => { throw new Error('Disponible uniquement dans l’app RYACHA.'); },
    listMedia: async () => [],
    writeJob: async () => null,
    thumbs: async () => [],
    readBrief: async () => { throw new Error('Disponible uniquement dans l’app RYACHA.'); },
    onProgress: () => () => {},
  },
  report: async () => false,
  premiere: {
    status: async () => ({ installed: false, linked: false, available: false }),
    install: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }),
  },
  chatgpt: {
    signIn: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }),
    cancelSignIn: async () => {},
    signOut: async () => ({ ok: true, signedIn: false }),
    status: async () => ({ signedIn: false }),
    models: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }),
    ask: async () => ({ ok: false, error: 'Disponible uniquement dans l’app RYACHA.' }),
    cancel: async () => {},
  },
  version: async () => 'dev',
  update: { check: async () => null, install: async () => {}, openPage: async () => {}, onProgress: () => () => {}, onAvailable: () => () => {} },
  stock: {
    search: async () => ({ items: [], errors: { app: 'Disponible uniquement dans l’app RYACHA.' } }),
    download: async () => { throw new Error('Disponible uniquement dans l’app RYACHA.'); },
  },
};

export const kit = window.kit || mock;
