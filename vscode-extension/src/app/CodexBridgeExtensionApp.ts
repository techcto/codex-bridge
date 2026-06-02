import * as vscode from 'vscode';
import {
  resolveCompletedLocalMessages,
  resolveCompletedLocalMessagesFromStream,
} from '../chat/completedTurn';
import {
  deriveThreadTitle,
  mapBridgeSessionMessagesToLocal,
  mapOsirusHistoryToLocal,
  reconcileOsirusMessages,
  resolveSelectedOsirusModelIdFromHistory,
  sanitizeLocalChatMessage,
  sanitizeLocalChatThread,
  summarizeThreadFromMessages,
} from '../chat/localThreads';
import {
  getProviderBaseUrlHint,
  getProviderDisplayName,
  getProviderIcon,
  getProviderSetupSummary,
  normalizeOsirusCompatBaseUrl,
  providerNeedsSavedApiKey,
} from '../providers';
import { resolveAgentRuntimeCapability } from '../agentCapabilities';
import { escapeHtml } from '../ui/html';
import { CodexBridgeSidebarProvider } from '../ui/sidebarViewProvider';
import { BridgeHttpClient } from '../services/BridgeHttpClient';
import { BridgeRuntimeService } from '../services/BridgeRuntimeService';
import { ConnectionConfigurationService } from '../services/ConnectionConfigurationService';
import { LocalThreadStore } from '../services/LocalThreadStore';
import { OsirusSessionService } from '../services/OsirusSessionService';
import { OsirusChatService } from '../services/OsirusChatService';
import { BridgeSessionService } from '../services/BridgeSessionService';
import { ChatPanelStateService } from '../services/ChatPanelStateService';
import { ChatPanelController } from '../controllers/ChatPanelController';
import { ExtensionHostService } from '../services/ExtensionHostService';
import { ExtensionUiService } from '../services/ExtensionUiService';
import { ChatPanelHostService } from '../services/ChatPanelHostService';
import type {
  AuthMode,
  BridgeSessionRecord,
  BridgeSessionResponse,
  ChatPanelThreadSummary,
  LocalChatMessage,
  LocalChatThread,
  OsirusActiveOrgResponse,
  OsirusChatHistoryMessage,
  OsirusChatSnapshot,
  OsirusModelOption,
  OsirusOrgMembership,
  RequestJsonOptions,
  RuntimeConfigPayload,
  RuntimeProvider,
  SessionCreateResponse,
  WebviewAttachment,
} from '../types';

const PROVIDER_API_KEY_SECRET_KEY = 'codexBridge.providerApiKey';
const OSIRUS_ACCESS_TOKEN_SECRET_KEY = 'codexBridge.osirus.accessToken';
const OSIRUS_REFRESH_TOKEN_SECRET_KEY = 'codexBridge.osirus.refreshToken';
const OSIRUS_SELECTED_MODEL_SECRET_KEY = 'codexBridge.osirus.selectedModel';
const OSIRUS_EMAIL_SECRET_KEY = 'codexBridge.osirus.email';
const OSIRUS_PASSWORD_SECRET_KEY = 'codexBridge.osirus.password';

let bridgeOutputChannel: vscode.OutputChannel | undefined;
let bridgeContext: vscode.ExtensionContext | undefined;
let bridgeStatusBarItem: vscode.StatusBarItem | undefined;
let sidebarProvider: CodexBridgeSidebarProvider | undefined;
let bridgeHttpClient: BridgeHttpClient | undefined;
let bridgeRuntimeService: BridgeRuntimeService | undefined;
let connectionConfigurationService: ConnectionConfigurationService | undefined;
let localThreadStore: LocalThreadStore | undefined;
let osirusSessionService: OsirusSessionService | undefined;
let osirusChatService: OsirusChatService | undefined;
let bridgeSessionService: BridgeSessionService | undefined;
let chatPanelStateService: ChatPanelStateService | undefined;
let chatPanelController: ChatPanelController | undefined;
let extensionHostService: ExtensionHostService | undefined;
let extensionUiService: ExtensionUiService | undefined;
let chatPanelHostService: ChatPanelHostService | undefined;

const OSIRUS_ACTIVE_ORG_ID_STATE_KEY = 'codexBridge.osirus.activeOrgId';
const OSIRUS_ACTIVE_ORG_NAME_STATE_KEY = 'codexBridge.osirus.activeOrgName';
const CHAT_THREADS_GLOBAL_STATE_KEY = 'codexBridge.chatThreads';
const ACTIVE_THREAD_STATE_KEY_PREFIX = 'codexBridge.activeThread';
const MAX_STORED_THREADS = 60;

