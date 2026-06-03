import * as vscode from 'vscode';
import { ChatPanelController } from '../controllers/ChatPanelController';

export type SidebarProviderDeps = {
  buildState: () => Promise<Record<string, unknown>>;
  checkHealth: () => Promise<void>;
  configureConnection: () => Promise<void>;
  controller: ChatPanelController;
  getCurrentRuntimeProvider: () => string;
  getOsirusApiKeysUrl: () => string;
  getOsirusSignupUrl: () => string;
  loginToOsirus: () => Promise<void>;
  loginToOsirusAccount: () => Promise<void>;
  logoutFromOsirus: () => Promise<void>;
  logoutFromOsirusAccount: () => Promise<void>;
  openExternal: (uri: vscode.Uri) => Thenable<boolean>;
  outputChannel?: { appendLine(value: string): void };
  refreshOpenOsirusChatState: () => Promise<void>;
  renderHtml: () => string;
  setProviderApiKey: (value: string) => Promise<void>;
  showInfo: (message: string) => Thenable<string | undefined>;
  showLogs: () => void;
  switchOsirusOrg: () => Promise<{ orgName: string }>;
};

export class CodexBridgeSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private isReady = false;
  private pendingStatePayload: Record<string, unknown> | undefined;
  private refreshInFlight = false;
  private refreshQueued = false;

  constructor(private readonly deps: SidebarProviderDeps) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message?.type) {
          case 'clientError':
            this.deps.outputChannel?.appendLine(`[bridge] sidebar client error: ${String(message?.value || 'Unknown sidebar client error')}`);
            break;
          case 'clientLog':
            this.deps.outputChannel?.appendLine(`[bridge] sidebar webview: ${String(message?.value || '')}`);
            break;
          case 'configure':
            await this.deps.configureConnection();
            void this.refresh();
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
            void this.refresh();
            break;
          case 'logout':
            if (this.deps.getCurrentRuntimeProvider() === 'osirus_agent') {
              await this.deps.logoutFromOsirus();
            } else if (this.deps.getCurrentRuntimeProvider() === 'osirus') {
              await this.deps.logoutFromOsirusAccount();
            } else {
              await this.deps.setProviderApiKey('');
              await this.deps.showInfo('Provider API key cleared for this extension.');
            }
            void this.refresh();
            break;
          case 'switchOrg':
            if (this.deps.getCurrentRuntimeProvider() === 'osirus') {
              const resolved = await this.deps.switchOsirusOrg();
              await this.deps.refreshOpenOsirusChatState();
              await this.deps.showInfo(`Switched Osirus organization to ${resolved.orgName}.`);
            }
            void this.refresh();
            break;
          case 'signup':
            if (this.deps.getCurrentRuntimeProvider() === 'osirus_agent' || this.deps.getCurrentRuntimeProvider() === 'osirus') {
              await this.deps.openExternal(vscode.Uri.parse(this.deps.getOsirusSignupUrl()));
            } else {
              await this.deps.configureConnection();
              void this.refresh();
            }
            break;
          case 'apiKeys':
            if (this.deps.getCurrentRuntimeProvider() === 'osirus_agent') {
              await this.deps.openExternal(vscode.Uri.parse(this.deps.getOsirusApiKeysUrl()));
            } else {
              await this.deps.configureConnection();
            }
            break;
          case 'openFile':
            await this.openFileInEditor(String(message.path || ''), Number(message.line || 0));
            break;
          case 'openLink':
            if (message.url) {
              await this.deps.openExternal(vscode.Uri.parse(String(message.url)));
            }
            break;
          case 'ready':
            this.isReady = true;
            if (this.pendingStatePayload) {
              await this.deliverState(this.pendingStatePayload);
            } else if (!this.refreshInFlight) {
              void this.refresh();
            }
            break;
          default:
            if (!this.view) {
              return;
            }
            await this.deps.controller.handleMessage(this.view, message, async () => {
              await this.refresh();
            });
            break;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/operation was aborted|canceled by user|cancelled by user/i.test(detail)) {
          this.deps.outputChannel?.appendLine(`[bridge] sidebar action stopped: ${detail}`);
          if (this.view) {
            void this.view.webview.postMessage({ type: 'status', value: 'Stopped.' });
            void this.view.webview.postMessage({ type: 'assistantDone', value: '' });
          }
          return;
        }
        this.deps.outputChannel?.appendLine(`[bridge] sidebar action failed: ${detail}`);
        void vscode.window.showErrorMessage(detail);
        if (this.view) {
          void this.view.webview.postMessage({ type: 'error', value: detail });
        }
        void this.refresh();
      }
    });

    webviewView.webview.html = this.deps.renderHtml();
    this.isReady = false;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }

    this.refreshInFlight = true;
    try {
      do {
        this.refreshQueued = false;
        try {
          await this.pushState(await this.deps.buildState());
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (this.view) {
            this.view.webview.html = this.renderErrorHtml(detail);
          }
          this.isReady = false;
        }
      } while (this.refreshQueued && this.view);
    } finally {
      this.refreshInFlight = false;
    }
  }

  async pushState(payload: Record<string, unknown>): Promise<void> {
    this.pendingStatePayload = payload;
    await this.deliverState(payload);
  }

  focus(): void {
    if (this.view) {
      this.view.show(false);
      return;
    }
    void vscode.commands.executeCommand('codexBridge.sidebar.focus');
  }

  private async deliverState(payload: Record<string, unknown>): Promise<void> {
    if (!this.view || !this.isReady) {
      return;
    }
    await this.view.webview.postMessage({
      type: 'state',
      payload,
    });
  }

  private async openFileInEditor(rawPath: string, line: number): Promise<void> {
    const target = this.parseFileTarget(rawPath, line);
    if (!target.path) {
      return;
    }

    const path = this.resolveWorkspacePath(target.path);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
    const targetLine = Math.max(0, Number.isFinite(target.line) ? target.line - 1 : 0);
    const position = new vscode.Position(targetLine, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private parseFileTarget(rawPath: string, line: number): { path: string; line: number } {
    const raw = String(rawPath || '').trim();
    let normalized = raw;
    try {
      normalized = decodeURIComponent(raw);
    } catch {
      normalized = raw.replace(/%3A/ig, ':');
    }

    if (normalized.startsWith('<') && normalized.endsWith('>')) {
      normalized = normalized.slice(1, -1).trim();
    }

    const match = normalized.match(/^(.*):(\d+)$/);
    const parsedLine = Number(match?.[2] || 0);
    return {
      path: String(match?.[1] || normalized).trim(),
      line: parsedLine > 0 ? parsedLine : Number(line || 0),
    };
  }

  private resolveWorkspacePath(rawPath: string): string {
    if (/^file:\/\//i.test(rawPath)) {
      return vscode.Uri.parse(rawPath).fsPath;
    }

    if (/^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('\\\\')) {
      return rawPath;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return rawPath;
    }

    return vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), rawPath).fsPath;
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
