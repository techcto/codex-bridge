import * as vscode from 'vscode';
import {
  getProviderBaseUrlHint,
  getProviderDisplayName,
  getProviderIcon,
  getProviderSetupSummary,
  providerNeedsSavedApiKey,
} from '../providers';
import { escapeHtml } from '../ui/html';
import { buildSidebarHtml } from '../ui/sidebarHtml';
import type { AuthMode, BridgeHealthResponse, RuntimeProvider } from '../types';

export type ExtensionUiServiceDeps = {
  ensureLocalBridgeRunning: () => Promise<void>;
  getBaseUrl: () => string;
  getBridgeState: () => 'ready' | 'starting' | 'stopped' | 'remote';
  getCurrentAuthMode: () => AuthMode;
  getCurrentRuntimeProvider: () => RuntimeProvider;
  getErrorMessage: (error: unknown) => string;
  getLocalRuntimeSummary: () => Promise<string>;
  getOsirusApiKeysUrl: () => string;
  getStoredOsirusActiveOrgId: () => Promise<string>;
  getStoredOsirusActiveOrgName: () => Promise<string>;
  hasOsirusAccountSession: () => Promise<boolean>;
  hasSavedApiKey: () => Promise<boolean>;
  isLocalBaseUrl: () => boolean;
  isStatusBarButtonEnabled: () => boolean;
  outputChannel?: vscode.OutputChannel;
  pushRuntimeConfig: (options?: { suppressErrors?: boolean; modelOverride?: string }) => Promise<boolean>;
  refreshSidebar: () => void;
  requestJson: <T>(method: string, path: string, body?: unknown, options?: { suppressLog?: boolean; timeoutMs?: number }) => Promise<T>;
  resolveLocalCodexRuntime: () => Promise<{ command: string; source: string }>;
  shouldManageLocalBridge: () => boolean;
  statusBarItem?: vscode.StatusBarItem;
};

export class ExtensionUiService {
  private readonly deps: ExtensionUiServiceDeps;

  public constructor(deps: ExtensionUiServiceDeps) {
    this.deps = deps;
  }

  public async loginToOsirus(
    getProviderApiKey: () => Promise<string>,
    setProviderApiKey: (value: string) => Promise<void>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    const currentApiKey = await getProviderApiKey();
    const apiKeysUrl = this.deps.getOsirusApiKeysUrl();

    const action = await vscode.window.showInformationMessage(
      'Paste your Osirus API key to connect this extension. If you need one first, open the API keys page.',
      { modal: true },
      'Paste API Key',
      'Open API Keys'
    );

    if (!action) {
      return;
    }

    if (action === 'Open API Keys') {
      await vscode.env.openExternal(vscode.Uri.parse(apiKeysUrl));
    }

    const apiKey = await vscode.window.showInputBox({
      title: 'Osirus API Key',
      value: currentApiKey,
      password: true,
      prompt: `Paste your Osirus API key. Need one? ${apiKeysUrl}`,
      ignoreFocusOut: true,
    });

    if (apiKey === undefined) {
      return;
    }

    await config.update('runtimeProvider', 'osirus_agent', vscode.ConfigurationTarget.Global);
    await config.update('authMode', apiKey.trim() !== '' ? 'api_key' : 'none', vscode.ConfigurationTarget.Global);
    await setProviderApiKey(apiKey.trim());

    await this.deps.ensureLocalBridgeRunning();
    await this.deps.pushRuntimeConfig();
    this.deps.refreshSidebar();

    void vscode.window.showInformationMessage(apiKey.trim() !== '' ? 'Osirus API key saved.' : 'Osirus API key cleared.');
  }

  public async logoutFromOsirus(
    setProviderApiKey: (value: string) => Promise<void>,
    clearSessionState: () => Promise<void>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    await setProviderApiKey('');
    await config.update('authMode', 'none', vscode.ConfigurationTarget.Global);
    await clearSessionState();
    await this.deps.pushRuntimeConfig();
    this.deps.refreshSidebar();
    void vscode.window.showInformationMessage('Logged out from Osirus in this extension.');
  }

  public async checkHealth(): Promise<void> {
    try {
      await this.deps.ensureLocalBridgeRunning();
      await this.deps.pushRuntimeConfig();
      const health = await this.deps.requestJson<BridgeHealthResponse>('GET', '/health');
      if (health.ok !== true) {
        throw new Error(health.error || 'Bridge health check failed.');
      }

      const runtimeProvider = health.runtime_config?.runtime_provider || 'unknown';
      const authMode = health.runtime_config?.auth_mode || 'unknown';
      const runtimeKind = health.runtime_kind || 'unknown';
      void vscode.window.showInformationMessage(
        `Codex Bridge is healthy. Runtime: ${runtimeKind}. Provider: ${runtimeProvider}. Auth: ${authMode}.`
      );
    } catch (error) {
      void vscode.window.showErrorMessage(this.deps.getErrorMessage(error));
    }
  }

  public async initialize(): Promise<void> {
    this.updateStatusBar('starting');
    this.deps.refreshSidebar();

    if (!this.deps.isStatusBarButtonEnabled()) {
      this.deps.statusBarItem?.hide();
    }

    if (!this.deps.shouldManageLocalBridge()) {
      this.updateStatusBar('ready');
      return;
    }

    try {
      await this.deps.ensureLocalBridgeRunning();
      await this.deps.pushRuntimeConfig();
      this.updateStatusBar('ready');
      this.deps.refreshSidebar();
    } catch (error) {
      this.deps.outputChannel?.appendLine(`[bridge] startup initialization failed: ${this.deps.getErrorMessage(error)}`);
      this.updateStatusBar('error');
      this.deps.refreshSidebar();
    }
  }