function activateApp(context: vscode.ExtensionContext): void {
  bridgeContext = context;
  bridgeOutputChannel = vscode.window.createOutputChannel('Codex Bridge');
  bridgeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bridgeStatusBarItem.command = 'codexBridge.openChat';
  extensionHostService = new ExtensionHostService({
    context,
    getProviderApiKey,
    getValidOsirusAccessToken,
    outputChannel: bridgeOutputChannel,
    refreshSidebar,
  });
  bridgeHttpClient = new BridgeHttpClient({
    getBaseUrl,
    outputChannel: bridgeOutputChannel,
  });
  bridgeRuntimeService = new BridgeRuntimeService({
    getBaseUrl,
    getBaseUrlInfo,
    getBridgeRootPath,
    getBridgeServerPath,
    getErrorMessage,
    getIsolatedCodexHomePath,
    getLocalBridgePort,
    getRuntimeConfigPayload,
    isLocalBaseUrl,
    onSessionReset: async () => {
      if (bridgeContext) {
        await bridgeContext.workspaceState.update('codexBridge.sessionId', undefined);
      }
    },
    outputChannel: bridgeOutputChannel,
    refreshSidebar,
    requestJson: async <T>(method: string, path: string, body?: unknown, options?: RequestJsonOptions) =>
      requestJson<T>(method, path, body, options),
    resolveLocalCodexRuntime,
    shouldManageLocalBridge,
    updateStatusBar,
  });
  connectionConfigurationService = new ConnectionConfigurationService({
    ensureLocalBridgeRunning,
    getProviderApiKey,
    pushRuntimeConfig,
    refreshSidebar,
    setProviderApiKey,
    shouldManageLocalBridge,
  });
  localThreadStore = new LocalThreadStore({
    context,
    getStoredOsirusActiveOrgId,
    normalizeRole: normalizeOsirusHistoryRole,
  });
  osirusSessionService = new OsirusSessionService({
    context,
    outputChannel: bridgeOutputChannel,
    getAccountApiBaseUrl: getOsirusAccountApiBaseUrl,
    getErrorMessage,
    requestExternalJson,
    refreshSidebar,
    pushChatPanelState: async () => {
      if (bridgeContext) {
        await pushChatPanelState(bridgeContext);
      }
    },
    setProviderApiKey,
    clearOpenChatState: async () => {
      await setStoredOpenOsirusChatId(undefined);
    },
  });
  osirusChatService = new OsirusChatService({
    ensureActiveOrgSelection: async (options) => ensureOsirusActiveOrgSelection(options),
    getAccountApiBaseUrl: getOsirusAccountApiBaseUrl,
    getErrorMessage,
    getStoredActiveOrgId: getStoredOsirusActiveOrgId,
    getValidAccessToken: getValidOsirusAccessToken,
    getSavedSelectedModelId: getSavedOsirusSelectedModelId,
    outputChannel: bridgeOutputChannel,
    requestOsirusJson,
    setSavedSelectedModelId: setSavedOsirusSelectedModelId,
  });
  bridgeSessionService = new BridgeSessionService({
    getBaseUrl,
    getErrorMessage,
    outputChannel: bridgeOutputChannel,
    requestJson,
    delay,
  });
  chatPanelStateService = new ChatPanelStateService({
    buildChatContext,
    createLocalChatThread,
    createLocalId,
    fetchOsirusChatSnapshot,
    fetchOsirusModelOptions,
    getBaseUrl,
    getCurrentProviderWorkspaceThreads,
    getErrorMessage,
    getOrCreateActiveThread,
    getSavedOsirusSelectedModelId,
    getStoredChatThreads,
    getStoredOpenOsirusChatId,
    getStoredOsirusActiveOrgId,
    getStoredOsirusActiveOrgName,
    getThreadScopeKey,
    hasOsirusAccountSession,
    normalizeRole: normalizeOsirusHistoryRole,
    outputChannel: bridgeOutputChannel,
    preferOsirusProductOption,
    runtimeProvider: getCurrentRuntimeProvider,
    setActiveThreadIdForProvider,
    setStoredOpenOsirusChatId,
    updateStoredThreadMessages,
  });
  chatPanelController = new ChatPanelController({
    buildChatContext,
    createLocalChatThread,
    createLocalId,
    extractSessionId,
    fetchOsirusChatSnapshot,
    fetchOsirusModelOptions,
    getCurrentRuntimeProvider,
    getErrorMessage,
    getOrCreateActiveThread,
    getOsirusModelContext,
    getStoredChatThread,
    getStoredOpenOsirusChatId,
    getValidOsirusAccessToken,
    normalizeRole: normalizeOsirusHistoryRole,
    outputChannel: bridgeOutputChannel,
    panelStateService: chatPanelStateService,
    pushRuntimeConfig,
    requestJson,
    setActiveThreadIdForProvider,
    setStoredOpenOsirusChatId,
    streamBridgeSession,
    updateStoredThreadMessages,
    appendStoredThreadMessage,
  });
  extensionUiService = new ExtensionUiService({
    ensureLocalBridgeRunning,
    getBaseUrl,
    getBridgeState,
    getCurrentAuthMode,
    getCurrentRuntimeProvider,
    getErrorMessage,
    getLocalRuntimeSummary,
    getOsirusApiKeysUrl,
    getStoredOsirusActiveOrgId,
    getStoredOsirusActiveOrgName,
    hasOsirusAccountSession,
    hasSavedApiKey,
    isLocalBaseUrl,
    isStatusBarButtonEnabled,
    outputChannel: bridgeOutputChannel,
    pushRuntimeConfig,
    refreshSidebar,
    requestJson,
    resolveLocalCodexRuntime,
    shouldManageLocalBridge,
    statusBarItem: bridgeStatusBarItem,
  });
  chatPanelHostService = new ChatPanelHostService({
    context,
    controller: chatPanelController,
    ensureLocalBridgeRunning,
    getBaseUrl,
    getCurrentRuntimeProvider,
    getErrorMessage,
    outputChannel: bridgeOutputChannel,
    pushPanelState: async () => {
      await pushChatPanelState(context);
    },
    refreshSidebar,
  });
  sidebarProvider = new CodexBridgeSidebarProvider({
    buildState: async () => buildSidebarState(context),
    checkHealth,
    configureConnection,
    controller: chatPanelController,
    getCurrentRuntimeProvider,
    getOsirusApiKeysUrl,
    getOsirusSignupUrl,
    loginToOsirus,
    loginToOsirusAccount,
    logoutFromOsirus,
    logoutFromOsirusAccount,
    openExternal: vscode.env.openExternal,
    outputChannel: bridgeOutputChannel,
    refreshOpenOsirusChatState: async () => {
      await refreshOpenOsirusChatState(context);
    },
    renderHtml: getSidebarHtml,
    setProviderApiKey,
    showInfo: vscode.window.showInformationMessage,
    showLogs: () => {
      bridgeOutputChannel?.show(true);
    },
    switchOsirusOrg: async () => ensureOsirusActiveOrgSelection({ promptUser: true }),
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexBridge.sidebar', sidebarProvider),
    vscode.commands.registerCommand('codexBridge.configure', async () => {
      await configureConnection();
    }),
    vscode.commands.registerCommand('codexBridge.checkHealth', async () => {
      await checkHealth();
    }),
    vscode.commands.registerCommand('codexBridge.openChat', async () => {
      if (getCurrentRuntimeProvider() !== 'osirus') {
        await ensureLocalBridgeRunning();
      }
      sidebarProvider?.focus();
      await pushChatPanelState(context);
    }),
    vscode.commands.registerCommand('codexBridge.startLocalBridge', async () => {
      await startLocalBridge(true);
    }),
    vscode.commands.registerCommand('codexBridge.stopLocalBridge', async () => {
      await stopLocalBridge(true);
    }),
    vscode.commands.registerCommand('codexBridge.restartLocalBridge', async () => {
      await restartLocalBridge();
    }),
    vscode.commands.registerCommand('codexBridge.showBridgeLogs', async () => {
      bridgeOutputChannel?.show(true);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshSidebar();
      void pushChatPanelState(context);
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      refreshSidebar();
      void pushChatPanelState(context);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshSidebar();
      void pushChatPanelState(context);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexBridge.workspaceRoot')) {
        refreshSidebar();
        void pushChatPanelState(context);
      }
    })
  );

  context.subscriptions.push(
    bridgeOutputChannel,
    bridgeStatusBarItem,
    new vscode.Disposable(() => {
      void bridgeRuntimeService?.stop(false);
    })
  );

  updateStatusBar('idle');
  refreshSidebar();
  void migrateLegacyOsirusProvider();
  void migrateLegacyProviderApiKey();
  void initializeExtension();
}

