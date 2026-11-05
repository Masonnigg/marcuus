// Talks to the panel's debug port. Usage:
//   node cdp.js es file.jsx       run ExtendScript in Premiere
//   node cdp.js esx "code"        run an ExtendScript snippet
//   node cdp.js js "code"         run JavaScript in the panel (await allowed)
const fs = require('fs');

async function evaluate(expression) {
  const res = await fetch(`http://localhost:${process.env.PANEL_PORT || 8098}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.webSocketDebuggerUrl);
  if (!page) throw new Error('no panel target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const answer = new Promise((resolve) => {
    ws.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if (data.id === 1) resolve(data);
    };
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const data = await answer;
  ws.close();
  if (data.result && data.result.exceptionDetails) return 'EXCEPTION ' + JSON.stringify(data.result.exceptionDetails.exception || data.result.exceptionDetails);
  return data.result ? data.result.result.value : JSON.stringify(data);
}

(async () => {
  const [mode, arg] = process.argv.slice(2);
  const es = (code) => `new Promise((r) => window.__adobe_cep__.evalScript(${JSON.stringify(code)}, r))`;
  let out;
  if (mode === 'es') out = await evaluate(es(fs.readFileSync(arg, 'utf8')));
  else if (mode === 'esx') out = await evaluate(es(arg));
  else out = await evaluate(`(async () => { ${arg} })()`);
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
