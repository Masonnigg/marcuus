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
    ask: async () => ({ ok: false, error: 'Disponible uniquement dans l’app MARCUUS.' }),
    cancel: async () => {},
    status: async () => ({ installed: false, loggedIn: false }),
  },
  openai: {
    ask: async () => ({ ok: false, error: 'Disponible uniquement dans l’app MARCUUS.' }),
    cancel: async () => {},
    status: async () => ({ ok: false, error: 'Disponible uniquement dans l’app MARCUUS.' }),
  },
  probe: async () => { throw new Error('Disponible uniquement dans l’app MARCUUS.'); },
  chatgpt: {
    signIn: async () => ({ ok: false, error: 'Disponible uniquement dans l’app MARCUUS.' }),
    cancelSignIn: async () => {},
    signOut: async () => ({ ok: true, signedIn: false }),
    status: async () => ({ signedIn: false }),
    models: async () => ({ ok: false, error: 'Disponible uniquement dans l’app MARCUUS.' }),
    ask: async () => ({ ok: false, error: 'Disponible uniquement dans l’app MARCUUS.' }),
    cancel: async () => {},
  },
  version: async () => 'dev',
  update: { check: async () => null, install: async () => {}, openPage: async () => {}, onProgress: () => () => {}, onAvailable: () => () => {} },
  stock: {
    search: async () => ({ items: [], errors: { app: 'Disponible uniquement dans l’app MARCUUS.' } }),
    download: async () => { throw new Error('Disponible uniquement dans l’app MARCUUS.'); },
  },
};

export const kit = window.kit || mock;