function deactivateApp(): void {
  void bridgeRuntimeService?.stop(false);
}

export class CodexBridgeExtensionApp {
  public activate(context: vscode.ExtensionContext): void {
    activateApp(context);
  }

  public deactivate(): void {
    deactivateApp();
  }
}

async function loginToOsirus(): Promise<void> {
  if (!extensionUiService) {
    throw new Error('Extension UI service is not ready.');
  }
  await extensionUiService.loginToOsirus(getProviderApiKey, setProviderApiKey);
}

async function loginToOsirusAccount(): Promise<void> {
  await loginToOsirusAccountViaBrowser();
}

async function loginToOsirusAccountViaBrowser(): Promise<void> {
  if (!osirusSessionService) {
    throw new Error('Osirus session service is not ready.');
  }
  await osirusSessionService.loginWithBrowser();
}

async function loginToOsirusAccountWithPassword(): Promise<void> {
  if (!osirusSessionService) {
    throw new Error('Osirus session service is not ready.');
  }
  await osirusSessionService.loginWithPassword();
}

async function logoutFromOsirus(): Promise<void> {
  if (!extensionUiService) {
    throw new Error('Extension UI service is not ready.');
  }
  await extensionUiService.logoutFromOsirus(setProviderApiKey, async () => {
    if (bridgeContext) {
      await bridgeContext.workspaceState.update('codexBridge.sessionId', undefined);
    }
  });
}

