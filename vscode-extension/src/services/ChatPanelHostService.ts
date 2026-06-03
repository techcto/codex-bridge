import * as vscode from 'vscode';
import { getChatWebviewHtml } from '../ui/chatWebviewHtml';
import { ChatPanelController } from '../controllers/ChatPanelController';

export type ChatPanelHostServiceDeps = {
  context: vscode.ExtensionContext;
  controller: ChatPanelController;
  ensureLocalBridgeRunning: () => Promise<void>;
  getBaseUrl: () => string;
  getCurrentRuntimeProvider: () => string;
  getErrorMessage: (error: unknown) => string;
  outputChannel?: { appendLine(value: string): void };
  pushPanelState: () => Promise<void>;
  refreshSidebar: () => void;
};

export class ChatPanelHostService {
  private readonly deps: ChatPanelHostServiceDeps;
  private panel: vscode.WebviewPanel | undefined;
  private isWebviewReady = false;
  private pendingStatePayload: Record<string, unknown> | undefined;

  public constructor(deps: ChatPanelHostServiceDeps) {
    this.deps = deps;
  }

  public async open(): Promise<void> {
    if (this.deps.getCurrentRuntimeProvider() !== 'osirus') {
      await this.deps.ensureLocalBridgeRunning();
    }
    this.deps.refreshSidebar();

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      if (this.pendingStatePayload) {
        await this.deliverState(this.pendingStatePayload);
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'codexBridgeChat',
      'Codex Bridge Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.isWebviewReady = false;
      this.pendingStatePayload = undefined;
    }, null, this.deps.context.subscriptions);

    this.panel.webview.onDidReceiveMessage(async (message) => {
      const activePanel = this.panel;
      if (!activePanel) {
        return;
      }

      if (message?.type === 'ready') {
        this.isWebviewReady = true;
        this.deps.outputChannel?.appendLine('[bridge] chat webview -> ready');
        if (this.pendingStatePayload) {
          await this.deliverState(this.pendingStatePayload);
        } else {
          await this.deps.pushPanelState();
        }
      } else if (message?.type === 'clientLog') {
        this.deps.outputChannel?.appendLine(`[bridge] chat webview: ${this.deps.getErrorMessage(message?.value || '')}`);
      } else if (message?.type === 'clientError') {
        this.deps.outputChannel?.appendLine(`[bridge] chat webview client error: ${this.deps.getErrorMessage(message?.value || 'Unknown client error')}`);
      }

      try {
        await this.deps.controller.handleMessage(activePanel, message, async () => {
          await this.deps.pushPanelState();
        });
      } catch (error) {
        activePanel.webview.postMessage({ type: 'error', value: this.deps.getErrorMessage(error) });
        await this.deps.pushPanelState();
      }
    }, null, this.deps.context.subscriptions);

    this.panel.webview.html = getChatWebviewHtml();
    await this.deps.pushPanelState();
  }

  public async pushState(payload: Record<string, unknown>): Promise<void> {
    this.pendingStatePayload = payload;
    if (!this.panel) {
      return;
    }

    await this.deliverState(payload);
  }

  public hasOpenPanel(): boolean {
    return Boolean(this.panel);
  }

  private async deliverState(payload: Record<string, unknown>): Promise<void> {
    if (!this.panel) {
      return;
    }

    if (!this.isWebviewReady) {
      this.deps.outputChannel?.appendLine('[bridge] chat webview not ready yet; caching latest state payload');
      return;
    }

    this.deps.outputChannel?.appendLine(`[bridge] chat webview <- state provider=${String(payload.runtimeProvider || '')} threads=${Array.isArray(payload.threads) ? payload.threads.length : 0} models=${Array.isArray(payload.osirusModels) ? payload.osirusModels.length : 0}`);
    const delivered = await this.panel.webview.postMessage({
      type: 'state',
      payload,
    });

    if (!delivered) {
      this.deps.outputChannel?.appendLine('[bridge] chat webview did not accept state payload');
    }
  }
}
