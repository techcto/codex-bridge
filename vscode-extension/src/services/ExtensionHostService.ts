import * as vscode from 'vscode';
import { access, mkdir } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { normalizeOsirusCompatBaseUrl } from '../providers';
import type { AuthMode, RuntimeConfigPayload, RuntimeProvider } from '../types';

export type ExtensionHostServiceDeps = {
  context: vscode.ExtensionContext;
  getProviderApiKey: () => Promise<string>;
  getValidOsirusAccessToken: () => Promise<string>;
  outputChannel?: vscode.OutputChannel;
  refreshSidebar: () => void;
};

export class ExtensionHostService {
  private readonly context: vscode.ExtensionContext;
  private readonly getProviderApiKey: () => Promise<string>;
  private readonly getValidOsirusAccessToken: () => Promise<string>;
  private readonly outputChannel?: vscode.OutputChannel;
  private readonly refreshSidebar: () => void;

  public constructor(deps: ExtensionHostServiceDeps) {
    this.context = deps.context;
    this.getProviderApiKey = deps.getProviderApiKey;
    this.getValidOsirusAccessToken = deps.getValidOsirusAccessToken;
    this.outputChannel = deps.outputChannel;
    this.refreshSidebar = deps.refreshSidebar;
  }

  public getBaseUrl(): string {
    return vscode.workspace.getConfiguration('codexBridge').get<string>('baseUrl', 'http://127.0.0.1:4400').replace(/\/+$/, '');
  }

  public getOsirusSignupUrl(): string {
    return vscode.workspace.getConfiguration('codexBridge').get<string>('osirusSignupUrl', 'https://osirus.ai/signup');
  }

  public getOsirusApiKeysUrl(): string {
    return vscode.workspace.getConfiguration('codexBridge').get<string>('osirusApiKeysUrl', 'https://osirus.ai/api-keys');
  }

  public getCurrentRuntimeProvider(): RuntimeProvider {
    return vscode.workspace.getConfiguration('codexBridge').get<RuntimeProvider>('runtimeProvider', 'openai');
  }

  public getCurrentAuthMode(): AuthMode {
    return vscode.workspace.getConfiguration('codexBridge').get<AuthMode>('authMode', 'chatgpt');
  }

  public getConfiguredProviderApiBaseUrl(): string {
    return vscode.workspace.getConfiguration('codexBridge').get<string>('providerApiBaseUrl', '').trim();
  }

  public getOsirusAccountApiBaseUrl(): string {
    const configured = this.getConfiguredProviderApiBaseUrl();
    if (configured !== '' && this.isValidAbsoluteUrl(configured)) {
      return configured.replace(/\/+$/, '');
    }

    return 'https://osirus.ai/api';
  }

  public getOsirusCompatApiBaseUrl(): string {
    return normalizeOsirusCompatBaseUrl(this.getOsirusAccountApiBaseUrl());
  }

  public isValidAbsoluteUrl(value: string): boolean {
    try {
      new URL(value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  public async migrateLegacyOsirusProvider(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    const runtimeProvider = config.get<RuntimeProvider>('runtimeProvider', 'openai');
    const providerApiBaseUrl = config.get<string>('providerApiBaseUrl', '').trim();

    if (runtimeProvider === 'osirus' && /\/api\/agents\/[^/]+\/v1/i.test(providerApiBaseUrl)) {
      await config.update('runtimeProvider', 'osirus_agent', vscode.ConfigurationTarget.Global);
      this.outputChannel?.appendLine('[bridge] migrated legacy osirus provider to osirus_agent based on agent-scoped /v1 URL');
      this.refreshSidebar();
    }
  }

  public getBridgeRootPath(): string {
    return path.resolve(this.context.extensionPath, '..');
  }

  public getBridgeServerPath(): string {
    return path.join(this.getBridgeRootPath(), 'server.mjs');
  }

  public getExtensionRootPath(): string {
    return this.context.extensionPath;
  }

  public getBundledCodexRelativePath(): string {
    const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    return path.join('bundled-runtime', `${process.platform}-${process.arch}`, executableName);
  }

  public getBundledCodexPath(): string {
    return path.join(this.getExtensionRootPath(), this.getBundledCodexRelativePath());
  }

  public async pathExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fsConstants.F_OK);
      return true;
    } catch (_error) {
      return false;
    }
  }

