export function buildSidebarHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Bridge</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --panel: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
      --panel-2: var(--vscode-input-background, rgba(255,255,255,0.03));
      --line: var(--vscode-input-border, rgba(255,255,255,0.12));
      --text: var(--vscode-editor-foreground, #d4d4d4);
      --muted: var(--vscode-descriptionForeground, #9da5b4);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-text: var(--vscode-button-foreground, #ffffff);
      --link: var(--vscode-textLink-foreground, #4ea1ff);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-text: var(--vscode-badge-foreground, #ffffff);
      --error: var(--vscode-errorForeground, #f48771);
      --shadow: 0 12px 30px rgba(0, 0, 0, 0.18);
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body {
      margin: 0;
      min-height: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family, sans-serif);
    }
    body {
      padding: 10px 12px 12px;
    }
    .app {
      height: calc(100vh - 22px);
      display: grid;
      min-height: 0;
    }
    .auth-screen {
      align-self: start;
    }
    .card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 16px;
      padding: 14px;
      box-shadow: var(--shadow);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-icon {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, rgba(96,165,250,0.2), rgba(56,189,248,0.12));
      font-size: 15px;
      font-weight: 700;
      flex: 0 0 auto;
    }
    .brand-copy {
      min-width: 0;
    }
    .brand-title {
      font-weight: 700;
      font-size: 13px;
      line-height: 1.2;
    }
    .brand-meta {
      color: var(--muted);
      font-size: 11px;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .welcome {
      font-size: 18px;
      font-weight: 700;
      line-height: 1.25;
      margin: 0 0 8px;
    }
    .copy {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.25;
      margin-bottom: 16px;
      white-space: pre-wrap;
    }
    .state-pill {
      display: inline-flex;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: var(--badge-text);
      font-size: 11px;
      margin: 12px 0 10px;
    }
    .button-stack {
      display: grid;
      gap: 8px;
    }
    button, select, textarea {
      font: inherit;
    }
    button {
      border: 0;
      cursor: pointer;
    }
    .primary-button,
    .secondary-button {
      width: 100%;
      border-radius: 12px;
      padding: 11px 12px;
      text-align: left;
    }
    .primary-button {
      background: var(--accent);
      color: var(--accent-text);
    }
    .secondary-button {
      background: var(--panel-2);
      color: var(--link);
      border: 1px solid var(--line);
    }
    .chat-screen {
      height: 100%;
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto auto;
      gap: 10px;
      overflow: hidden;
    }
    .topbar {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 4px 2px 0;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .topbar-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .icon-button {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 0;
    }
    .back-button {
      font-size: 15px;
      font-weight: 700;
    }
    .settings-menu {
      position: absolute;
      right: 0;
      top: calc(100% + 8px);
      width: min(260px, calc(100vw - 40px));
      padding: 8px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--bg) 84%, black);
      box-shadow: var(--shadow);
      z-index: 20;
    }
    .history-menu {
      position: absolute;
      right: 0;
      top: calc(100% + 8px);
      width: min(280px, calc(100vw - 40px));
      padding: 8px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--bg) 84%, black);
      box-shadow: var(--shadow);
      z-index: 20;
    }
    .history-menu-list {
      display: grid;
      gap: 6px;
      max-height: min(320px, calc(100vh - 180px));
      overflow-y: auto;
      padding-right: 2px;
    }
    .menu-buttons {
      display: grid;
      gap: 6px;
    }
    .menu-button {
      width: 100%;
      border-radius: 10px;
      padding: 9px 10px;
      text-align: left;
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
    }
    .menu-button:hover {
      background: var(--panel-2);
      border-color: var(--line);
    }
    .menu-meta {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .history-item {
      width: 100%;
      border-radius: 10px;
      padding: 8px 10px;
      text-align: left;
      background: transparent;
      color: var(--text);
      border: 1px solid transparent;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    .history-item:hover,
    .history-item:focus-visible {
      background: var(--panel-2);
      border-color: var(--line);
    }
    .history-item:active {
      transform: translateY(1px);
      background: color-mix(in srgb, var(--panel-2) 82%, var(--link) 18%);
      border-color: color-mix(in srgb, var(--link) 30%, var(--line));
    }
    .history-item.active {
      background: transparent;
      border-color: transparent;
    }
    .history-empty {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      padding: 8px 10px;
    }
    .thread-strip {
      display: grid;
      gap: 6px;
      align-content: start;
      overflow-y: auto;
      min-height: 0;
      padding-right: 2px;
    }
    .thread-item {
      width: 100%;
      padding: 8px 10px;
      border-radius: 12px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text);
      text-align: left;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    .thread-item:hover,
    .thread-item:focus-visible {
      background: var(--panel-2);
      border-color: var(--line);
    }
    .thread-item:active {
      transform: translateY(1px);
      background: color-mix(in srgb, var(--panel-2) 82%, var(--link) 18%);
      border-color: color-mix(in srgb, var(--link) 30%, var(--line));
    }
    .thread-item.active {
      border-color: transparent;
      background: transparent;
    }
    .thread-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .thread-title {
      min-width: 0;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .thread-time {
      color: var(--muted);
      font-size: 11px;
      flex: 0 0 auto;
    }
    .thread-summary {
      margin-top: 4px;
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .messages {
      overflow-y: auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-right: 2px;
      padding-bottom: 18px;
    }
    .content-view {
      min-height: 0;
    }
    .message {
      padding: 11px 12px;
      border: 1px solid var(--line);
      border-radius: 14px;
      line-height: 1.55;
      font-size: 13px;
      max-width: 100%;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
    }
    .message.user {
      align-self: flex-end;
      width: min(50%, 360px);
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      border-color: color-mix(in srgb, var(--accent) 42%, transparent);
    }
    .message.assistant {
      align-self: stretch;
      background: transparent;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      padding: 0;
    }
    .message.system {
      align-self: center;
      background: transparent;
      color: var(--muted);
    }
    .message-body {
      display: grid;
      gap: 8px;
      word-break: break-word;
    }
    .message-status {
      display: grid;
      gap: 4px;
      margin-bottom: 6px;
    }
    .message-status[hidden] {
      display: none !important;
    }
    .message-activity {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
    }
    .message-activity[hidden] {
      display: none !important;
    }
    .editing-pulse {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #67e8f9;
      box-shadow: 0 0 0 rgba(103, 232, 249, 0.45);
      animation: pulse 1.2s ease-in-out infinite;
      flex: 0 0 auto;
    }
    .message-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
      margin-bottom: 6px;
    }
    .message-meta[hidden] {
      display: none !important;
    }
    .thinking-spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(255,255,255,0.12);
      border-top-color: var(--link);
      animation: spin 0.9s linear infinite;
      flex: 0 0 auto;
    }
    .thinking-link {
      color: var(--link);
      text-decoration: none;
      cursor: pointer;
    }
    .thinking-link:hover {
      text-decoration: underline;
    }
    .thinking-panel {
      margin-top: 8px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      color: var(--muted);
      font-size: 12px;
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .message-body > :first-child {
      margin-top: 0;
    }
    .message-body > :last-child {
      margin-bottom: 0;
    }
    .message-paragraph {
      margin: 0;
      white-space: pre-wrap;
      line-height: 1.55;
    }
    .message-inline-code {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.06);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      vertical-align: baseline;
    }
    .message-link {
      color: var(--link);
      text-decoration: none;
      cursor: pointer;
    }
    .message-link:hover {
      text-decoration: underline;
    }
    .file-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 9px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      background: rgba(255, 255, 255, 0.05);
      color: #8fd0ff;
      text-decoration: none;
      cursor: pointer;
      width: fit-content;
      max-width: 100%;
      overflow: hidden;
    }
    .file-link:hover {
      border-color: rgba(125, 211, 252, 0.24);
      background: rgba(125, 211, 252, 0.08);
      text-decoration: none;
    }
    .file-link-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .code-block {
      margin: 0;
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 12px;
      overflow: hidden;
      background: rgba(6, 10, 20, 0.72);
    }
    .code-block-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 10px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid rgba(148, 163, 184, 0.12);
    }
    .code-block-lang {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .code-block pre {
      margin: 0;
      padding: 12px;
      overflow-x: auto;
      white-space: pre;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.5;
      color: #dbe7ff;
    }
    .empty {
      border: 1px dashed var(--line);
      border-radius: 14px;
      padding: 14px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      background: var(--panel-2);
    }
    .status {
      min-height: 18px;
      color: var(--muted);
      font-size: 11px;
      padding: 0 2px;
    }
    .status.error {
      color: var(--error);
    }
    .composer {
      display: grid;
      gap: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--line);
    }
    .footer-meta {
      display: none;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      min-width: 0;
    }
    .model-wrap {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      min-width: 0;
      flex: 0 1 60%;
      max-width: 60%;
    }
    select {
      min-width: 0;
      width: 100%;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      padding: 7px 9px;
    }
    .composer-attachments {
      display: none;
      flex-wrap: wrap;
      gap: 6px;
    }
    .composer-attachments.visible {
      display: flex;
    }
    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-height: 32px;
      padding: 4px 8px 4px 4px;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      font-size: 11px;
    }
    .attachment-thumb {
      width: 28px;
      height: 28px;
      flex: 0 0 28px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--line);
      background: var(--panel);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
    }
    .attachment-thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .attachment-name {
      min-width: 0;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .attachment-chip button {
      background: transparent;
      color: var(--muted);
      padding: 0;
      width: auto;
    }
    .message-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .message-attachment {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 220px;
      padding: 3px 7px 3px 3px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.05);
      color: inherit;
      font-size: 11px;
    }
    .message-attachment .attachment-thumb {
      width: 48px;
      height: 36px;
      flex-basis: 48px;
      border-radius: 5px;
    }
    textarea {
      width: 100%;
      min-height: 78px;
      max-height: 180px;
      resize: vertical;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      padding: 10px 11px;
    }
    .composer-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .composer-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .composer-tools .model-wrap {
      margin-left: auto;
    }
    @media (max-width: 360px) {
      .composer-actions {
        align-items: flex-end;
      }
      .composer-tools {
        flex-wrap: wrap;
      }
      .model-wrap {
        flex-basis: 100%;
        max-width: 100%;
      }
    }
    .ghost-button,
    .send-button {
      border-radius: 999px;
      padding: 8px 12px;
    }
    .ghost-button {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
    }
    .send-button {
      background: #ffffff;
      color: #050505;
      font-weight: 700;
      width: 38px;
      height: 38px;
      min-width: 38px;
      min-height: 38px;
      flex: 0 0 38px;
      aspect-ratio: 1 / 1;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .send-button.stop-button {
      background: #ffffff;
      color: #050505;
    }
    .send-button svg {
      width: 18px;
      height: 18px;
      stroke: currentColor;
      stroke-width: 3;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .send-button .stop-icon {
      fill: currentColor;
      stroke: currentColor;
    }
    .send-button .stop-icon {
      display: none;
    }
    .send-button.stop-button .send-icon {
      display: none;
    }
    .send-button.stop-button .stop-icon {
      display: block;
    }
    .approval-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: grid;
      place-items: center;
      padding: 18px;
      z-index: 40;
    }
    .approval-card {
      width: 100%;
      max-width: 420px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--bg) 88%, black);
      overflow: hidden;
      box-shadow: var(--shadow);
    }
    .approval-head,
    .approval-body,
    .approval-actions {
      padding: 14px;
    }
    .approval-head {
      border-bottom: 1px solid var(--line);
    }
    .approval-title {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
    }
    .approval-copy {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      margin-bottom: 10px;
      white-space: pre-wrap;
    }
    .approval-preview {
      margin: 0;
      padding: 10px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow: auto;
      max-height: 220px;
    }
    .approval-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      border-top: 1px solid var(--line);
    }
    .approval-deny,
    .approval-allow {
      border-radius: 999px;
      padding: 8px 12px;
    }
    .approval-deny {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
    }
    .approval-allow {
      background: var(--accent);
      color: var(--accent-text);
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes pulse {
      0% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(103, 232, 249, 0.38); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(103, 232, 249, 0); }
      100% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(103, 232, 249, 0); }
    }
  </style>