  public updateStatusBar(state: 'idle' | 'starting' | 'ready' | 'stopped' | 'error'): void {
    const item = this.deps.statusBarItem;
    if (!item) {
      return;
    }

    if (!this.deps.isStatusBarButtonEnabled()) {
      item.hide();
      return;
    }

    switch (state) {
      case 'starting':
        item.text = '$(sync~spin) Codex Bridge';
        item.tooltip = `Codex Bridge is starting at ${this.deps.getBaseUrl()}`;
        break;
      case 'ready':
        item.text = '$(sparkle) Codex Bridge';
        item.tooltip = `Open Codex Bridge chat at ${this.deps.getBaseUrl()}`;
        break;
      case 'stopped':
        item.text = '$(circle-slash) Codex Bridge';
        item.tooltip = 'Codex Bridge is stopped. Click to open chat and restart if auto-start is enabled.';
        break;
      case 'error':
        item.text = '$(warning) Codex Bridge';
        item.tooltip = 'Codex Bridge startup failed. Use "Codex Bridge: Show Bridge Logs" for details.';
        break;
      default:
        item.text = '$(sparkle) Codex Bridge';
        item.tooltip = 'Open Codex Bridge chat.';
        break;
    }

    item.show();
  }

  public getBridgeState(): 'ready' | 'starting' | 'stopped' | 'remote' {
    return this.deps.getBridgeState();
  }

  public async getSidebarHtml(): Promise<string> {
    const baseUrl = escapeHtml(this.deps.getBaseUrl());
    const runtimeProvider = this.deps.getCurrentRuntimeProvider();
    const authMode = this.deps.getCurrentAuthMode();
    const provider = escapeHtml(runtimeProvider);
    const providerDisplayName = escapeHtml(getProviderDisplayName(runtimeProvider));
    const providerIcon = escapeHtml(getProviderIcon(runtimeProvider));
    const requiresSavedApiKey = providerNeedsSavedApiKey(runtimeProvider, authMode);
    const signedIn = runtimeProvider === 'osirus'
      ? await this.deps.hasOsirusAccountSession()
      : (requiresSavedApiKey ? await this.deps.hasSavedApiKey() : true);
    const runtime = escapeHtml(await this.deps.getLocalRuntimeSummary());
    const state = this.deps.getBridgeState();
    const stateLabel = state === 'remote'
      ? 'Remote Bridge'
      : (state === 'ready' ? 'Local Bridge Ready' : (state === 'starting' ? 'Auto-Start Enabled' : 'Local Bridge Stopped'));
    const apiKeysUrl = escapeHtml(this.deps.getOsirusApiKeysUrl());
    const setupSummary = escapeHtml(getProviderSetupSummary(runtimeProvider, authMode));
    const baseUrlHint = escapeHtml(getProviderBaseUrlHint(runtimeProvider));
    const activeOsirusOrgName = runtimeProvider === 'osirus' ? escapeHtml(await this.deps.getStoredOsirusActiveOrgName()) : '';
    const activeOsirusOrgId = runtimeProvider === 'osirus' ? escapeHtml(await this.deps.getStoredOsirusActiveOrgId()) : '';
    const loginButtonLabel = runtimeProvider === 'osirus_agent'
      ? 'Login'
      : (runtimeProvider === 'osirus' ? 'Login with Osirus' : 'Configure');
    const signupButtonLabel = runtimeProvider === 'osirus_agent' || runtimeProvider === 'osirus'
      ? 'Signup'
      : 'Connection Help';
    const readyCopy = runtimeProvider === 'osirus_agent'
      ? 'Your Osirus Agent runtime is ready. Open Codex Bridge to inspect files, edit code, run commands, and work through the agent runtime.'
      : runtimeProvider === 'osirus'
        ? 'Your Osirus.AI account is connected. Open Codex Bridge to test model-backed agent runtimes and future bridge-side tool augmentation.'
        : `Your ${getProviderDisplayName(runtimeProvider)} runtime is ready. Open Codex Bridge to work through the agent runtime, adjust the connection, or inspect logs.`;
    const welcomeTitle = runtimeProvider === 'osirus_agent'
      ? 'Welcome to Osirus Agent'
      : `Welcome to ${getProviderDisplayName(runtimeProvider)}`;
    const setupCopy = runtimeProvider === 'osirus_agent'
      ? `Connect your Osirus account to start using Codex Bridge from VS Code. Login uses an API key. Need one first? Visit <a class="inline-link" href="${apiKeysUrl}" id="apiKeysLink">API Keys</a>.`
      : runtimeProvider === 'osirus'
        ? `Sign in with your Osirus account to use the regular Osirus model catalog inside Codex Bridge while the bridge-side tool adapter is built out. Base URL: <span class="inline-code">${baseUrlHint}</span>.`
        : `${setupSummary}${baseUrlHint ? ` Base URL: <span class="inline-code">${baseUrlHint}</span>.` : ''}`;
    const authLabel = runtimeProvider === 'osirus' && signedIn ? 'osirus_account' : authMode;

    return buildSidebarHtml({
      activeOsirusOrgId,
      activeOsirusOrgName,
      authLabel: escapeHtml(authLabel),
      baseUrl,
      loginButtonLabel: escapeHtml(loginButtonLabel),
      provider,
      providerDisplayName,
      providerIcon,
      readyCopy: escapeHtml(readyCopy),
      runtime,
      runtimeProvider,
      setupCopy,
      signedIn,
      signupButtonLabel: escapeHtml(signupButtonLabel),
      state,
      stateLabel: escapeHtml(stateLabel),
      welcomeTitle: escapeHtml(welcomeTitle),
    });
  }
}
