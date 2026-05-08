import * as vscode from 'vscode';

export type SidebarProviderDeps = {
  checkHealth: () => Promise<void>;
  configureConnection: () => Promise<void>;
  getCurrentRuntimeProvider: () => string;
  getOsirusApiKeysUrl: () => string;
  getOsirusSignupUrl: () => string;
  loginToOsirus: () => Promise<void>;
  loginToOsirusAccount: () => Promise<void>;
  logoutFromOsirus: () => Promise<void>;
  logoutFromOsirusAccount: () => Promise<void>;
  openChat: () => Promise<void>;
  openExternal: (uri: vscode.Uri) => Thenable<boolean>;
  refreshOpenOsirusChatState: () => Promise<void>;
  renderHtml: () => Promise<string>;
  setProviderApiKey: (value: string) => Promise<void>;
  showInfo: (message: string) => Thenable<string | undefined>;
  showLogs: () => void;
  switchOsirusOrg: () => Promise<{ orgName: string }>;
};

export class CodexBridgeSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly deps: SidebarProviderDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'openChat':
          await this.deps.openChat();
          break;
        case 'configure':
          await this.deps.configureConnection();
          break;
        case 'health':
          await this.deps.checkHealth();
          break;
        case 'logs':
          this.deps.showLogs();
          break;
        case 'login':
          if (this.deps.getCurrentRuntimeProvider() === 'osirus_agent') {
            await this.deps.loginToOsirus();
          } else if (this.deps.getCurrentRuntimeProvider() === 'osirus') {
            await this.deps.loginToOsirusAccount();
          } else {
            await this.deps.configureConnection();
          }
          break;
        case 'logout':
          if (this.deps.getCurrentRuntimeProvider() === 'osirus_agent') {
            await this.deps.logoutFromOsirus();
          } else if (this.deps.getCurrentRuntimeProvider() === 'osirus') {
            await this.deps.logoutFromOsirusAccount();
          } else {
            await this.deps.setProviderApiKey('');
            await this.deps.showInfo('Provider API key cleared for this extension.');
            await this.refresh();
          }
          break;
        case 'switchOrg':
          if (this.deps.getCurrentRuntimeProvider() === 'osirus') {
            const resolved = await this.deps.switchOsirusOrg();
            await this.deps.refreshOpenOsirusChatState();
            await this.deps.showInfo(`Switched Osirus organization to ${resolved.orgName}.`);
          }
          break;
        case 'signup':
          if (this.deps.getCurrentRuntimeProvider() === 'osirus_agent' || this.deps.getCurrentRuntimeProvider() === 'osirus') {
            await this.deps.openExternal(vscode.Uri.parse(this.deps.getOsirusSignupUrl()));
          } else {
            await this.deps.configureConnection();
          }
          break;
        case 'apiKeys':
          if (this.deps.getCurrentRuntimeProvider() === 'osirus_agent') {
            await this.deps.openExternal(vscode.Uri.parse(this.deps.getOsirusApiKeysUrl()));
          } else {
            await this.deps.configureConnection();
          }
          break;
        default:
          break;
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    try {
      this.view.webview.html = await this.deps.renderHtml();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.view.webview.html = this.renderErrorHtml(detail);
    }
  }

  private renderErrorHtml(detail: string): string {
    const message = this.escapeHtml(detail || 'Unknown sidebar render failure.');
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
      border-radius: 12px;
      padding: 14px;
    }
    .title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .copy {
      color: var(--vscode-descriptionForeground, #9da5b4);
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Codex Bridge sidebar failed to render</div>
    <div class="copy">${message}</div>
  </div>
</body>
</html>`;
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}