  public async resolveLocalCodexRuntime(): Promise<{ command: string; source: string }> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    const overridePath = config.get<string>('localCodexPath', '').trim();

    if (overridePath !== '') {
      if (await this.pathExists(overridePath)) {
        return { command: overridePath, source: 'configured override' };
      }

      throw new Error(`Configured local Codex path does not exist: ${overridePath}`);
    }

    const bundledPath = this.getBundledCodexPath();
    if (await this.pathExists(bundledPath)) {
      return {
        command: bundledPath,
        source: `bundled runtime (${process.platform}-${process.arch})`,
      };
    }

    return { command: 'codex', source: 'system PATH' };
  }

  public async getIsolatedCodexHomePath(): Promise<string> {
    const codexHomePath = path.join(this.context.globalStorageUri.fsPath, 'codex-home');
    await mkdir(codexHomePath, { recursive: true });
    return codexHomePath;
  }

  public getBaseUrlInfo(): URL {
    return new URL(this.getBaseUrl());
  }

  public isLocalBaseUrl(): boolean {
    try {
      const url = this.getBaseUrlInfo();
      return ['localhost', '127.0.0.1'].includes(url.hostname);
    } catch (_error) {
      return false;
    }
  }

  public shouldManageLocalBridge(): boolean {
    const config = vscode.workspace.getConfiguration('codexBridge');
    return config.get<boolean>('autoStartLocalBridge', true) && this.isLocalBaseUrl();
  }

  public isStatusBarButtonEnabled(): boolean {
    return vscode.workspace.getConfiguration('codexBridge').get<boolean>('showStatusBarButton', true);
  }

  public getLocalBridgePort(): string {
    const url = this.getBaseUrlInfo();
    if (url.port) {
      return url.port;
    }

    return url.protocol === 'https:' ? '443' : '80';
  }

  public async getRuntimeConfigPayload(options?: { modelOverride?: string }): Promise<RuntimeConfigPayload> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    const runtimeProvider = config.get<RuntimeProvider>('runtimeProvider', 'openai');
    const configuredWorkspaceRoot = config.get<string>('workspaceRoot', '').trim();
    const activeDocumentUri = vscode.window.activeTextEditor?.document?.uri;
    const activeWorkspaceFolder = activeDocumentUri ? vscode.workspace.getWorkspaceFolder(activeDocumentUri) : undefined;
    const workspaceRoot = activeWorkspaceFolder?.uri.fsPath
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || configuredWorkspaceRoot
      || '';
    const configuredBaseUrl = config.get<string>('providerApiBaseUrl', '');
    let authMode = config.get<AuthMode>('authMode', 'chatgpt');
    let providerApiKey = await this.getProviderApiKey();
    let providerApiBaseUrl = configuredBaseUrl;

    if (runtimeProvider === 'osirus') {
      providerApiKey = await this.getValidOsirusAccessToken();
      providerApiBaseUrl = normalizeOsirusCompatBaseUrl(configuredBaseUrl) || this.getOsirusCompatApiBaseUrl();
      authMode = providerApiKey.trim() ? 'api_key' : 'none';
    }

    return {
      runtime_provider: runtimeProvider,
      auth_mode: authMode,
      provider_api_base_url: providerApiBaseUrl,
      provider_api_key: providerApiKey,
      default_model: String(options?.modelOverride || config.get<string>('defaultModel', '') || '').trim(),
      workspace_root: workspaceRoot,
    };
  }
}