</head>
<body>
  <div class="app">
    <section id="authScreen" class="auth-screen">
      <div class="card">
        <div class="brand">
          <div id="authProviderIcon" class="brand-icon">O</div>
          <div class="brand-copy">
            <div class="brand-title">Codex Bridge</div>
            <div id="authBrandMeta" class="brand-meta"></div>
          </div>
        </div>
        <div id="authState" class="state-pill"></div>
        <h1 id="authWelcome" class="welcome">Welcome</h1>
        <div id="authCopy" class="copy"></div>
        <div class="button-stack">
          <button id="loginButton" class="primary-button" type="button">Login</button>
          <button id="signupButton" class="secondary-button" type="button">Signup</button>
          <button id="configureButton" class="secondary-button" type="button">Configure Connection</button>
        </div>
      </div>
    </section>
    <section id="chatScreen" class="chat-screen" hidden>
      <div class="topbar">
        <div class="topbar-main">
          <button id="backButton" class="icon-button back-button" type="button" title="Back to chats" hidden>←</button>
          <div class="brand">
            <div id="providerIcon" class="brand-icon">O</div>
            <div class="brand-copy">
            <div id="chatHeaderTitle" class="brand-title">Codex Bridge</div>
            <div id="headerMeta" class="brand-meta">Connecting...</div>
            </div>
          </div>
        </div>
        <div class="topbar-actions">
          <button id="historyToggle" class="icon-button" type="button" title="Recent chats">↺</button>
          <button id="newThread" class="icon-button" type="button" title="New chat">+</button>
          <button id="settingsToggle" class="icon-button" type="button" title="Settings">⚙</button>
        </div>
        <div id="historyMenu" class="history-menu" hidden>
          <div id="historyMenuList" class="history-menu-list"></div>
          <div id="historyMenuMeta" class="menu-meta">Recent chats</div>
        </div>
        <div id="settingsMenu" class="settings-menu" hidden>
          <div class="menu-buttons">
            <button id="settingsConfigure" class="menu-button" type="button">Configure Connection</button>
            <button id="settingsSwitchOrg" class="menu-button" type="button" hidden>Switch Org</button>
            <button id="settingsLogout" class="menu-button" type="button">Sign Out</button>
            <button id="settingsHealth" class="menu-button" type="button">Check Health</button>
            <button id="settingsLogs" class="menu-button" type="button">Show Logs</button>
          </div>
          <div id="settingsMeta" class="menu-meta"></div>
        </div>
      </div>
      <div id="threadList" class="thread-strip content-view"></div>
      <div id="messages" class="messages content-view" hidden></div>
      <div id="status" class="status"></div>
      <form id="composer" class="composer">
        <div id="footerMeta" class="footer-meta"></div>
        <div id="attachmentList" class="composer-attachments"></div>
        <textarea id="prompt" placeholder="Ask Codex Bridge about the current file or workspace..."></textarea>
        <div class="composer-actions">
          <div class="composer-tools">
            <input id="attachmentInput" type="file" multiple hidden>
            <button id="attachButton" class="ghost-button" type="button">Attach</button>
            <div id="modelWrap" class="model-wrap" hidden>
              <select id="modelSelect" aria-label="Select model">
                <option value="">Loading models...</option>
              </select>
            </div>
          </div>
          <button id="sendButton" class="send-button" type="submit" title="Send" aria-label="Send">
            <svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14"></path>
              <path d="m13 6 6 6-6 6"></path>
            </svg>
            <svg class="stop-icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="7" y="7" width="10" height="10" rx="1"></rect>
            </svg>
          </button>
        </div>
      </form>
    </section>
  </div>
  <div id="approvalOverlay" class="approval-overlay" hidden>
    <div class="approval-card">
      <div class="approval-head">
        <h2 id="approvalTitle" class="approval-title">Approve tool action?</h2>
      </div>
      <div class="approval-body">
        <div id="approvalCopy" class="approval-copy"></div>
        <pre id="approvalPreview" class="approval-preview"></pre>
      </div>
      <div class="approval-actions">
        <button id="approvalDeny" class="approval-deny" type="button">Deny</button>
        <button id="approvalAllow" class="approval-allow" type="button">Allow</button>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const authScreen = document.getElementById('authScreen');
    const chatScreen = document.getElementById('chatScreen');
    const authProviderIcon = document.getElementById('authProviderIcon');
    const providerIcon = document.getElementById('providerIcon');
    const authBrandMeta = document.getElementById('authBrandMeta');
    const authState = document.getElementById('authState');
    const authWelcome = document.getElementById('authWelcome');
    const authCopy = document.getElementById('authCopy');
    const chatHeaderTitle = document.getElementById('chatHeaderTitle');
    const headerMeta = document.getElementById('headerMeta');
    const settingsMenu = document.getElementById('settingsMenu');
    const settingsToggle = document.getElementById('settingsToggle');
    const backButton = document.getElementById('backButton');
    const historyToggle = document.getElementById('historyToggle');
    const historyMenu = document.getElementById('historyMenu');
    const historyMenuList = document.getElementById('historyMenuList');
    const historyMenuMeta = document.getElementById('historyMenuMeta');
    const settingsMeta = document.getElementById('settingsMeta');
    const settingsSwitchOrg = document.getElementById('settingsSwitchOrg');
    const settingsLogout = document.getElementById('settingsLogout');
    const threadList = document.getElementById('threadList');
    const messagesNode = document.getElementById('messages');
    const statusNode = document.getElementById('status');
    const form = document.getElementById('composer');
    const promptNode = document.getElementById('prompt');
    const footerMeta = document.getElementById('footerMeta');
    const modelWrap = document.getElementById('modelWrap');
    const modelSelect = document.getElementById('modelSelect');
    const attachmentList = document.getElementById('attachmentList');
    const attachmentInput = document.getElementById('attachmentInput');
    const attachButton = document.getElementById('attachButton');
    const sendButton = document.getElementById('sendButton');
    const approvalOverlay = document.getElementById('approvalOverlay');
    const approvalTitleNode = document.getElementById('approvalTitle');
    const approvalCopyNode = document.getElementById('approvalCopy');
    const approvalPreviewNode = document.getElementById('approvalPreview');
    const approvalAllowButton = document.getElementById('approvalAllow');
    const approvalDenyButton = document.getElementById('approvalDeny');

    let attachments = [];
    let pendingAssistantNode = null;
    let pendingAssistantStatus = null;
    let pendingAssistantActivity = null;
    let pendingAssistantMeta = null;
    let pendingAssistantThinkingToggle = null;
    let pendingAssistantThinkingPanel = null;
    let pendingAssistantText = '';
    let pendingAssistantThinking = '';
    let pendingAssistantStartedAt = 0;
    let pendingAssistantTimer = null;
    let pendingApprovalState = null;
    let activeSessionId = '';
    let assistantRunning = false;
    let lastProgressMessage = '';
    let pendingAssistantCompleted = false;
    const persistedUiState = vscode.getState && vscode.getState() || {};
    let viewMode = persistedUiState && persistedUiState.viewMode === 'detail' ? 'detail' : 'list';
    let didAutoEnterDetail = false;
    let state = {
      signedIn: false,
      runtimeProvider: 'openai',
      activeThreadId: '',
      activeThreadTitle: 'Codex Bridge',
      threads: [],
      messages: [],
      osirusChatId: '',
      osirusModels: [],
      selectedOsirusModelId: '',
      activeOrgName: '',
      activeOrgId: '',
      providerDisplayName: '',
      providerIcon: '',
      stateLabel: '',
      authLabel: '',
      baseUrl: '',
      runtime: '',
      setupCopy: '',
      readyCopy: '',
      welcomeTitle: '',
      loginButtonLabel: 'Login',
      signupButtonLabel: 'Signup',
      agentRuntime: null,
      activeSessionId: '',
      errorMessage: '',
    };

    function reportClientError(value) {
      try {
        vscode.postMessage({ type: 'clientError', value: String(value || 'Unknown client error') });
      } catch (_error) {}
    }

    function postToExtension(payload) {
      try {
        vscode.postMessage(payload);
      } catch (error) {
        reportClientError(error instanceof Error ? error.message : String(error || 'Unable to post sidebar message'));
      }
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

    function setAssistantRunning(value, sessionId) {
      assistantRunning = Boolean(value);
      if (sessionId !== undefined) {
        activeSessionId = String(sessionId || '');
      }
      sendButton.title = assistantRunning ? 'Stop' : 'Send';
      sendButton.setAttribute('aria-label', assistantRunning ? 'Stop' : 'Send');
      sendButton.classList.toggle('stop-button', assistantRunning);
    }

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function closeSettingsMenu() {
      settingsMenu.hidden = true;
    }

    function closeHistoryMenu() {
      historyMenu.hidden = true;
    }

    function showListView() {
      viewMode = 'list';
      persistUiState();
      closeHistoryMenu();
      threadList.hidden = false;
      messagesNode.hidden = true;
      form.hidden = false;
      statusNode.hidden = false;
      backButton.hidden = true;
      historyToggle.hidden = true;
      chatHeaderTitle.textContent = 'Codex Bridge';
    }

    function showDetailView() {
      viewMode = 'detail';
      persistUiState();
      closeHistoryMenu();
      threadList.hidden = true;
      messagesNode.hidden = false;
      form.hidden = false;
      statusNode.hidden = false;
      backButton.hidden = false;
      historyToggle.hidden = false;
      chatHeaderTitle.textContent = String(state.activeThreadTitle || 'Chat');
    }

    function persistUiState() {
      try {
        vscode.setState({
          viewMode: viewMode,
          activeThreadId: String(state.activeThreadId || ''),
        });
      } catch (_error) {}
    }

    function createThinkingMeta(messageMeta, thinkingText, thinkingToggle, thinkingPanel) {
      if (!messageMeta) {
        return;
      }

      if (!thinkingText) {
        if (thinkingToggle) {
          thinkingToggle.hidden = true;
        }
        if (thinkingPanel) {
          thinkingPanel.hidden = true;
          thinkingPanel.textContent = '';
        }
        return;
      }

      if (thinkingToggle) {
        thinkingToggle.hidden = false;
      }
      if (thinkingPanel) {
        thinkingPanel.textContent = String(thinkingText || '');
      }
    }

    function createMessageNode(role, content, options) {
      const config = options && typeof options === 'object' ? options : {};
      const node = document.createElement('div');
      node.className = 'message ' + role;
      if (role === 'assistant') {
        const status = document.createElement('div');
        status.className = 'message-status';
        const activity = document.createElement('div');
        activity.className = 'message-activity';
        activity.hidden = !config.activityLabel;
        activity.innerHTML = '<span class="editing-pulse"></span><span></span>';
        if (config.activityLabel) {
          activity.querySelector('span:last-child').textContent = String(config.activityLabel || '');
        }
        status.appendChild(activity);
        const meta = document.createElement('div');
        meta.className = 'message-meta';
        if (config.metaText || config.thinkingText) {
          const spinner = document.createElement('div');
          spinner.className = 'thinking-spinner';
          spinner.hidden = !config.showSpinner;
          meta.appendChild(spinner);
          if (config.metaText) {
            const metaText = document.createElement('span');
            metaText.textContent = String(config.metaText || '');
            meta.appendChild(metaText);
          }
          const thinkingToggle = document.createElement('a');
          thinkingToggle.href = '#';
          thinkingToggle.className = 'thinking-link';
          thinkingToggle.textContent = 'Expand thinking';
          thinkingToggle.hidden = !config.thinkingText;
          const thinkingPanel = document.createElement('div');
          thinkingPanel.className = 'thinking-panel';
          thinkingPanel.hidden = true;
          thinkingPanel.textContent = String(config.thinkingText || '');
          thinkingToggle.addEventListener('click', function(event) {
            event.preventDefault();
            const nextHidden = !thinkingPanel.hidden;
            thinkingPanel.hidden = nextHidden;
            thinkingToggle.textContent = nextHidden ? 'Expand thinking' : 'Hide thinking';
          });
          meta.appendChild(thinkingToggle);
          status.appendChild(meta);
          node.appendChild(status);
          node.appendChild(thinkingPanel);
        } else {
          meta.hidden = true;
          status.appendChild(meta);
          node.appendChild(status);
        }
      }
      const body = document.createElement('div');
      body.className = 'message-body';
      const messageAttachments = Array.isArray(config.attachments) ? config.attachments : [];
      const bodyContent = messageAttachments.length && isAttachmentPlaceholder(content) ? '' : String(content || '');
      if (bodyContent.trim()) {
        safeRenderRichContent(body, bodyContent);
      }
      renderMessageAttachments(body, config.attachments);
      node.appendChild(body);
      return node;
    }

    function isAttachmentPlaceholder(value) {
      return /^\s*\[Attachments?\]\s+/i.test(String(value || ''));
    }

    function renderMessageAttachments(target, items) {
      const messageAttachments = Array.isArray(items) ? items : [];
      if (!messageAttachments.length) {
        return;
      }

      const wrap = document.createElement('div');
      wrap.className = 'message-attachments';
      for (const attachment of messageAttachments) {
        const item = document.createElement('div');
        item.className = 'message-attachment';
        item.title = String(attachment && attachment.name || 'Attachment');
        item.innerHTML =
          renderAttachmentThumb(attachment) +
          '<span class="attachment-name">' + escapeHtml(attachment && attachment.name || 'Attachment') + '</span>';
        wrap.appendChild(item);
      }
      target.appendChild(wrap);
    }

    function renderPlainTextContent(target, text) {
      target.innerHTML = '';
      const paragraph = document.createElement('div');
      paragraph.className = 'message-paragraph';
      paragraph.textContent = String(text || '');
      target.appendChild(paragraph);
    }

    function appendTextNode(target, value) {
      if (!value) {
        return;
      }
      target.appendChild(document.createTextNode(value));
    }

    function parseFileTarget(target) {
      const raw = String(target || '').trim();
      let trimmed = raw;
      try {
        trimmed = decodeURIComponent(raw);
      } catch (_error) {
        trimmed = raw.replace(/%3A/ig, ':');
      }
      if (!trimmed) {
        return null;
      }

      const match = trimmed.match(/^(.*):(\d+)$/);
      let path = String(match ? match[1] : trimmed).trim();
      const line = Number(match ? match[2] : '0');
      if (path.startsWith('<') && path.endsWith('>')) {
        path = path.slice(1, -1).trim();
      }

      const looksLikeWorkspaceRelativePath =
        (path.includes('/') || /^[A-Za-z0-9_.-]+\.[A-Za-z0-9._-]+$/.test(path)) &&
        !path.startsWith('http://') &&
        !path.startsWith('https://');
      if (!path || !(path.startsWith('/') || path.startsWith('./') || path.startsWith('../') || path.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(path) || looksLikeWorkspaceRelativePath)) {
        return null;
      }

      return {
        path,
        line: Number.isFinite(line) ? line : 0,
      };
    }

    function createInteractiveLink(label, target) {
      const fileTarget = parseFileTarget(target);
      const link = document.createElement('a');

      if (fileTarget) {
        const displayLabel = String(label || fileTarget.path);
        const displayWithLine = fileTarget.line > 0 && !/\(line\s+\d+\)$/i.test(displayLabel)
          ? displayLabel + ' (line ' + String(fileTarget.line) + ')'
          : displayLabel;
        link.className = 'file-link';
        link.href = '#';
        link.innerHTML = '<span>↗</span><span class="file-link-label"></span>';
        link.querySelector('.file-link-label').textContent = displayWithLine;
        link.addEventListener('click', function(event) {
          event.preventDefault();
          postToExtension({
            type: 'openFile',
            path: fileTarget.path,
            line: fileTarget.line,
          });
        });
        return link;
      }

      link.className = 'message-link';
      link.href = '#';
      link.textContent = String(label || target || '');
      link.addEventListener('click', function(event) {
        event.preventDefault();
        postToExtension({
          type: 'openLink',
          url: String(target || ''),
        });
      });
      return link;
    }

    function appendInlineContent(target, text) {
      const tick = String.fromCharCode(96);
      let cursor = 0;

      while (cursor < text.length) {
        const nextCode = text.indexOf(tick, cursor);
        const nextLink = text.indexOf('[', cursor);
        const nextToken = [nextCode, nextLink]
          .filter(function(index) { return index >= 0; })
          .sort(function(a, b) { return a - b; })[0];

        if (nextToken === undefined) {
          appendTextNode(target, text.slice(cursor));
          break;
        }

        appendTextNode(target, text.slice(cursor, nextToken));

        if (nextToken === nextCode) {
          const codeEnd = text.indexOf(tick, nextCode + 1);
          if (codeEnd < 0) {
            appendTextNode(target, text.slice(nextCode));
            break;
          }
          const code = document.createElement('code');
          code.className = 'message-inline-code';
          code.textContent = String(text.slice(nextCode + 1, codeEnd) || '');
          target.appendChild(code);
          cursor = codeEnd + 1;
        } else {
          const labelEnd = text.indexOf(']', nextLink + 1);
          const urlStart = labelEnd >= 0 ? text.indexOf('(', labelEnd + 1) : -1;
          const urlEnd = urlStart >= 0 ? text.indexOf(')', urlStart + 1) : -1;
          if (labelEnd < 0 || urlStart !== labelEnd + 1 || urlEnd < 0) {
            appendTextNode(target, text.slice(nextLink, nextLink + 1));
            cursor = nextLink + 1;
            continue;
          }
          target.appendChild(createInteractiveLink(
            text.slice(nextLink + 1, labelEnd),
            text.slice(urlStart + 1, urlEnd)
          ));
          cursor = urlEnd + 1;
        }
      }
      linkifyPlainFileReferences(target);
    }

    function linkifyPlainFileReferences(target) {
      const filePattern = new RegExp("(^|[\\\\s(])((?:(?:\\\\/|\\\\.\\\\/|\\\\.\\\\.\\\\/|[A-Za-z]:[\\\\/\\\\\\\\])|(?:[A-Za-z0-9_.-]+\\\\/))[^\\\\s)<>\\\"']*?\\\\.[A-Za-z0-9._-]+(?::\\\\d+)?)", 'g');
      const childNodes = Array.from(target.childNodes);

      for (const node of childNodes) {
        if (!node || node.nodeType !== Node.TEXT_NODE) {
          continue;
        }

        const text = String(node.textContent || '');
        if (!text.trim()) {
          continue;
        }

        filePattern.lastIndex = 0;
        if (!filePattern.test(text)) {
          continue;
        }

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        filePattern.lastIndex = 0;
        let match;
        while ((match = filePattern.exec(text)) !== null) {
          const prefix = String(match[1] || '');
          const rawTarget = String(match[2] || '');
          const startIndex = match.index + prefix.length;
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index + prefix.length)));
          fragment.appendChild(createInteractiveLink(rawTarget, rawTarget));
          lastIndex = startIndex + rawTarget.length;
        }
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        node.replaceWith(fragment);
      }
    }

    function appendTextBlock(target, text) {
      const normalized = String(text || '').replace(/\\r\\n/g, '\\n');
      const paragraphs = normalized.split(/\\n{2,}/);

      for (const paragraphText of paragraphs) {
        const paragraph = document.createElement('div');
        paragraph.className = 'message-paragraph';
        appendInlineContent(paragraph, paragraphText);
        target.appendChild(paragraph);
      }
    }

    function appendCodeBlock(target, language, code) {
      const block = document.createElement('div');
      block.className = 'code-block';

      const head = document.createElement('div');
      head.className = 'code-block-head';
      const lang = document.createElement('div');
      lang.className = 'code-block-lang';
      lang.textContent = String(language || 'text');
      head.appendChild(lang);
      block.appendChild(head);

      const pre = document.createElement('pre');
      const codeNode = document.createElement('code');
      codeNode.textContent = String(code || '');
      pre.appendChild(codeNode);
      block.appendChild(pre);

      target.appendChild(block);
    }

    function renderRichContent(target, text) {
      target.innerHTML = '';
      const normalized = String(text || '').replace(/\\r\\n/g, '\\n');
      const fence = String.fromCharCode(96).repeat(3);
      const pattern = new RegExp(fence + '([\\w.-]+)?\\n?([\\s\\S]*?)' + fence, 'g');
      let lastIndex = 0;
      let match;

      while ((match = pattern.exec(normalized)) !== null) {
        const before = normalized.slice(lastIndex, match.index).trim();
        if (before) {
          appendTextBlock(target, before);
        }

        appendCodeBlock(target, String(match[1] || ''), String(match[2] || '').replace(/\\n$/, ''));
        lastIndex = pattern.lastIndex;
      }

      const after = normalized.slice(lastIndex).trim();
      if (after) {
        appendTextBlock(target, after);
      }

      if (!target.childNodes.length) {
        const empty = document.createElement('div');
        empty.className = 'message-paragraph';
        empty.textContent = normalized;
        target.appendChild(empty);
      }
    }

    function safeRenderRichContent(target, text) {
      try {
        renderRichContent(target, text);
      } catch (error) {
        renderPlainTextContent(target, text);
        reportClientError(error instanceof Error ? error.message : String(error || 'Sidebar render failure'));
      }
    }

    function renderMessages(list) {
      const items = Array.isArray(list) ? list : [];
      messagesNode.innerHTML = '';
      pendingAssistantNode = null;
      pendingAssistantStatus = null;
      pendingAssistantActivity = null;
      pendingAssistantMeta = null;
      pendingAssistantThinkingToggle = null;
      pendingAssistantThinkingPanel = null;
      pendingAssistantText = '';
      pendingAssistantThinking = '';
      pendingAssistantStartedAt = 0;
      lastProgressMessage = '';
      pendingAssistantCompleted = false;
      if (pendingAssistantTimer) {
        clearInterval(pendingAssistantTimer);
        pendingAssistantTimer = null;
      }

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = state.signedIn
          ? 'Ask a question or open a saved chat to get started.'
          : 'Sign in to continue.';
        messagesNode.appendChild(empty);
        return;
      }

      for (const item of items) {
        const role = String(item && item.role || '').toLowerCase();
        const normalizedRole = role === 'user' || role === 'assistant' || role === 'system' ? role : 'assistant';
        let content = String(item && (item.content || item.text) || '');
        const thinkingText = item && typeof item.thinking === 'string'
          ? String(item.thinking || '')
          : '';
        const itemAttachments = Array.isArray(item && item.attachments) ? item.attachments : [];
        if (!content.trim() && normalizedRole === 'assistant' && thinkingText) {
          content = 'Codex returned internal reasoning without a final reply.';
        }
        if (!content.trim() && !itemAttachments.length) {
          continue;
        }
        const messageOptions = normalizedRole === 'assistant'
          ? {
              metaText: thinkingText ? 'Thought' : '',
              showSpinner: false,
              thinkingText,
            }
          : {};
        messageOptions.attachments = itemAttachments;
        messagesNode.appendChild(createMessageNode(normalizedRole, content, messageOptions));
      }

      messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    function renderModelOptions(models, selectedId) {
      modelSelect.innerHTML = '';
      if (!Array.isArray(models) || !models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = state.runtimeProvider === 'osirus' ? 'Model list unavailable' : 'No models';
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
      const items = Array.isArray(state.threads) ? state.threads : [];
      threadList.innerHTML = '';

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Start a new chat to build local history for this workspace.';
        threadList.appendChild(empty);
        return;
      }

      for (const thread of items.slice(0, 8)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'thread-item' + (thread.active ? ' active' : '');
        button.innerHTML =
          '<div class="thread-line">' +
            '<div class="thread-title">' + escapeHtml(thread.title || 'New chat') + '</div>' +
            '<div class="thread-time">' + escapeHtml(thread.updatedLabel || '') + '</div>' +
          '</div>' +
          '<div class="thread-summary">' + escapeHtml(thread.summary || 'No messages yet') + '</div>';
        button.addEventListener('click', function() {
          showDetailView();
          postToExtension({ type: 'openThread', threadId: thread.id });
        });
        threadList.appendChild(button);
      }
    }

    function renderHistoryMenu() {
      const items = Array.isArray(state.threads) ? state.threads.slice(0, 5) : [];
      historyMenuList.innerHTML = '';

      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = 'No recent chats yet.';
        historyMenuList.appendChild(empty);
        historyMenuMeta.textContent = 'Recent chats';
        return;
      }

      for (const thread of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'history-item' + (thread.active ? ' active' : '');
        button.innerHTML =
          '<div class="thread-line">' +
            '<div class="thread-title">' + escapeHtml(thread.title || 'New chat') + '</div>' +
            '<div class="thread-time">' + escapeHtml(thread.updatedLabel || '') + '</div>' +
          '</div>' +
          '<div class="thread-summary">' + escapeHtml(thread.summary || 'No messages yet') + '</div>';
        button.addEventListener('click', function() {
          closeHistoryMenu();
          showDetailView();
          postToExtension({ type: 'openThread', threadId: thread.id });
        });
        historyMenuList.appendChild(button);
      }

      historyMenuMeta.textContent = items.length === 1 ? 'Last 1 chat' : 'Last ' + String(items.length) + ' chats';
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
          renderAttachmentThumb(attachment) +
          '<span class="attachment-name">' + escapeHtml(attachment.name || 'Attachment') + '</span>' +
          '<button type="button">x</button>';
        chip.querySelector('button').addEventListener('click', function() {
          attachments = attachments.filter(function(item) {
            return item.id !== attachment.id;
          });
          renderAttachments();
        });
        attachmentList.appendChild(chip);
      }
    }

    function renderAttachmentThumb(attachment) {
      const mimeType = String(attachment && attachment.mimeType || '').toLowerCase();
      const dataUrl = String(attachment && attachment.dataUrl || '');
      if (mimeType.indexOf('image/') === 0 && dataUrl) {
        return '<span class="attachment-thumb"><img src="' + escapeHtml(dataUrl) + '" alt=""></span>';
      }
      return '<span class="attachment-thumb">' + escapeHtml(getAttachmentExtension(mimeType).slice(0, 3).toUpperCase()) + '</span>';
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

    function getAttachmentExtension(mimeType) {
      const value = String(mimeType || '').toLowerCase();
      if (value === 'image/png') {
        return 'png';
      }
      if (value === 'image/jpeg' || value === 'image/jpg') {
        return 'jpg';
      }
      if (value === 'image/gif') {
        return 'gif';
      }
      if (value === 'image/webp') {
        return 'webp';
      }
      if (value === 'text/plain') {
        return 'txt';
      }
      return 'bin';
    }

    function getAttachmentName(file, index, source) {
      const explicitName = String(file && file.name || '').trim();
      if (explicitName) {
        return explicitName;
      }
      const prefix = source === 'paste' ? 'pasted-attachment' : 'attachment';
      return prefix + '-' + String(index + 1) + '.' + getAttachmentExtension(file && file.type);
    }

    async function addAttachments(fileList, source) {
      const files = Array.from(fileList || []);
      for (const file of files.slice(0, Math.max(0, 6 - attachments.length))) {
        const dataUrl = await fileToDataUrl(file);
        attachments.push({
          id: makeAttachmentId(),
          name: getAttachmentName(file, attachments.length, source),
          mimeType: String(file.type || 'application/octet-stream'),
          size: Number(file.size || 0),
          dataUrl: dataUrl,
        });
      }
      renderAttachments();
    }

    function getClipboardAttachmentFiles(event) {
      const clipboardData = event && event.clipboardData;
      if (!clipboardData) {
        return [];
      }

      const directFiles = Array.from(clipboardData.files || []).filter(Boolean);
      if (directFiles.length) {
        return directFiles;
      }

      return Array.from(clipboardData.items || [])
        .filter(function(item) {
          return item && item.kind === 'file';
        })
        .map(function(item) {
          return item.getAsFile();
        })
        .filter(Boolean);
    }

    async function handleAttachmentPaste(event) {
      const files = getClipboardAttachmentFiles(event);
      if (!files.length) {
        return;
      }

      event.preventDefault();
      if (attachments.length >= 6) {
        setStatus('Attachment limit reached.', true);
        return;
      }

      try {
        await addAttachments(files, 'paste');
        setStatus(files.length === 1 ? 'Pasted attachment.' : 'Pasted attachments.', false);
      } catch (error) {
        setStatus(error && error.message ? error.message : 'Unable to paste attachment.', true);
      }
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

    function applyState(payload, options) {
      const nextOptions = options && typeof options === 'object' ? options : {};
      const preserveRenderedMessages = Boolean(nextOptions.preserveRenderedMessages) || assistantRunning || Boolean(pendingAssistantNode);
      const wasSignedIn = Boolean(state.signedIn);
      const previousActiveThreadId = String(state.activeThreadId || '');
      state = Object.assign({}, state, payload || {});
      if (state.activeSessionId) {
        activeSessionId = String(state.activeSessionId || '');
      }
      const signedIn = Boolean(state.signedIn);
      const providerMark = String(state.providerIcon || state.providerDisplayName || 'C').slice(0, 1).toUpperCase();

      authScreen.hidden = signedIn;
      chatScreen.hidden = !signedIn;
      if (!signedIn) {
        didAutoEnterDetail = false;
        showListView();
      } else if (viewMode === 'detail' && state.activeThreadId) {
        showDetailView();
      } else if (!wasSignedIn && signedIn && !didAutoEnterDetail) {
        showListView();
      }
      authProviderIcon.textContent = providerMark;
      providerIcon.textContent = providerMark;
      authBrandMeta.textContent = String(state.providerDisplayName || '');
      authState.textContent = String(state.stateLabel || '');
      authWelcome.textContent = String(state.welcomeTitle || 'Welcome');
      authCopy.textContent = String(state.setupCopy || '');
      document.getElementById('loginButton').textContent = String(state.loginButtonLabel || 'Login');
      document.getElementById('signupButton').textContent = String(state.signupButtonLabel || 'Signup');
      chatHeaderTitle.textContent = viewMode === 'detail'
        ? String(state.activeThreadTitle || 'Chat')
        : 'Codex Bridge';

      const headerBits = [];
      headerBits.push(String(state.providerDisplayName || state.runtimeProvider || 'Codex Bridge'));
      if (state.activeOrgName) {
        headerBits.push(String(state.activeOrgName));
      }
      if (state.stateLabel) {
        headerBits.push(String(state.stateLabel));
      }
      headerMeta.textContent = headerBits.join(' • ');

      const metaLines = [];
      if (state.readyCopy) {
        metaLines.push(String(state.readyCopy));
      }
      if (state.baseUrl) {
        metaLines.push('Bridge: ' + String(state.baseUrl));
      }
      if (state.authLabel) {
        metaLines.push('Auth: ' + String(state.authLabel));
      }
      if (state.runtime) {
        metaLines.push('Runtime: ' + String(state.runtime));
      }
      if (state.activeOrgName) {
        metaLines.push('Org: ' + String(state.activeOrgName) + (state.activeOrgId ? ' (' + String(state.activeOrgId) + ')' : ''));
      }
      settingsMeta.textContent = metaLines.join('\\n');

      const runtimeProvider = String(state.runtimeProvider || 'openai');
      const isOsirus = runtimeProvider === 'osirus';
      const isLogoutLabel = runtimeProvider === 'osirus' ? 'Sign Out' : (runtimeProvider === 'osirus_agent' || state.authLabel === 'api_key' ? 'Clear API Key' : 'Disconnect');
      settingsSwitchOrg.hidden = !isOsirus;
      settingsLogout.textContent = isLogoutLabel;

      const agentRuntime = state.agentRuntime && typeof state.agentRuntime === 'object' ? state.agentRuntime : {};
      modelWrap.hidden = runtimeProvider !== 'osirus';
      footerMeta.hidden = true;

      renderModelOptions(state.osirusModels || [], state.selectedOsirusModelId || '');
      renderThreads();
      renderHistoryMenu();
      if (viewMode === 'detail') {
        const activeThreadChanged = String(state.activeThreadId || '') !== previousActiveThreadId;
        const shouldPreserveLiveRender = preserveRenderedMessages && !activeThreadChanged && Boolean(pendingAssistantNode);
        if (!shouldPreserveLiveRender) {
          renderMessages(state.messages || []);
        } else if (pendingAssistantCompleted) {
          pendingAssistantNode = null;
          pendingAssistantStatus = null;
          pendingAssistantActivity = null;
          pendingAssistantMeta = null;
          pendingAssistantThinkingToggle = null;
          pendingAssistantThinkingPanel = null;
          pendingAssistantText = '';
          pendingAssistantThinking = '';
          pendingAssistantStartedAt = 0;
          lastProgressMessage = '';
          pendingAssistantCompleted = false;
        }
      } else {
        messagesNode.innerHTML = '';
      }
      setStatus(state.errorMessage || '', Boolean(state.errorMessage));
    }

    function handleAssistantStart() {
      pendingAssistantNode = createMessageNode('assistant', '', {
        activityLabel: '',
        metaText: 'Thinking...',
        showSpinner: true,
        thinkingText: '',
      });
      pendingAssistantStatus = pendingAssistantNode.querySelector('.message-status');
      pendingAssistantActivity = pendingAssistantNode.querySelector('.message-activity');
      pendingAssistantMeta = pendingAssistantNode.querySelector('.message-meta');
      pendingAssistantThinkingToggle = pendingAssistantNode.querySelector('.thinking-link');
      pendingAssistantThinkingPanel = pendingAssistantNode.querySelector('.thinking-panel');
      pendingAssistantText = '';
      pendingAssistantThinking = '';
      pendingAssistantStartedAt = Date.now();
      lastProgressMessage = '';
      pendingAssistantCompleted = false;
      if (pendingAssistantTimer) {
        clearInterval(pendingAssistantTimer);
      }
      pendingAssistantTimer = setInterval(function() {
        if (!pendingAssistantMeta) {
          return;
        }
        const metaTextNode = pendingAssistantMeta.querySelector('span');
        if (!metaTextNode) {
          return;
        }
        const seconds = Math.max(1, Math.round((Date.now() - pendingAssistantStartedAt) / 1000));
        metaTextNode.textContent = 'Thinking... ' + String(seconds) + 's';
      }, 1000);
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
      pendingAssistantText += String(value || '');
      const body = pendingAssistantNode.querySelector('.message-body');
      safeRenderRichContent(body, pendingAssistantText);
      messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    function appendProgressMessage(value) {
      const text = String(value || '').trim();
      if (!text || text === lastProgressMessage) {
        return;
      }
      lastProgressMessage = text;
      const node = createMessageNode('assistant', text, undefined);
      if (pendingAssistantNode && pendingAssistantNode.parentNode === messagesNode) {
        messagesNode.insertBefore(node, pendingAssistantNode);
      } else {
        messagesNode.appendChild(node);
      }
      messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    function finalizeAssistantMeta() {
      if (pendingAssistantTimer) {
        clearInterval(pendingAssistantTimer);
        pendingAssistantTimer = null;
      }
      if (!pendingAssistantMeta) {
        return;
      }
      const spinner = pendingAssistantMeta.querySelector('.thinking-spinner');
      const metaTextNode = pendingAssistantMeta.querySelector('span');
      if (spinner) {
        spinner.hidden = true;
      }
      if (metaTextNode && pendingAssistantStartedAt) {
        const seconds = Math.max(1, Math.round((Date.now() - pendingAssistantStartedAt) / 1000));
        metaTextNode.textContent = 'Thought for ' + String(seconds) + 's';
      }
      createThinkingMeta(pendingAssistantMeta, pendingAssistantThinking, pendingAssistantThinkingToggle, pendingAssistantThinkingPanel);
    }

    function finalizeAssistantContent(value) {
      if (!pendingAssistantNode) {
        return;
      }
      const finalText = String(value || '').trim();
      if (!finalText) {
        return;
      }
      if (!pendingAssistantText.trim()) {
        pendingAssistantText = finalText;
      } else if (pendingAssistantText.trim() !== finalText) {
        pendingAssistantText = finalText;
      }
      const body = pendingAssistantNode.querySelector('.message-body');
      if (body) {
        safeRenderRichContent(body, pendingAssistantText);
      }
      messagesNode.scrollTop = messagesNode.scrollHeight;
    }

    function updateAssistantActivity(activity) {
      if (!pendingAssistantActivity) {
        return;
      }
      const label = activity && typeof activity === 'object'
        ? String(activity.label || '')
        : '';
      const labelNode = pendingAssistantActivity.querySelector('span:last-child');
      pendingAssistantActivity.hidden = !label;
      if (labelNode) {
        labelNode.textContent = label;
      }
      if (pendingAssistantStatus) {
        pendingAssistantStatus.hidden = !label && !pendingAssistantMeta;
      }
    }

    window.addEventListener('message', function(event) {
      const message = event.data || {};
      if (message.type === 'state' || message.type === 'statePatch') {
        applyState(message.payload || {}, {
          preserveRenderedMessages: Boolean(message.preserveRenderedMessages),
        });
        return;
      }
      if (message.type === 'status') {
        setStatus(message.value || '', false);
        return;
      }
      if (message.type === 'assistantStart') {
        setAssistantRunning(true, message.value || activeSessionId);
        handleAssistantStart();
        return;
      }
      if (message.type === 'assistantSession') {
        setAssistantRunning(true, message.value || activeSessionId);
        return;
      }
      if (message.type === 'assistantDelta') {
        handleAssistantDelta(message.value || '');
        return;
      }
      if (message.type === 'assistantActivity') {
        updateAssistantActivity(message.value || null);
        return;
      }
      if (message.type === 'assistantProgress') {
        appendProgressMessage(message.value || '');
        return;
      }
      if (message.type === 'assistantDone') {
        finalizeAssistantContent(message.value || '');
        finalizeAssistantMeta();
        pendingAssistantCompleted = true;
        setAssistantRunning(false);
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
        finalizeAssistantMeta();
        pendingAssistantNode = null;
        pendingAssistantStatus = null;
        pendingAssistantActivity = null;
        pendingAssistantMeta = null;
        pendingAssistantThinkingToggle = null;
        pendingAssistantThinkingPanel = null;
        pendingAssistantText = '';
        pendingAssistantThinking = '';
        pendingAssistantStartedAt = 0;
        lastProgressMessage = '';
        pendingAssistantCompleted = false;
        setAssistantRunning(false);
        setStatus(String(message.value || 'Unexpected error'), true);
      }
    });

    form.addEventListener('submit', function(event) {
      event.preventDefault();
      if (assistantRunning) {
        if (activeSessionId) {
          postToExtension({
            type: 'cancelSession',
            sessionId: activeSessionId,
          });
        }
        setStatus('Stopping...', false);
        return;
      }

      const promptValue = String(promptNode.value || '').trim();
      const nextAttachments = attachments.slice();
      if (!promptValue && !nextAttachments.length) {
        return;
      }

      const shouldForceNewThread = viewMode === 'list';
      const nextMessages = shouldForceNewThread
        ? []
        : (Array.isArray(state.messages) ? state.messages.slice() : []);
      nextMessages.push({
        role: 'user',
        content: promptValue || describeAttachments(nextAttachments),
        attachments: nextAttachments,
      });
      showDetailView();
      renderMessages(nextMessages);

      postToExtension({
        type: 'sendMessage',
        prompt: promptValue,
        forceNewThread: shouldForceNewThread,
        modelSelectionId: state.runtimeProvider === 'osirus' ? String(modelSelect.value || '') : '',
        osirusChatId: String(state.osirusChatId || ''),
        attachments: nextAttachments,
      });

      setAssistantRunning(true);
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

    document.getElementById('newThread').addEventListener('click', function() {
      closeSettingsMenu();
      closeHistoryMenu();
      didAutoEnterDetail = true;
      showDetailView();
      postToExtension({ type: 'newThread' });
    });

    backButton.addEventListener('click', function() {
      showListView();
    });

    historyToggle.addEventListener('click', function(event) {
      event.stopPropagation();
      closeSettingsMenu();
      historyMenu.hidden = !historyMenu.hidden;
    });

    settingsToggle.addEventListener('click', function(event) {
      event.stopPropagation();
      closeHistoryMenu();
      settingsMenu.hidden = !settingsMenu.hidden;
    });

    document.addEventListener('click', function(event) {
      if (!historyMenu.hidden && !historyMenu.contains(event.target) && event.target !== historyToggle) {
        closeHistoryMenu();
      }
      if (!settingsMenu.hidden && !settingsMenu.contains(event.target) && event.target !== settingsToggle) {
        closeSettingsMenu();
      }
    });

    document.getElementById('loginButton').addEventListener('click', function() {
      postToExtension({ type: 'login' });
    });
    document.getElementById('signupButton').addEventListener('click', function() {
      postToExtension({ type: 'signup' });
    });
    document.getElementById('configureButton').addEventListener('click', function() {
      postToExtension({ type: 'configure' });
    });
    document.getElementById('settingsConfigure').addEventListener('click', function() {
      closeSettingsMenu();
      postToExtension({ type: 'configure' });
    });
    document.getElementById('settingsHealth').addEventListener('click', function() {
      closeSettingsMenu();
      postToExtension({ type: 'health' });
    });
    document.getElementById('settingsLogs').addEventListener('click', function() {
      closeSettingsMenu();
      postToExtension({ type: 'logs' });
    });
    settingsSwitchOrg.addEventListener('click', function() {
      closeSettingsMenu();
      postToExtension({ type: 'switchOrg' });
    });
    settingsLogout.addEventListener('click', function() {
      closeSettingsMenu();
      postToExtension({ type: 'logout' });
    });

    approvalAllowButton.addEventListener('click', function() {
      if (!pendingApprovalState || !pendingApprovalState.sessionId) {
        return;
      }
      postToExtension({
        type: 'approvalDecision',
        sessionId: String(pendingApprovalState.sessionId || ''),
        decision: 'allow',
      });
    });

    approvalDenyButton.addEventListener('click', function() {
      if (!pendingApprovalState || !pendingApprovalState.sessionId) {
        return;
      }
      postToExtension({
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

    form.addEventListener('paste', function(event) {
      void handleAttachmentPaste(event);
    });

    renderAttachments();
    renderModelOptions([], '');
    if (viewMode === 'detail') {
      showDetailView();
    } else {
      showListView();
    }
    setStatus('Requesting chat state...', false);
    postToExtension({ type: 'ready' });
  </script>
</body>
</html>`;
}
