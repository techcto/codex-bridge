export function getChatWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Bridge Chat</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0f1d;
      --panel: #11182d;
      --panel-2: #0d1426;
      --line: #26324f;
      --text: #e8edf8;
      --muted: #98a8c8;
      --accent: #7dd3fc;
      --accent-2: #8b5cf6;
      --accent-3: #34d399;
      --error: #fca5a5;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(circle at top right, rgba(125,211,252,0.14), transparent 30%),
        radial-gradient(circle at bottom left, rgba(52,211,153,0.10), transparent 26%),
        var(--bg);
      color: var(--text);
      min-height: 100vh;
      height: 100vh;
      overflow: hidden;
    }
    .layout {
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr) 280px;
      min-height: 100vh;
      height: 100vh;
    }
    .layout.history-hidden {
      grid-template-columns: minmax(0, 1fr) 280px;
    }
    .rail,
    .context {
      background: rgba(8, 12, 24, 0.74);
      border-right: 1px solid var(--line);
      backdrop-filter: blur(12px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .context {
      border-right: 0;
      border-left: 1px solid var(--line);
      background: rgba(10, 15, 29, 0.82);
    }
    .rail.hidden {
      display: none;
    }
    .center {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto auto;
      min-height: 0;
    }
    .rail-head,
    .context-head {
      padding: 16px 16px 12px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .rail-title,
    .context-title {
      font-size: 16px;
      font-weight: 700;
    }
    .rail-search {
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
    }
    .rail-search input {
      width: 100%;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      padding: 10px 12px;
      font: inherit;
    }
    .thread-list {
      overflow-y: auto;
      padding: 10px 12px 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .thread-item {
      border: 1px solid transparent;
      border-radius: 14px;
      padding: 12px;
      background: rgba(17, 24, 45, 0.72);
      cursor: pointer;
    }
    .thread-item.active {
      border-color: rgba(125, 211, 252, 0.38);
      background: linear-gradient(135deg, rgba(125,211,252,0.12), rgba(139,92,246,0.10));
    }
    .thread-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .thread-summary {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      min-height: 16px;
    }
    .thread-meta {
      margin-top: 8px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: rgba(10, 15, 29, 0.82);
      backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }
    .header-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .icon-button {
      border: 1px solid var(--line);
      background: rgba(17, 24, 45, 0.86);
      color: var(--text);
      width: 36px;
      min-width: 36px;
      min-height: 36px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      padding: 0;
      cursor: pointer;
    }
    .header-copy {
      min-width: 0;
    }
    h1 {
      margin: 0;
      font-size: 16px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    #messages {
      overflow-y: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 0;
      padding-bottom: 26px;
    }
    .message {
      max-width: min(860px, 92%);
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: 18px;
      line-height: 1.45;
    }
    .message-body {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message-body > :first-child {
      margin-top: 0;
    }
    .message-body > :last-child {
      margin-bottom: 0;
    }
    .message-text {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .code-block {
      margin: 10px 0;
      border: 1px solid rgba(148, 163, 184, 0.22);
      border-radius: 14px;
      overflow: hidden;
      background: rgba(6, 10, 20, 0.92);
    }
    .code-block-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 10px;
      background: rgba(15, 23, 42, 0.96);
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    }
    .code-block-lang {
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .code-copy {
      border: 1px solid var(--line);
      background: rgba(17, 24, 45, 0.86);
      color: var(--text);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
    }
    .code-block pre {
      margin: 0;
      padding: 14px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre;
      color: #dbe7ff;
    }
    .code-block code {
      font-family: inherit;
    }
    .user {
      align-self: flex-end;
      background: rgba(125, 211, 252, 0.14);
      border-color: rgba(125, 211, 252, 0.30);
    }
    .assistant {
      align-self: flex-start;
      background: rgba(17, 24, 45, 0.94);
    }
    .system {
      align-self: center;
      background: rgba(12, 20, 38, 0.92);
      color: var(--muted);
    }
    .status {
      color: var(--muted);
      font-size: 12px;
      padding: 0 18px 8px;
      min-height: 20px;
    }
    .error {
      color: var(--error);
    }
    .approval-overlay {
      position: fixed;
      inset: 0;
      background: rgba(4, 8, 18, 0.72);
      backdrop-filter: blur(6px);
      display: grid;
      place-items: center;
      padding: 24px;
      z-index: 40;
    }
    .approval-card {
      width: min(720px, 100%);
      max-height: min(80vh, 760px);
      overflow: hidden;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      border-radius: 20px;
      border: 1px solid var(--line);
      background: rgba(12, 18, 33, 0.98);
      box-shadow: 0 20px 70px rgba(0, 0, 0, 0.45);
    }
    .approval-head {
      padding: 18px 20px 10px;
      border-bottom: 1px solid var(--line);
    }
    .approval-title {
      font-size: 22px;
      font-weight: 700;
      margin: 0;
    }
    .approval-copy {
      padding: 14px 20px 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .approval-preview {
      margin: 16px 20px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: rgba(17, 24, 45, 0.72);
      overflow: hidden;
      min-height: 0;
    }
    .approval-preview-head {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .approval-preview-body {
      margin: 0;
      padding: 14px;
      overflow: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      color: #dbe7ff;
    }
    .approval-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 16px 20px 20px;
      border-top: 1px solid var(--line);
    }
    .approval-actions button {
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 10px 16px;
      font: inherit;
      cursor: pointer;
    }
    .approval-allow {
      background: var(--accent);
      color: #04111f;
      border-color: transparent;
      font-weight: 700;
    }
    .approval-deny {
      background: rgba(17, 24, 45, 0.92);
      color: var(--text);
    }
    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      padding: 14px 18px 18px;
      border-top: 1px solid var(--line);
      background: rgba(10, 15, 29, 0.88);
      position: relative;
      z-index: 2;
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.16);
    }
    .controls {
      grid-column: 1 / -1;
      display: flex;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
      flex-wrap: wrap;
    }
    .controls label {
      flex: 0 0 auto;
    }
    select {
      min-width: 220px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      padding: 8px 10px;
      font: inherit;
    }
    textarea {
      width: 100%;
      min-height: 92px;
      resize: vertical;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      padding: 12px;
      font: inherit;
    }
    button.primary {
      align-self: end;
      border: 0;
      border-radius: 999px;
      padding: 0 18px;
      min-height: 44px;
      font: inherit;
      font-weight: 600;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #08111f;
      cursor: pointer;
    }
    .composer-attachments {
      grid-column: 1 / -1;
      display: none;
      flex-wrap: wrap;
      gap: 8px;
      padding: 2px 0 4px;
    }
    .composer-attachments.visible {
      display: flex;
    }
    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 8px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(17, 24, 45, 0.92);
      color: var(--text);
      font-size: 12px;
    }
    .attachment-chip button {
      width: auto;
      min-height: auto;
      padding: 0;
      background: transparent;
      color: var(--muted);
      border: 0;
      cursor: pointer;
      font: inherit;
    }
    .composer-actions {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }
    .ghost-button {
      border: 1px solid var(--line);
      background: rgba(17, 24, 45, 0.86);
      color: var(--text);
      border-radius: 999px;
      padding: 8px 12px;
      min-height: 0;
      width: auto;
      cursor: pointer;
    }
    .composer-note {
      color: var(--muted);
      line-height: 1.4;
    }
    .panel-body {
      overflow-y: auto;
      padding: 14px 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .context-card {
      border: 1px solid var(--line);
      background: rgba(17, 24, 45, 0.68);
      border-radius: 16px;
      padding: 14px;
    }
    .context-card h3 {
      margin: 0 0 10px;
      font-size: 13px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .context-row {
      display: grid;
      gap: 6px;
      margin-bottom: 10px;
    }
    .context-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    .context-value {
      font-size: 13px;
      line-height: 1.45;
      word-break: break-word;
    }
    .tab-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tab-pill {
      padding: 6px 9px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      background: rgba(10, 15, 29, 0.9);
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      padding: 18px;
      border: 1px dashed var(--line);
      border-radius: 16px;
      background: rgba(13, 20, 38, 0.56);
    }
    @media (max-width: 1180px) {
      .layout {
        grid-template-columns: 240px minmax(0, 1fr);
      }
      .layout.history-hidden {
        grid-template-columns: minmax(0, 1fr);
      }
      .context {
        display: none;
      }
    }
    @media (max-width: 860px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
      .rail {
        display: none;
      }
      .rail.hidden {
        display: none;
      }
      header {
        padding-right: 12px;
      }
    }
  </style>
</head>
<body>
  <div id="layout" class="layout">
    <aside id="historyRail" class="rail">
      <div class="rail-head">
        <div class="eyebrow">Workspace Chat</div>
        <div class="rail-title">History</div>
      </div>
      <div class="rail-search">
        <input id="historySearch" type="search" placeholder="Search chats">
      </div>
      <div id="threadList" class="thread-list"></div>
    </aside>
    <main class="center">
      <header>
        <div class="header-main">
          <button id="toggleHistory" class="icon-button" type="button" title="Toggle history">←</button>
          <div class="header-copy">
            <h1 id="threadTitle">Codex Bridge</h1>
            <div id="meta">Connecting...</div>
          </div>
        </div>
        <div class="header-actions">
          <button id="historyButton" class="icon-button" type="button" title="Show history">☰</button>
          <button id="newThread" class="icon-button" type="button" title="New chat">＋</button>
        </div>
      </header>
      <div id="messages"></div>
      <div id="status" class="status"></div>
      <form id="composer">
        <div id="controls" class="controls">
          <label for="modelSelect">Model</label>
          <select id="modelSelect">
            <option value="">Loading models...</option>
          </select>
        </div>
        <div id="attachmentList" class="composer-attachments"></div>
        <div class="composer-actions">
          <div class="composer-note" id="composerNote">Fast local chat with stored thread history for this workspace.</div>
          <div>
            <input id="attachmentInput" type="file" multiple hidden>
            <button id="attachButton" class="ghost-button" type="button">Attach</button>
          </div>
        </div>
        <textarea id="prompt" placeholder="Ask Codex Bridge about the current file or workspace..."></textarea>
        <button class="primary" type="submit">Send</button>
      </form>
    </main>
    <aside class="context">
      <div class="context-head">
        <div class="eyebrow">Focus Entity</div>
        <div class="context-title">Current Context</div>
      </div>
      <div class="panel-body">
        <div class="context-card">
          <h3>Current Entity</h3>
          <div class="context-row">
            <div class="context-label">Name</div>
            <div id="ctxEntityName" class="context-value">-</div>
          </div>
          <div class="context-row">
            <div class="context-label">Path</div>
            <div id="ctxEntityPath" class="context-value">-</div>
          </div>
          <div class="context-row">
            <div class="context-label">Language</div>
            <div id="ctxEntityLanguage" class="context-value">-</div>
          </div>
        </div>
        <div class="context-card">
          <h3>Active Editor</h3>
          <div class="context-row">
            <div class="context-label">Title</div>
            <div id="ctxEditorTitle" class="context-value">-</div>
          </div>
          <div class="context-row">
            <div class="context-label">Route</div>
            <div id="ctxEditorRoute" class="context-value">-</div>
          </div>
        </div>
        <div class="context-card">
          <h3>Open Tabs</h3>
          <div id="ctxTabs" class="tab-list"></div>
        </div>
      </div>
    </aside>
  </div>
  <div id="approvalOverlay" class="approval-overlay" hidden>
    <div class="approval-card">
      <div class="approval-head">
        <h2 id="approvalTitle" class="approval-title">Approve tool action?</h2>
      </div>
      <div id="approvalCopy" class="approval-copy"></div>
      <div class="approval-preview">
        <div class="approval-preview-head">Request Preview</div>
        <pre id="approvalPreview" class="approval-preview-body"></pre>
      </div>
      <div class="approval-actions">
        <button id="approvalDeny" class="approval-deny" type="button">Deny</button>
        <button id="approvalAllow" class="approval-allow" type="button">Allow</button>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const layout = document.getElementById('layout');
    const historyRail = document.getElementById('historyRail');
    const threadList = document.getElementById('threadList');
    const historySearch = document.getElementById('historySearch');
    const messagesNode = document.getElementById('messages');
    const statusNode = document.getElementById('status');
    const metaNode = document.getElementById('meta');
    const threadTitleNode = document.getElementById('threadTitle');
    const form = document.getElementById('composer');
    const promptNode = document.getElementById('prompt');
    const controlsNode = document.getElementById('controls');
    const modelSelect = document.getElementById('modelSelect');
    const attachmentList = document.getElementById('attachmentList');
    const attachmentInput = document.getElementById('attachmentInput');
    const attachButton = document.getElementById('attachButton');
    const composerNote = document.getElementById('composerNote');
    const approvalOverlay = document.getElementById('approvalOverlay');
    const approvalTitleNode = document.getElementById('approvalTitle');
    const approvalCopyNode = document.getElementById('approvalCopy');
    const approvalPreviewNode = document.getElementById('approvalPreview');
    const approvalAllowButton = document.getElementById('approvalAllow');
    const approvalDenyButton = document.getElementById('approvalDeny');
    const ctxEntityName = document.getElementById('ctxEntityName');
    const ctxEntityPath = document.getElementById('ctxEntityPath');
    const ctxEntityLanguage = document.getElementById('ctxEntityLanguage');
    const ctxEditorTitle = document.getElementById('ctxEditorTitle');
    const ctxEditorRoute = document.getElementById('ctxEditorRoute');
    const ctxTabs = document.getElementById('ctxTabs');

    let historyOpen = true;
    let runtimeProvider = 'openai';
    let attachments = [];
    let pendingAssistantNode = null;
    let pendingApprovalState = null;
    let state = {
      runtimeProvider: 'openai',
      activeThreadId: '',
      activeThreadTitle: 'Codex Bridge',
      threads: [],
      messages: [],
      osirusChatId: '',
      osirusModels: [],
      selectedOsirusModelId: '',
      context: null,
      agentRuntime: null,
      activeOrgName: '',
      baseUrl: '',
      errorMessage: '',
    };

    function logClient(value) {
      try {
        vscode.postMessage({ type: 'clientLog', value: value });
      } catch (_error) {}
    }

    function reportClientError(value) {
      try {
        vscode.postMessage({ type: 'clientError', value: String(value || 'Unknown client error') });
      } catch (_error) {}
    }

    window.addEventListener('error', function(event) {
      const detail = event && event.error
        ? (event.error.stack || event.error.message || String(event.error))
        : String(event && event.message || 'Unknown client error');
      reportClientError(detail);
    });

    window.addEventListener('unhandledrejection', function(event) {
      const reason = event ? event.reason : undefined;
      const detail = reason && reason.stack
        ? reason.stack
        : String(reason && reason.message ? reason.message : reason || 'Unhandled rejection');
      reportClientError(detail);
    });

    function setStatus(value, isError) {
      statusNode.textContent = String(value || '');
      statusNode.className = isError ? 'status error' : 'status';
    }

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function toggleHistory() {
      historyOpen = !historyOpen;
      historyRail.classList.toggle('hidden', !historyOpen);
      layout.classList.toggle('history-hidden', !historyOpen);
      document.getElementById('toggleHistory').textContent = historyOpen ? '←' : '☰';
      document.getElementById('historyButton').textContent = historyOpen ? '×' : '☰';
    }

    function createMessageNode(role, content) {
      const node = document.createElement('div');
      node.className = 'message ' + role;
      const body = document.createElement('div');
      body.className = 'message-body';
      body.textContent = String(content || '');
      node.appendChild(body);
      return node;
    }

    function renderMessages(list) {
      const items = Array.isArray(list) ? list : [];
      messagesNode.innerHTML = '';
      pendingAssistantNode = null;

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Ask a question, attach files, or open a saved chat to get started.';
        messagesNode.appendChild(empty);
        return;
      }

      for (const item of items) {
        const role = String(item && item.role || '').toLowerCase();
        const normalizedRole = role === 'user' || role === 'assistant' || role === 'system' ? role : 'assistant';
        const content = String(item && (item.content || item.text) || '');
        if (!content.trim()) {
          continue;
        }
        messagesNode.appendChild(createMessageNode(normalizedRole, content));
      }

      messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    function renderModelOptions(models, selectedId) {
      modelSelect.innerHTML = '';
      if (!Array.isArray(models) || !models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = runtimeProvider === 'osirus' ? 'Model list unavailable' : 'No models';
        option.selected = true;
        modelSelect.appendChild(option);
        modelSelect.disabled = true;
        return;
      }

      modelSelect.disabled = false;
      for (const model of models) {
        const option = document.createElement('option');
        option.value = String(model.id || '');
        option.textContent = String(model.label || model.id || '');
        option.selected = option.value === String(selectedId || '');
        modelSelect.appendChild(option);
      }
    }

    function renderThreads() {
      const query = String(historySearch.value || '').trim().toLowerCase();
      const items = Array.isArray(state.threads) ? state.threads : [];
      const visible = query
        ? items.filter(function(thread) {
            const title = String(thread.title || '').toLowerCase();
            const summary = String(thread.summary || '').toLowerCase();
            return title.includes(query) || summary.includes(query);
          })
        : items;

      threadList.innerHTML = '';
      if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = query ? 'No chats match that search yet.' : 'Start a new chat to build local history for this workspace.';
        threadList.appendChild(empty);
        return;
      }

      for (const thread of visible) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'thread-item' + (thread.active ? ' active' : '');
        button.innerHTML =
          '<div class="thread-title">' + escapeHtml(thread.title || 'New chat') + '</div>' +
          '<div class="thread-summary">' + escapeHtml(thread.summary || 'No messages yet') + '</div>' +
          '<div class="thread-meta"><span>' + escapeHtml(thread.provider || runtimeProvider) + '</span><span>' + escapeHtml(thread.updatedLabel || '') + '</span></div>';
        button.addEventListener('click', function() {
          vscode.postMessage({ type: 'openThread', threadId: thread.id });
        });
        threadList.appendChild(button);
      }
    }

    function renderContextPanel(context) {
      const entity = context && context.current_entity ? context.current_entity : {};
      const editor = context && context.active_editor ? context.active_editor : {};
      const tabs = context && Array.isArray(context.open_tabs) ? context.open_tabs : [];

      ctxEntityName.textContent = String(entity.name || 'Workspace');
      ctxEntityPath.textContent = String(entity.path || 'No focused file');
      ctxEntityLanguage.textContent = String(entity.language || entity.type || 'workspace');
      ctxEditorTitle.textContent = String(editor.title || 'No active editor');
      ctxEditorRoute.textContent = String(editor.route || 'No route available');
      ctxTabs.innerHTML = '';

      if (!tabs.length) {
        const pill = document.createElement('div');
        pill.className = 'tab-pill';
        pill.textContent = 'No open tabs';
        ctxTabs.appendChild(pill);
        return;
      }

      for (const tab of tabs) {
        const pill = document.createElement('div');
        pill.className = 'tab-pill';
        pill.textContent = String(tab.label || 'Tab');
        ctxTabs.appendChild(pill);
      }
    }

    function renderAttachments() {
      attachmentList.innerHTML = '';
      if (!attachments.length) {
        attachmentList.classList.remove('visible');
        return;
      }

      attachmentList.classList.add('visible');
      for (const attachment of attachments) {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        chip.innerHTML =
          '<span>' + escapeHtml(attachment.name || 'Attachment') + '</span>' +
          '<button type="button">×</button>';
        chip.querySelector('button').addEventListener('click', function() {
          attachments = attachments.filter(function(item) {
            return item.id !== attachment.id;
          });
          renderAttachments();
        });
        attachmentList.appendChild(chip);
      }
    }

    function renderApprovalPrompt(payload) {
      pendingApprovalState = payload && typeof payload === 'object' ? payload : null;
      if (!pendingApprovalState || !pendingApprovalState.approval) {
        approvalOverlay.hidden = true;
        return;
      }

      const approval = pendingApprovalState.approval;
      approvalTitleNode.textContent = String(approval.title || 'Approve tool action?');
      approvalCopyNode.textContent = String(approval.description || approval.preview || 'Codex requested permission to continue.');
      approvalPreviewNode.textContent = approval.payload
        ? JSON.stringify(approval.payload, null, 2)
        : String(approval.preview || approval.method || '');
      approvalOverlay.hidden = false;
    }

    function makeAttachmentId() {
      return 'attachment-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    }

    function fileToDataUrl(file) {
      return new Promise(function(resolve, reject) {
        const reader = new FileReader();
        reader.onload = function() { resolve(String(reader.result || '')); };
        reader.onerror = function() { reject(new Error('Unable to read attachment.')); };
        reader.readAsDataURL(file);
      });
    }

    async function addAttachments(fileList) {
      const files = Array.from(fileList || []);
      for (const file of files.slice(0, Math.max(0, 6 - attachments.length))) {
        const dataUrl = await fileToDataUrl(file);
        attachments.push({
          id: makeAttachmentId(),
          name: String(file.name || 'attachment'),
          mimeType: String(file.type || 'application/octet-stream'),
          size: Number(file.size || 0),
          dataUrl: dataUrl,
        });
      }
      renderAttachments();
    }

    function describeAttachments(items) {
      if (!Array.isArray(items) || !items.length) {
        return '';
      }
      if (items.length === 1) {
        return '[Attachment] ' + String(items[0].name || 'attachment');
      }
      return '[Attachments] ' + items.map(function(item) {
        return String(item.name || 'attachment');
      }).join(', ');
    }

    function applyState(payload) {
      state = Object.assign({}, state, payload || {});
      runtimeProvider = String(state.runtimeProvider || state.provider || 'openai');
      const agentRuntime = state.agentRuntime && typeof state.agentRuntime === 'object' ? state.agentRuntime : {};

      threadTitleNode.textContent = String(state.activeThreadTitle || 'Codex Bridge');
      const metaParts = [];
      metaParts.push(runtimeProvider === 'osirus' ? 'Osirus' : runtimeProvider || 'Ready');
      if (agentRuntime.executionClass) {
        metaParts.push(String(agentRuntime.executionClass).replaceAll('_', ' '));
      }
      if (agentRuntime.readiness) {
        metaParts.push(String(agentRuntime.readiness));
      }
      if (state.activeOrgName) {
        metaParts.push(String(state.activeOrgName));
      }
      if (state.baseUrl) {
        metaParts.push(String(state.baseUrl));
      }
      metaNode.textContent = metaParts.join(' • ') || 'Ready';

      controlsNode.hidden = runtimeProvider !== 'osirus';
      composerNote.textContent = String(agentRuntime.summary || (
        runtimeProvider === 'osirus'
          ? 'Codex agent runtime for your Osirus workspace.'
          : 'Codex agent runtime for this workspace.'
      ));

      renderModelOptions(state.osirusModels || [], state.selectedOsirusModelId || '');
      renderThreads();
      renderMessages(state.messages || []);
      renderContextPanel(state.context || null);
      setStatus(state.errorMessage || '', Boolean(state.errorMessage));
    }

    function handleAssistantStart() {
      pendingAssistantNode = createMessageNode('assistant', '');
      const empty = messagesNode.querySelector('.empty');
      if (empty) {
        messagesNode.innerHTML = '';
      }
      messagesNode.appendChild(pendingAssistantNode);
      messagesNode.scrollTop = messagesNode.scrollHeight;
      setStatus('Waiting for Codex reply...', false);
    }

    function handleAssistantDelta(value) {
      if (!pendingAssistantNode) {
        handleAssistantStart();
      }
      const body = pendingAssistantNode.querySelector('.message-body');
      body.textContent += String(value || '');
      messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    window.addEventListener('message', function(event) {
      const message = event.data || {};
      if (message.type === 'state' || message.type === 'statePatch') {
        applyState(message.payload || {});
        return;
      }
      if (message.type === 'status') {
        setStatus(message.value || '', false);
        return;
      }
      if (message.type === 'assistantStart') {
        handleAssistantStart();
        return;
      }
      if (message.type === 'assistantDelta') {
        handleAssistantDelta(message.value || '');
        return;
      }
      if (message.type === 'assistantDone') {
        pendingAssistantNode = null;
        setStatus('', false);
        return;
      }
      if (message.type === 'approvalRequest') {
        renderApprovalPrompt(message.value || null);
        return;
      }
      if (message.type === 'approvalCleared') {
        renderApprovalPrompt(null);
        return;
      }
      if (message.type === 'error') {
        pendingAssistantNode = null;
        setStatus(String(message.value || 'Unexpected error'), true);
      }
    });

    form.addEventListener('submit', function(event) {
      event.preventDefault();
      const promptValue = String(promptNode.value || '').trim();
      const nextAttachments = attachments.slice();
      if (!promptValue && !nextAttachments.length) {
        return;
      }

      const nextMessages = Array.isArray(state.messages) ? state.messages.slice() : [];
      nextMessages.push({
        role: 'user',
        content: promptValue || describeAttachments(nextAttachments),
      });
      renderMessages(nextMessages);

      vscode.postMessage({
        type: 'sendMessage',
        prompt: promptValue,
        modelSelectionId: runtimeProvider === 'osirus' ? String(modelSelect.value || '') : '',
        osirusChatId: String(state.osirusChatId || ''),
        attachments: nextAttachments,
      });

      promptNode.value = '';
      attachments = [];
      renderAttachments();
      setStatus('Sending message...', false);
    });

    promptNode.addEventListener('keydown', function(event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        form.requestSubmit();
        return;
      }
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }
      event.preventDefault();
      form.requestSubmit();
    });

    historySearch.addEventListener('input', function() {
      renderThreads();
    });

    document.getElementById('newThread').addEventListener('click', function() {
      vscode.postMessage({ type: 'newThread' });
    });

    document.getElementById('toggleHistory').addEventListener('click', function() {
      toggleHistory();
    });

    document.getElementById('historyButton').addEventListener('click', function() {
      toggleHistory();
    });

    approvalAllowButton.addEventListener('click', function() {
      if (!pendingApprovalState?.sessionId) {
        return;
      }
      vscode.postMessage({
        type: 'approvalDecision',
        sessionId: String(pendingApprovalState.sessionId || ''),
        decision: 'allow',
      });
    });

    approvalDenyButton.addEventListener('click', function() {
      if (!pendingApprovalState?.sessionId) {
        return;
      }
      vscode.postMessage({
        type: 'approvalDecision',
        sessionId: String(pendingApprovalState.sessionId || ''),
        decision: 'deny',
      });
    });

    attachButton.addEventListener('click', function() {
      attachmentInput.click();
    });

    attachmentInput.addEventListener('change', async function(event) {
      const target = event.target;
      await addAttachments(target.files);
      target.value = '';
    });

    historyRail.classList.remove('hidden');
    layout.classList.remove('history-hidden');
    renderAttachments();
    renderModelOptions([], '');
    renderMessages([]);
    metaNode.textContent = 'Booting...';
    setStatus('Requesting chat state...', false);
    logClient('script booted');
    logClient('sending ready');
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