async function logoutFromOsirusAccount(): Promise<void> {
  if (!osirusSessionService) {
    throw new Error('Osirus session service is not ready.');
  }
  await osirusSessionService.logout();
}

async function configureConnection(): Promise<void> {
  if (!connectionConfigurationService) {
    throw new Error('Codex Bridge connection configurator is not ready.');
  }

  await connectionConfigurationService.configure();
}

async function checkHealth(): Promise<void> {
  if (!extensionUiService) {
    throw new Error('Extension UI service is not ready.');
  }
  await extensionUiService.checkHealth();
}

function getBaseUrl(): string {
  if (!extensionHostService) {
    return vscode.workspace.getConfiguration('codexBridge').get<string>('baseUrl', 'http://127.0.0.1:4400').replace(/\/+$/, '');
  }
  return extensionHostService.getBaseUrl();
}

function getOsirusSignupUrl(): string {
  return extensionHostService?.getOsirusSignupUrl() || 'https://osirus.ai/signup';
}

function getOsirusApiKeysUrl(): string {
  return extensionHostService?.getOsirusApiKeysUrl() || 'https://osirus.ai/api-keys';
}

function getCurrentRuntimeProvider(): RuntimeProvider {
  return extensionHostService?.getCurrentRuntimeProvider() || 'openai';
}

async function migrateLegacyOsirusProvider(): Promise<void> {
  await extensionHostService?.migrateLegacyOsirusProvider();
}

function getCurrentAuthMode(): AuthMode {
  return extensionHostService?.getCurrentAuthMode() || 'chatgpt';
}

function getConfiguredProviderApiBaseUrl(): string {
  return extensionHostService?.getConfiguredProviderApiBaseUrl() || '';
}

function getOsirusAccountApiBaseUrl(): string {
  return extensionHostService?.getOsirusAccountApiBaseUrl() || 'https://osirus.ai/api';
}

function getOsirusCompatApiBaseUrl(): string {
  return extensionHostService?.getOsirusCompatApiBaseUrl() || normalizeOsirusCompatBaseUrl(getOsirusAccountApiBaseUrl());
}

function isValidAbsoluteUrl(value: string): boolean {
  return extensionHostService?.isValidAbsoluteUrl(value) || false;
}

async function initializeExtension(): Promise<void> {
  if (!extensionUiService) {
    throw new Error('Extension UI service is not ready.');
  }
  await extensionUiService.initialize();
}

function getBridgeRootPath(): string {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.getBridgeRootPath();
}

function getBridgeServerPath(): string {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.getBridgeServerPath();
}

function getExtensionRootPath(): string {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.getExtensionRootPath();
}

function getBundledCodexRelativePath(): string {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.getBundledCodexRelativePath();
}

function getBundledCodexPath(): string {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.getBundledCodexPath();
}

async function pathExists(filePath: string): Promise<boolean> {
  return extensionHostService?.pathExists(filePath) || false;
}

async function resolveLocalCodexRuntime(): Promise<{ command: string; source: string }> {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.resolveLocalCodexRuntime();
}

async function getIsolatedCodexHomePath(): Promise<string> {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.getIsolatedCodexHomePath();
}

function getBaseUrlInfo(): URL {
  if (!extensionHostService) {
    return new URL(getBaseUrl());
  }
  return extensionHostService.getBaseUrlInfo();
}

function isLocalBaseUrl(): boolean {
  return extensionHostService?.isLocalBaseUrl() || false;
}

function shouldManageLocalBridge(): boolean {
  return extensionHostService?.shouldManageLocalBridge() || false;
}

function isStatusBarButtonEnabled(): boolean {
  return extensionHostService?.isStatusBarButtonEnabled() ?? true;
}

function getLocalBridgePort(): string {
  if (!extensionHostService) {
    const url = getBaseUrlInfo();
    if (url.port) {
      return url.port;
    }
    return url.protocol === 'https:' ? '443' : '80';
  }
  return extensionHostService.getLocalBridgePort();
}

