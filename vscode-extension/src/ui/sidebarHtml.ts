export type SidebarHtmlProps = {
  activeOsirusOrgId: string;
  activeOsirusOrgName: string;
  authLabel: string;
  baseUrl: string;
  loginButtonLabel: string;
  provider: string;
  providerDisplayName: string;
  providerIcon: string;
  readyCopy: string;
  runtime: string;
  runtimeProvider: string;
  setupCopy: string;
  signedIn: boolean;
  signupButtonLabel: string;
  state: string;
  stateLabel: string;
  welcomeTitle: string;
};

export function buildSidebarHtml(props: SidebarHtmlProps): string {
  const {
    activeOsirusOrgId,
    activeOsirusOrgName,
    authLabel,
    baseUrl,
    loginButtonLabel,
    provider,
    providerDisplayName,
    providerIcon,
    readyCopy,
    runtime,
    runtimeProvider,
    setupCopy,
    signedIn,
    signupButtonLabel,
    state,
    stateLabel,
    welcomeTitle,
  } = props;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-editor-foreground, #d4d4d4);
      background: var(--vscode-sideBar-background, #1e1e1e);
      font-family: var(--vscode-font-family, sans-serif);
    }
    .card {
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
      background: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    }
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .icon {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, rgba(96,165,250,0.18), rgba(110,231,183,0.16));
      font-size: 16px;
    }
    .title {
      font-weight: 700;
      font-size: 13px;
    }
    .meta {
      color: var(--vscode-descriptionForeground, #9da5b4);
      font-size: 12px;
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .welcome {
      font-size: 20px;
      font-weight: 700;
      margin: 2px 0 8px;
      line-height: 1.25;
    }
    .copy {
      color: var(--vscode-descriptionForeground, #9da5b4);
      font-size: 13px;
      line-height: 1.55;
      margin-bottom: 16px;
    }
    .loader-wrap {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 12px;
      margin-bottom: 14px;
      background: linear-gradient(135deg, rgba(96,165,250,0.10), rgba(110,231,183,0.08));
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
    }
    .spinner {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 2px solid rgba(96,165,250,0.18);
      border-top-color: var(--vscode-textLink-foreground);
      animation: spin 0.9s linear infinite;
      flex: 0 0 auto;
    }
    .loader-copy {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #9da5b4);
      line-height: 1.4;
    }
    .pill {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      margin-bottom: 10px;
    }
    .buttons {
      display: grid;
      gap: 8px;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 10px;
      padding: 10px 12px;
      cursor: pointer;
      text-align: left;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.secondary {
      color: var(--vscode-textLink-foreground, #4ea1ff);
      background: var(--vscode-input-background, rgba(255,255,255,0.04));
      border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.12));
    }
    .inline-link {
      color: var(--vscode-textLink-foreground, #4ea1ff);
      text-decoration: none;
    }
    .inline-link:hover {
      text-decoration: underline;
    }
    .inline-code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 999px;
      background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06));
      color: var(--vscode-editor-foreground, #d4d4d4);
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">${providerIcon}</div>
      <div class="title">Codex Bridge</div>
    </div>
    ${state === 'starting' ? `
      <div class="loader-wrap">
        <div class="spinner"></div>
        <div class="loader-copy">Starting Codex Bridge and preparing your ${providerDisplayName} workspace...</div>
      </div>
    ` : ''}
    ${signedIn ? `
      <div class="pill">${stateLabel}</div>
      <div class="welcome">Welcome back</div>
      <div class="copy">${readyCopy}</div>
      <div class="meta">Bridge: ${baseUrl}<br>Provider: ${provider}${runtimeProvider === 'osirus' && activeOsirusOrgName ? `<br>Org: ${activeOsirusOrgName}${activeOsirusOrgId ? ` (${activeOsirusOrgId})` : ''}` : ''}<br>Auth: ${authLabel}<br>Runtime: ${runtime}</div>
      <div class="buttons">
        <button id="openChat">Open Chat</button>
        <button id="configure" class="secondary">Configure Connection</button>
        ${runtimeProvider === 'osirus' ? `<button id="switchOrg" class="secondary">Switch Org</button>` : ''}
        ${(runtimeProvider === 'osirus' || runtimeProvider === 'osirus_agent' || authLabel === 'api_key') ? `<button id="logout" class="secondary">${runtimeProvider === 'osirus' ? 'Sign Out' : 'Clear API Key'}</button>` : ''}
        <button id="health" class="secondary">Check Health</button>
        <button id="logs" class="secondary">Show Logs</button>
      </div>
    ` : `
      <div class="pill">${stateLabel}</div>
      <div class="welcome">${welcomeTitle}</div>
      <div class="copy">${setupCopy}</div>
      <div class="buttons">
        <button id="login">${loginButtonLabel}</button>
        <button id="signup" class="secondary">${signupButtonLabel}</button>
        <button id="configure" class="secondary">Configure Connection</button>
      </div>
    `}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('openChat')?.addEventListener('click', () => vscode.postMessage({ type: 'openChat' }));
    document.getElementById('configure')?.addEventListener('click', () => vscode.postMessage({ type: 'configure' }));
    document.getElementById('health')?.addEventListener('click', () => vscode.postMessage({ type: 'health' }));
    document.getElementById('logs')?.addEventListener('click', () => vscode.postMessage({ type: 'logs' }));
    document.getElementById('login')?.addEventListener('click', () => vscode.postMessage({ type: 'login' }));
    document.getElementById('logout')?.addEventListener('click', () => vscode.postMessage({ type: 'logout' }));
    document.getElementById('switchOrg')?.addEventListener('click', () => vscode.postMessage({ type: 'switchOrg' }));
    document.getElementById('signup')?.addEventListener('click', () => vscode.postMessage({ type: 'signup' }));
    document.getElementById('apiKeysLink')?.addEventListener('click', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'apiKeys' });
    });
  </script>
</body>
</html>`;
}
