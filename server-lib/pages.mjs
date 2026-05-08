export function renderPage({
  authState,
  codexHome,
  contextId,
  contextName,
  contextType,
  escapeHtml,
  loginCommand,
  loginHint,
  workspaceRoot,
}) {
  const subtitle = contextName
    ? `${contextType} #${contextId}: ${contextName}`
    : 'OpenAI Codex sidecar is ready for your host app.';

  const authBadge = authState === 'api_key'
    ? 'API key detected'
    : 'ChatGPT sign-in mode';

  const authHelp = authState === 'api_key'
    ? 'This container can answer requests with the configured OpenAI API key.'
    : 'Use the CMS provider connection flow to start ChatGPT sign-in for the official Codex CLI.';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f4f6;
      --panel: #ffffff;
      --line: #d7dbe2;
      --text: #1f2937;
      --muted: #64748b;
      --accent: #2563eb;
      --good: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%);
      color: var(--text);
    }
    .shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1rem;
    }
    .hero, .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    .hero {
      padding: 1rem 1rem 1.1rem;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 0.76rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    h1 {
      margin: 0 0 0.35rem;
      font-size: 1.15rem;
      line-height: 1.2;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
    }
    .card {
      padding: 1rem;
    }
    .label {
      font-size: 0.82rem;
      color: var(--muted);
      margin-bottom: 0.35rem;
    }
    .value {
      font-weight: 600;
      word-break: break-word;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.35rem 0.6rem;
      border-radius: 999px;
      background: rgba(15, 118, 110, 0.08);
      color: var(--good);
      font-size: 0.82rem;
      font-weight: 600;
      margin-top: 0.75rem;
    }
    .status-dot {
      width: 0.55rem;
      height: 0.55rem;
      border-radius: 999px;
      background: currentColor;
    }
    .commands {
      margin-top: 0.85rem;
      padding: 0.85rem;
      border-radius: 12px;
      background: #0f172a;
      color: #e2e8f0;
      overflow-x: auto;
      font-size: 0.86rem;
    }
    .commands code {
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="eyebrow">OpenAI Codex</div>
      <h1>Codex sidecar is available in the CMS</h1>
      <p>${escapeHtml(subtitle)}</p>
      <div class="status">
        <span class="status-dot"></span>
        ${escapeHtml(authBadge)}
      </div>
    </section>

    <section class="grid">
      <article class="card">
        <div class="label">Workspace</div>
        <div class="value">${escapeHtml(workspaceRoot)}</div>
      </article>
      <article class="card">
        <div class="label">Codex Home</div>
        <div class="value">${escapeHtml(codexHome)}</div>
      </article>
      <article class="card">
        <div class="label">Authentication</div>
        <div class="value">${escapeHtml(authHelp)}</div>
      </article>
    </section>

    <section class="card">
      <div class="label">Next Step</div>
      <div class="value">${escapeHtml(loginHint)}</div>
      <div class="commands"><code>${escapeHtml(loginCommand)}</code></div>
    </section>
  </div>
</body>
</html>`;
}

export function renderCmsThinkingPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Thinking</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111827;
      color: #e5e7eb;
      font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 16px;
    }
    .card {
      width: min(560px, 100%);
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 12px;
      box-shadow: 0 16px 32px rgba(0, 0, 0, 0.35);
      padding: 18px;
    }
    .title {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 10px;
      font-size: 19px;
      font-weight: 600;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid #6b7280;
      border-top-color: #ffffff;
      animation: spin 0.9s linear infinite;
    }
    .status {
      color: #cbd5e1;
      font-size: 14px;
      min-height: 20px;
      margin-bottom: 10px;
    }
    .events {
      border: 1px solid #374151;
      border-radius: 10px;
      background: #111827;
      color: #93c5fd;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      max-height: 220px;
      overflow: auto;
      padding: 10px 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="title"><span class="spinner" aria-hidden="true"></span><span>Codex Thinking...</span></h1>
    <div class="status" id="status">Waiting for request from host app...</div>
    <div class="events" id="events"></div>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const eventsEl = document.getElementById('events');
    let running = false;

    function setStatus(text) {
      statusEl.textContent = String(text || '');
      window.parent.postMessage({ type: 'codex_thinking_status', status: String(text || '') }, '*');
    }

    function pushEvent(text) {
      const eventText = String(text || '').trim();
      if (!eventText) return;
      const line = '[' + new Date().toLocaleTimeString() + '] ' + eventText;
      eventsEl.textContent += (eventsEl.textContent ? '\\n' : '') + line;
      eventsEl.scrollTop = eventsEl.scrollHeight;
      window.parent.postMessage({ type: 'codex_thinking_event', event: eventText }, '*');
    }

    function normalizeGeneratedHtml(raw) {
      let value = String(raw || '').trim();
      if (!value) return '';
      const fence = String.fromCharCode(96, 96, 96);
      const lower = value.toLowerCase();
      const firstFence = value.indexOf(fence);
      const secondFence = firstFence >= 0 ? value.indexOf(fence, firstFence + fence.length) : -1;
      if (firstFence >= 0 && secondFence > firstFence) {
        let inner = value.slice(firstFence + fence.length, secondFence).trim();
        if (inner.toLowerCase().startsWith('html')) {
          inner = inner.slice(4).trim();
        }
        value = inner;
      } else if (lower.startsWith(fence)) {
        value = value.slice(fence.length).trim();
        if (value.toLowerCase().startsWith('html')) {
          value = value.slice(4).trim();
        }
        if (value.endsWith(fence)) {
          value = value.slice(0, -fence.length).trim();
        }
      }
      const lowerValue = value.toLowerCase();
      if (lowerValue.startsWith('use this as ')) {
        const firstColon = value.indexOf(':');
        if (firstColon >= 0) {
          value = value.slice(firstColon + 1).trim();
        }
      }
      const tailMarker = '\\nif you want, i can also provide:';
      const markerIndex = value.toLowerCase().indexOf(tailMarker.trim());
      if (markerIndex >= 0) {
        value = value.slice(0, markerIndex).trim();
      }
      return value;
    }

    function extractAssistantText(session) {
      const messages = Array.isArray(session && session.messages) ? session.messages : [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'assistant') continue;
        const text = String(message.text || '').trim();
        if (text && text.toLowerCase() !== 'no response returned.') return text;
      }
      return '';
    }

    async function runTurn(payload) {
      if (running) return;
      running = true;
      try {
        const mode = String(payload.mode || '').trim();
        const prompt = String(payload.prompt || '').trim();
        const kind = String(payload.kind || '').trim();
        const schemaFields = Array.isArray(payload.schema_fields) ? payload.schema_fields : [];
        if (!prompt) throw new Error('Missing prompt.');

        setStatus('Creating Codex session...');
        const createResp = await fetch('/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ mode: 'workspace', context: {} }),
        });
        const createPayload = await createResp.json();
        const sessionId = String(createPayload?.session?.id || '');
        if (!createResp.ok || !sessionId) {
          throw new Error(String(createPayload?.error || 'Unable to create session.'));
        }
        pushEvent('Session started: ' + sessionId);

        let message = '';
        if (mode === 'add-module') {
          message = [
            'Create Bootstrap form-template HTML for this CMS module.',
            'Return only final HTML (no markdown, no commentary).',
            'Use schema field names exactly as provided for form controls.',
            'Module kind: ' + kind,
            'Module idea: ' + prompt,
            'Schema fields JSON: ' + JSON.stringify(schemaFields),
          ].join('\\n\\n');
        } else if (mode === 'add-form') {
          message = [
            (kind === 'signup'
              ? 'Create a Bootstrap form-template HTML for a signup form.'
              : 'Create a Bootstrap form-template HTML for a contact form.'),
            'Return only final HTML (no markdown, no commentary).',
            'Form idea: ' + prompt,
          ].join('\\n\\n');
        } else {
          message = [
            (kind === 'landing'
              ? 'Create a Bootstrap homepage HTML for this website idea and include a clear how-to-play style section for a lead form embed.'
              : 'Create a Bootstrap homepage HTML for this website idea.'),
            'Return only final HTML (no markdown, no commentary).',
            'Website idea: ' + prompt,
          ].join('\\n\\n');
        }

        setStatus('Sending prompt to Codex...');
        const sendResp = await fetch('/chat/sessions/' + encodeURIComponent(sessionId) + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ message }),
        });
        const sendPayload = await sendResp.json();
        if (!sendResp.ok || sendPayload?.ok === false) {
          throw new Error(String(sendPayload?.error || 'Unable to send prompt.'));
        }
        pushEvent('Prompt accepted.');

        setStatus('Codex is thinking...');
        const startedAt = Date.now();
        while ((Date.now() - startedAt) < 240000) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const pollResp = await fetch('/chat/sessions/' + encodeURIComponent(sessionId), {
            headers: { 'Accept': 'application/json' },
          });
          const pollPayload = await pollResp.json();
          const session = pollPayload?.session || {};
          const status = String(session?.status || '');

          if (status === 'error') {
            throw new Error(String(session?.last_error || 'Codex returned an error.'));
          }

          const events = Array.isArray(session?.events) ? session.events : [];
          if (events.length > 0) {
            const lastEvent = events[events.length - 1];
            const eventText = String(lastEvent?.preview || lastEvent?.text || '').trim();
            if (eventText) pushEvent(eventText);
          }

          if (status === 'idle') {
            const html = normalizeGeneratedHtml(extractAssistantText(session));
            if (!html) {
              throw new Error('Codex finished without returning HTML.');
            }
            setStatus('Complete.');
            window.parent.postMessage({
              type: 'codex_thinking_complete',
              mode,
              session_id: sessionId,
              html,
            }, '*');
            return;
          }
        }

        throw new Error('Codex generation timed out.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Generation failed.';
        setStatus(message);
        window.parent.postMessage({ type: 'codex_thinking_error', error: message }, '*');
      } finally {
        running = false;
      }
    }

    window.addEventListener('message', (event) => {
      const data = event?.data || {};
      if (data.type !== 'codex_thinking_start') return;
      runTurn(data.payload || {});
    });
  </script>
</body>
</html>`;
}