async function getRuntimeConfigPayload(options?: { modelOverride?: string }): Promise<RuntimeConfigPayload> {
  if (!extensionHostService) {
    throw new Error('Extension host service is not ready.');
  }
  return extensionHostService.getRuntimeConfigPayload(options);
}

async function hasSavedApiKey(): Promise<boolean> {
  return (await getProviderApiKey()).trim() !== '';
}

async function hasOsirusAccountSession(): Promise<boolean> {
  return osirusSessionService?.hasAccountSession() || false;
}

async function getSavedOsirusSelectedModelId(): Promise<string> {
  return osirusSessionService?.getSavedSelectedModelId() || '';
}

async function setSavedOsirusSelectedModelId(value: string): Promise<void> {
  await osirusSessionService?.setSavedSelectedModelId(value);
}

function getOsirusOrgLabel(membership: OsirusOrgMembership): string {
  return String(membership.org?.name || membership.org?.slug || membership.orgId || membership.id || '').trim();
}

async function getStoredOsirusActiveOrgId(): Promise<string> {
  return osirusSessionService?.getStoredActiveOrgId() || '';
}

async function getStoredOsirusActiveOrgName(): Promise<string> {
  return osirusSessionService?.getStoredActiveOrgName() || '';
}

async function clearStoredOsirusActiveOrg(): Promise<void> {
  await osirusSessionService?.clearStoredActiveOrg();
}

function createLocalId(prefix: string): string {
  if (!localThreadStore) {
    throw new Error('Local thread store is not ready.');
  }
  return localThreadStore.createLocalId(prefix);
}

function getWorkspaceFingerprint(): string {
  if (!localThreadStore) {
    const folders = vscode.workspace.workspaceFolders || [];
    const roots = folders.map((folder) => folder.uri.toString()).sort();
    if (roots.length > 0) {
      return roots.join('|');
    }
    return `single:${vscode.workspace.name || 'workspace'}:${vscode.env.remoteName || 'local'}`;
  }
  return localThreadStore.getWorkspaceFingerprint();
}

async function getThreadScopeKey(provider: RuntimeProvider): Promise<string> {
  if (!localThreadStore) {
    if (provider === 'osirus') {
      const orgId = await getStoredOsirusActiveOrgId();
      return `${getWorkspaceFingerprint()}::org:${orgId || 'none'}`;
    }
    return getWorkspaceFingerprint();
  }
  return localThreadStore.getThreadScopeKey(provider);
}

async function getStoredChatThreads(): Promise<LocalChatThread[]> {
  if (!localThreadStore) {
    return [];
  }
  return localThreadStore.getStoredChatThreads();
}

async function getStoredChatThread(threadId: string): Promise<LocalChatThread | undefined> {
  return localThreadStore?.getStoredChatThread(threadId);
}

function getCurrentProviderWorkspaceThreads(threads: LocalChatThread[], provider: RuntimeProvider): LocalChatThread[] {
  return localThreadStore
    ? localThreadStore.getCurrentProviderWorkspaceThreads(threads, provider)
    : threads.filter((thread) => thread.provider === provider);
}

async function getActiveThreadIdForProvider(provider: RuntimeProvider): Promise<string> {
  if (!localThreadStore) {
    return '';
  }
  return localThreadStore.getActiveThreadIdForProvider(provider);
}

async function setActiveThreadIdForProvider(provider: RuntimeProvider, threadId?: string): Promise<void> {
  await localThreadStore?.setActiveThreadIdForProvider(provider, threadId);
}

async function getStoredOpenOsirusChatId(): Promise<string> {
  if (!localThreadStore) {
    return '';
  }
  return localThreadStore.getStoredOpenOsirusChatId();
}

async function setStoredOpenOsirusChatId(chatId?: string): Promise<void> {
  await localThreadStore?.setStoredOpenOsirusChatId(chatId);
}

async function createLocalChatThread(provider: RuntimeProvider, seed?: Partial<LocalChatThread>): Promise<LocalChatThread> {
  if (!localThreadStore) {
    throw new Error('Local thread store is not ready.');
  }
  return localThreadStore.createLocalChatThread(provider, seed);
}

async function getOrCreateActiveThread(provider: RuntimeProvider): Promise<LocalChatThread> {
  if (!localThreadStore) {
    throw new Error('Local thread store is not ready.');
  }
  return localThreadStore.getOrCreateActiveThread(provider);
}

async function updateStoredThreadMessages(
  threadId: string,
  messages: LocalChatMessage[],
  patch?: Partial<LocalChatThread>
): Promise<LocalChatThread> {
  if (!localThreadStore) {
    throw new Error('Local thread store is not ready.');
  }
  return localThreadStore.updateStoredThreadMessages(threadId, messages, patch);
}

