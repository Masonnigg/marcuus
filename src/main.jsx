import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { kit } from './lib/kit.js';
import './index.css';

// errors nobody caught on screen are reported (Réglages › Rapports d'erreur), like the ones behind buttons
const report = (err) => { try { kit.report({ where: 'écran', message: String(err?.message ?? err), stack: err?.stack, name: err?.name }); } catch {} };
window.addEventListener('error', (e) => report(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => report(e.reason));

createRoot(document.getElementById('root')).render(<App />);