async function appendStoredThreadMessage(
  threadId: string,
  message: LocalChatMessage,
  patch?: Partial<LocalChatThread>
): Promise<LocalChatThread> {
  if (!localThreadStore) {
    throw new Error('Local thread store is not ready.');
  }
  return localThreadStore.appendStoredThreadMessage(threadId, message, patch);
}

function preferOsirusProductOption(
  selected: OsirusModelOption,
  options: OsirusModelOption[]
): OsirusModelOption {
  if (selected.kind === 'product') {
    return selected;
  }

  const selectedSlug = String(selected.modelSlug || selected.modelId || '').trim().toLowerCase();
  const selectedProvider = String(selected.providerKey || '').trim().toLowerCase();
  if (!selectedSlug) {
    return selected;
  }

  const productMatch = options.find((option) =>
    option.kind === 'product' &&
    String(option.modelSlug || '').trim().toLowerCase() === selectedSlug &&
    (!selectedProvider || String(option.providerKey || '').trim().toLowerCase() === selectedProvider)
  );

  return productMatch || selected;
}

function getOsirusModelContext(option: OsirusModelOption | null | undefined): Record<string, unknown> | undefined {
  return osirusChatService?.getModelContext(option);
}

function formatThreadTime(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(value));
  } catch (error) {
    return '';
  }
}

async function buildChatPanelState(context: vscode.ExtensionContext): Promise<Record<string, unknown>> {
  void context;
  if (!chatPanelStateService) {
    throw new Error('Chat panel state service is not ready.');
  }
  return chatPanelStateService.buildState();
}

async function buildSidebarState(context: vscode.ExtensionContext): Promise<Record<string, unknown>> {
  if (!extensionUiService) {
    throw new Error('Extension UI service is not ready.');
  }
  return {
    ...await extensionUiService.getSidebarViewState(),
    ...await buildChatPanelState(context),
  };
}

async function pushChatPanelState(context: vscode.ExtensionContext): Promise<void> {
  const payload = await buildSidebarState(context);
  await sidebarProvider?.pushState(payload);
  if (chatPanelHostService?.hasOpenPanel()) {
    await chatPanelHostService.pushState(await buildChatPanelState(context));
  }
}

async function ensureOsirusActiveOrgSelection(options?: {
  promptUser?: boolean;
  tokenOverride?: string;
  preferredOrgId?: string | null;
  validateServerActiveOrg?: boolean;
}): Promise<{ orgId: string; orgName: string }> {
  if (!osirusSessionService) {
    throw new Error('Osirus session service is not ready.');
  }
  const previousOrgId = await getStoredOsirusActiveOrgId();
  const result = await osirusSessionService.ensureActiveOrgSelection(options);
  if (osirusChatService && result.orgId && result.orgId !== previousOrgId) {
    osirusChatService.clearModelOptionsCache();
  }
  return result;
}

async function refreshOpenOsirusChatState(context: vscode.ExtensionContext): Promise<void> {
  if (getCurrentRuntimeProvider() !== 'osirus' || !(await hasOsirusAccountSession())) {
    return;
  }
  await pushChatPanelState(context);
}

async function getValidOsirusAccessToken(): Promise<string> {
  if (!osirusSessionService) {
    throw new Error('Osirus session service is not ready.');
  }
  return osirusSessionService.getValidAccessToken();
}

async function requestOsirusJson<T>(
  method: string,
  path: string,
  body?: BodyInit | Record<string, unknown>,
  init?: { headers?: Record<string, string> }
): Promise<T> {
  if (!osirusSessionService) {
    throw new Error('Osirus session service is not ready.');
  }
  return osirusSessionService.requestJson<T>(method, path, body, init);
}

async function fetchOsirusModelOptions(): Promise<OsirusModelOption[]> {
  if (!osirusChatService) {
    throw new Error('Osirus services are not ready.');
  }
  return osirusChatService.fetchModelOptions();
}

function normalizeOsirusHistoryRole(value: unknown): 'user' | 'assistant' | 'system' | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'user' || normalized === 'assistant' || normalized === 'system') {
    return normalized;
  }
  return null;
}

async function fetchOsirusChatSnapshot(chatId: string): Promise<OsirusChatSnapshot> {
  if (!osirusChatService) {
    throw new Error('Osirus chat service is not ready.');
  }
  return osirusChatService.fetchChatSnapshot(chatId);
}

async function ensureLocalBridgeRunning(): Promise<void> {
  if (!bridgeRuntimeService) {
    throw new Error('Codex Bridge runtime service is not ready.');
  }

  await bridgeRuntimeService.ensureRunning();
}

async function startLocalBridge(showMessage: boolean): Promise<boolean> {
  if (!bridgeRuntimeService) {
    throw new Error('Codex Bridge runtime service is not ready.');
  }

  return bridgeRuntimeService.start(showMessage);
}

async function stopLocalBridge(showMessage: boolean): Promise<void> {
  await bridgeRuntimeService?.stop(showMessage);
}

async function restartLocalBridge(): Promise<void> {
  if (!bridgeRuntimeService) {
    throw new Error('Codex Bridge runtime service is not ready.');
  }

  await bridgeRuntimeService.restart();
}

async function waitForBridgeReady(timeoutMs = 12000): Promise<void> {
  if (!bridgeRuntimeService) {
    throw new Error('Codex Bridge runtime service is not ready.');
  }

  await bridgeRuntimeService.waitForReady(timeoutMs);
}

async function pushRuntimeConfig(options?: { suppressErrors?: boolean; modelOverride?: string }): Promise<boolean> {
  if (!bridgeRuntimeService) {
    throw new Error('Codex Bridge runtime service is not ready.');
  }

  return bridgeRuntimeService.pushRuntimeConfig(options);
}

async function streamBridgeSession(
  sessionId: string,
  options?: {
    onAssistantStart?: () => void;
    onAssistantDelta?: (delta: string) => void;
    onApprovalChange?: (approval: BridgeSessionRecord['pending_approval']) => void;
  }
): Promise<{ session: BridgeSessionRecord; assistantText: string }> {
  if (!bridgeSessionService) {
    throw new Error('Bridge session service is not ready.');
  }
  return bridgeSessionService.streamSession(sessionId, options);
}

function buildChatContext(options?: { chatId?: string; selectedModel?: Record<string, unknown>; includeContent?: boolean }): Record<string, unknown> {
  const activeEditor = vscode.window.activeTextEditor;
  const document = activeEditor?.document;
  const chatId = String(options?.chatId || '').trim();
  const includeContent = options?.includeContent !== false;
  const documentText = includeContent && document ? document.getText() : '';
  const scope = document ? 'editor' : 'workspace';
  const workspaceRoot = getConfiguredWorkspaceRoot();
  const runtimeProvider = getCurrentRuntimeProvider();
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
    uri: folder.uri.toString(),
  }));
  const openTabs = collectOpenTabs();
  const agentRuntime = resolveAgentRuntimeCapability(runtimeProvider, options?.selectedModel || null);

  return {
    source: 'vscode',
    scope,
    runtime_provider: runtimeProvider,
    workspace_root: workspaceRoot,
    workspace_name: vscode.workspace.name || 'Workspace',
    workspace_folders: workspaceFolders,
    chat_id: chatId,
    osirus_chat_id: chatId,
    selected_model: options?.selectedModel || null,
    agent_runtime: {
      contract: agentRuntime.contract,
      execution_class: agentRuntime.executionClass,
      readiness: agentRuntime.readiness,
      supports_workspace_actions: agentRuntime.supportsWorkspaceActions,
      supports_direct_file_edits: agentRuntime.supportsDirectFileEdits,
      supports_command_execution: agentRuntime.supportsCommandExecution,
      supports_git_inspection: agentRuntime.supportsGitInspection,
      requires_verified_tool_results: agentRuntime.requiresVerifiedToolResults,
      provider: agentRuntime.provider,
      selected_model_label: agentRuntime.selectedModelLabel,
      selected_model_id: agentRuntime.selectedModelId,
      conversation_mode: agentRuntime.conversationMode,
      summary: agentRuntime.summary,
    },
    current_entity: {
      type: document ? 'file' : 'workspace',
      name: document ? vscode.workspace.asRelativePath(document.uri) : (vscode.workspace.name || 'Workspace'),
      path: document?.uri.fsPath || '',
      language: document?.languageId || '',
      content: documentText,
    },
    active_editor: {
      title: document ? vscode.workspace.asRelativePath(document.uri) : '',
      path: document?.uri.fsPath || '',
      route: document ? vscode.workspace.asRelativePath(document.uri) : '',
      content: documentText,
    },
    open_tabs: openTabs,
  };
}

function getConfiguredWorkspaceRoot(): string {
  const configuredRoot = vscode.workspace.getConfiguration('codexBridge').get<string>('workspaceRoot', '').trim();
  const activeDocumentUri = vscode.window.activeTextEditor?.document?.uri;
  const activeWorkspaceFolder = activeDocumentUri ? vscode.workspace.getWorkspaceFolder(activeDocumentUri) : undefined;
  if (activeWorkspaceFolder?.uri.fsPath) {
    return activeWorkspaceFolder.uri.fsPath;
  }

  const firstWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  if (firstWorkspaceFolder) {
    return firstWorkspaceFolder;
  }

  if (configuredRoot) {
    return configuredRoot;
  }

  return '';
}

function collectOpenTabs(): Array<Record<string, string>> {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs
      .map((tab) => normalizeTabContext(tab))
      .filter((tab): tab is Record<string, string> => Boolean(tab))
  );
}

function normalizeTabContext(tab: vscode.Tab): Record<string, string> | null {
  const input = tab.input;

  if (input instanceof vscode.TabInputText) {
    return buildTabRecord(tab.label, input.uri);
  }

  if (input instanceof vscode.TabInputTextDiff) {
    return {
      title: tab.label,
      name: tab.label,
      path: input.modified.fsPath,
      route: input.modified.toString(),
      kind: 'diff',
    };
  }

  if (input instanceof vscode.TabInputNotebook) {
    return buildTabRecord(tab.label, input.uri, 'notebook');
  }

  return null;
}

function buildTabRecord(label: string, uri: vscode.Uri, kind = 'file'): Record<string, string> {
  const relativePath = vscode.workspace.asRelativePath(uri, false);
  return {
    title: label || relativePath || uri.fsPath || uri.toString(),
    name: relativePath || label || uri.fsPath || uri.toString(),
    path: uri.fsPath || '',
    route: relativePath || uri.fsPath || uri.toString(),
    kind,
  };
}

async function requestJson<T>(method: string, path: string, body?: unknown, options?: RequestJsonOptions): Promise<T> {
  if (!bridgeHttpClient) {
    throw new Error('Codex Bridge HTTP client is not ready.');
  }

  return bridgeHttpClient.requestJson<T>(method, path, body, options);
}

async function requestExternalJson<T>(
  method: string,
  url: string,
  body?: BodyInit | unknown,
  headers?: Record<string, string>
): Promise<T> {
  if (!bridgeHttpClient) {
    throw new Error('Codex Bridge HTTP client is not ready.');
  }

  return bridgeHttpClient.requestExternalJson<T>(method, url, body, headers);
}

async function getProviderApiKey(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }

  return (await bridgeContext.secrets.get(PROVIDER_API_KEY_SECRET_KEY)) || '';
}

async function setProviderApiKey(value: string): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    await bridgeContext.secrets.delete(PROVIDER_API_KEY_SECRET_KEY);
  } else {
    await bridgeContext.secrets.store(PROVIDER_API_KEY_SECRET_KEY, trimmed);
  }

  await clearLegacyProviderApiKeySetting();
}

async function clearLegacyProviderApiKeySetting(): Promise<void> {
  const config = vscode.workspace.getConfiguration('codexBridge');
  const currentValue = config.get<string>('providerApiKey', '');
  if (currentValue.trim() === '') {
    return;
  }

  await config.update('providerApiKey', '', vscode.ConfigurationTarget.Global);
}

async function migrateLegacyProviderApiKey(): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  const config = vscode.workspace.getConfiguration('codexBridge');
  const legacyKey = config.get<string>('providerApiKey', '').trim();
  if (legacyKey === '') {
    return;
  }

  const existingSecret = await bridgeContext.secrets.get(PROVIDER_API_KEY_SECRET_KEY);
  if (!existingSecret) {
    await bridgeContext.secrets.store(PROVIDER_API_KEY_SECRET_KEY, legacyKey);
    bridgeOutputChannel?.appendLine('[bridge] migrated provider API key from settings.json to VS Code secret storage');
  }

  await config.update('providerApiKey', '', vscode.ConfigurationTarget.Global);
}

function extractSessionId(payload: unknown): string {
  return bridgeSessionService?.extractSessionId(payload) || '';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected Codex Bridge error.';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function updateStatusBar(state: 'idle' | 'starting' | 'ready' | 'stopped' | 'error'): void {
  extensionUiService?.updateStatusBar(state);
}

function refreshSidebar(): void {
  void sidebarProvider?.refresh();
}

function getBridgeState(): 'ready' | 'starting' | 'stopped' | 'remote' {
  return bridgeRuntimeService?.getState()
    || (isLocalBaseUrl() ? (shouldManageLocalBridge() ? 'starting' : 'stopped') : 'remote');
}

function getSidebarHtml(): string {
  if (!extensionUiService) {
    throw new Error('Extension UI service is not ready.');
  }
  return extensionUiService.getSidebarHtml();
}

async function getLocalRuntimeSummary(): Promise<string> {
  if (!isLocalBaseUrl()) {
    return 'Remote bridge';
  }

  try {
    const runtime = await resolveLocalCodexRuntime();
    return runtime.source;
  } catch (error) {
    return getErrorMessage(error);
  }
}
