import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { access, mkdir } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as net from 'net';
import * as path from 'path';

type RuntimeProvider = 'openai' | 'ollama' | 'vllm' | 'osirus' | 'osirus_agent' | 'openai_compatible';
type AuthMode = 'chatgpt' | 'api_key' | 'none';

type RuntimeConfigPayload = {
  runtime_provider: RuntimeProvider;
  auth_mode: AuthMode;
  provider_api_base_url: string;
  provider_api_key: string;
  default_model: string;
  workspace_root: string;
};

type SessionCreateResponse = {
  ok?: boolean;
  session_id?: string;
  id?: string;
  session?: {
    id?: string;
    session_id?: string;
  };
  data?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
};

type BridgeSessionRecord = {
  id?: string;
  status?: string;
  last_error?: string;
  messages?: Array<{
    role?: string;
    text?: string;
  }>;
};

type BridgeSessionResponse = {
  ok?: boolean;
  session?: BridgeSessionRecord;
  error?: string;
};

type BridgeHealthResponse = {
  ok?: boolean;
  auth_state?: string;
  runtime_kind?: string;
  runtime_config?: {
    runtime_provider?: string;
    auth_mode?: string;
    provider_api_base_url?: string;
    default_model?: string;
    workspace_root?: string;
  };
  error?: string;
};

type RequestJsonOptions = {
  suppressLog?: boolean;
  timeoutMs?: number;
};

type BridgeProbeResult = {
  baseUrl: string;
  host: string;
  port: number;
  socketReachable: boolean;
  healthOk: boolean;
  healthError?: string;
};

type OsirusModelOption = {
  id: string;
  label: string;
  kind: 'product' | 'provider';
  productId?: string;
  providerSettingId?: string;
  modelId?: string;
  modelSlug?: string;
  providerKey?: string;
  hasStream?: boolean;
  conversationMode?: 'voice' | 'chat' | 'search' | 'copilot' | 'agent';
  llmContent?: string;
  generationMode?: string;
  searchId?: string;
  recipients?: Array<Record<string, unknown>>;
};

type OsirusChatHistoryMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  productId?: string;
  providerSettingId?: string;
  modelId?: string;
  modelSlug?: string;
};

type OsirusChatSnapshot = {
  chatId: string;
  title: string;
  messages: OsirusChatHistoryMessage[];
};

type WebviewAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
  kind: 'image' | 'file';
};

type LocalChatMessageRole = 'user' | 'assistant' | 'system';

type LocalChatMessage = {
  id: string;
  role: LocalChatMessageRole;
  content: string;
  createdAt: number;
};

type LocalChatThread = {
  id: string;
  provider: RuntimeProvider;
  title: string;
  summary: string;
  workspaceFingerprint: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  osirusChatId?: string;
  selectedModelId?: string;
  messages: LocalChatMessage[];
};

type ChatPanelThreadSummary = {
  id: string;
  title: string;
  summary: string;
  updatedAt: number;
  provider: RuntimeProvider;
  active: boolean;
};

const PROVIDER_API_KEY_SECRET_KEY = 'codexBridge.providerApiKey';
const OSIRUS_ACCESS_TOKEN_SECRET_KEY = 'codexBridge.osirus.accessToken';
const OSIRUS_REFRESH_TOKEN_SECRET_KEY = 'codexBridge.osirus.refreshToken';
const OSIRUS_SELECTED_MODEL_SECRET_KEY = 'codexBridge.osirus.selectedModel';
const OSIRUS_EMAIL_SECRET_KEY = 'codexBridge.osirus.email';
const OSIRUS_PASSWORD_SECRET_KEY = 'codexBridge.osirus.password';

let chatPanel: vscode.WebviewPanel | undefined;
let bridgeProcess: ChildProcessWithoutNullStreams | undefined;
let bridgeOutputChannel: vscode.OutputChannel | undefined;
let bridgeContext: vscode.ExtensionContext | undefined;
let bridgeStatusBarItem: vscode.StatusBarItem | undefined;
let sidebarProvider: CodexBridgeSidebarProvider | undefined;

type OsirusMobileSignInResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  active_org_id?: string | null;
  user?: {
    id?: string;
    email?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
  };
};

type OsirusMobileRefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
};

type OsirusDeviceAuthStartResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

type OsirusDeviceAuthPollResponse = {
  status?: 'pending' | 'approved' | 'expired' | 'consumed';
  access_token?: string;
  refresh_token?: string;
  active_org_id?: string | null;
  active_org_name?: string | null;
};

type OsirusOrgMembership = {
  id: string;
  orgId: string;
  role?: string;
  org?: {
    id: string;
    name?: string;
    slug?: string;
  } | null;
};

type OsirusActiveOrgResponse = {
  org_id?: string | null;
  orgId?: string | null;
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
};

const OSIRUS_ACTIVE_ORG_ID_STATE_KEY = 'codexBridge.osirus.activeOrgId';
const OSIRUS_ACTIVE_ORG_NAME_STATE_KEY = 'codexBridge.osirus.activeOrgName';
const CHAT_THREADS_GLOBAL_STATE_KEY = 'codexBridge.chatThreads';
const ACTIVE_THREAD_STATE_KEY_PREFIX = 'codexBridge.activeThread';
const MAX_STORED_THREADS = 60;

export function activate(context: vscode.ExtensionContext): void {
  bridgeContext = context;
  bridgeOutputChannel = vscode.window.createOutputChannel('Codex Bridge');
  bridgeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bridgeStatusBarItem.command = 'codexBridge.openChat';
  sidebarProvider = new CodexBridgeSidebarProvider();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexBridge.sidebar', sidebarProvider),
    vscode.commands.registerCommand('codexBridge.configure', async () => {
      await configureConnection();
    }),
    vscode.commands.registerCommand('codexBridge.checkHealth', async () => {
      await checkHealth();
    }),
    vscode.commands.registerCommand('codexBridge.openChat', async () => {
      await openChatPanel(context);
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
    bridgeOutputChannel,
    bridgeStatusBarItem,
    new vscode.Disposable(() => {
      void stopLocalBridge(false);
    })
  );

  updateStatusBar('idle');
  refreshSidebar();
  void migrateLegacyOsirusProvider();
  void migrateLegacyProviderApiKey();
  void initializeExtension();
}

export function deactivate(): void {
  void stopLocalBridge(false);
}

async function loginToOsirus(): Promise<void> {
  const config = vscode.workspace.getConfiguration('codexBridge');
  const currentApiKey = await getProviderApiKey();
  const apiKeysUrl = getOsirusApiKeysUrl();

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

  await ensureLocalBridgeRunning();
  await pushRuntimeConfig();
  refreshSidebar();

  vscode.window.showInformationMessage(apiKey.trim() !== '' ? 'Osirus API key saved.' : 'Osirus API key cleared.');
}

async function loginToOsirusAccount(): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  try {
    await loginToOsirusAccountViaBrowser();
    return;
  } catch (error) {
    bridgeOutputChannel?.appendLine(`[bridge] browser-based Osirus login unavailable, falling back to direct sign-in: ${getErrorMessage(error)}`);
  }
  await loginToOsirusAccountWithPassword();
}

async function loginToOsirusAccountViaBrowser(): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  const config = vscode.workspace.getConfiguration('codexBridge');
  const baseUrl = getOsirusAccountApiBaseUrl();
  const start = await requestExternalJson<OsirusDeviceAuthStartResponse>(
    'POST',
    `${baseUrl}/auth/device/start`,
    {}
  );

  const deviceCode = String(start.device_code || '').trim();
  const verificationUrl = String(start.verification_uri_complete || start.verification_uri || '').trim();
  const intervalMs = Math.max(2, Number(start.interval || 2)) * 1000;
  const expiresAt = Date.now() + (Math.max(60, Number(start.expires_in || 300)) * 1000);

  if (!deviceCode || !verificationUrl) {
    throw new Error('Osirus device login did not return a browser verification URL.');
  }

  await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));

  const poll = async (): Promise<OsirusDeviceAuthPollResponse> => {
    while (Date.now() < expiresAt) {
      const result = await requestExternalJson<OsirusDeviceAuthPollResponse>(
        'GET',
        `${baseUrl}/auth/device/poll?device_code=${encodeURIComponent(deviceCode)}`
      );
      const status = String(result.status || 'pending').trim().toLowerCase();
      if (status === 'approved') {
        return result;
      }
      if (status === 'expired' || status === 'consumed') {
        throw new Error(`Osirus device login ${status}. Start login again.`);
      }
      await delay(intervalMs);
    }
    throw new Error('Timed out waiting for Osirus browser login to finish.');
  };

  const payload = await vscode.window.withProgress<OsirusDeviceAuthPollResponse>(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Waiting for Osirus sign-in in your browser...',
      cancellable: true,
    },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        throw new Error('Osirus browser sign-in was canceled.');
      });
      return poll();
    }
  );

  const accessToken = String(payload.access_token || '').trim();
  const refreshToken = String(payload.refresh_token || '').trim();
  if (!accessToken || !refreshToken) {
    throw new Error('Osirus browser sign-in did not return usable tokens.');
  }

  await clearOsirusCredentials();
  await setOsirusAuthTokens({ accessToken, refreshToken });
  const resolvedOrg = await ensureOsirusActiveOrgSelection({
    promptUser: false,
    tokenOverride: accessToken,
    preferredOrgId: String(payload.active_org_id || '').trim() || null,
  });
  await config.update('runtimeProvider', 'osirus', vscode.ConfigurationTarget.Global);
  await config.update('authMode', 'none', vscode.ConfigurationTarget.Global);
  await setProviderApiKey('');

  bridgeOutputChannel?.appendLine(`[bridge] signed in to Osirus.AI via browser device flow (${baseUrl}/auth/device/start)`);
  bridgeOutputChannel?.appendLine(`[bridge] active Osirus org: ${resolvedOrg.orgName} (${resolvedOrg.orgId})`);
  refreshSidebar();
  if (bridgeContext) {
    await pushChatPanelState(bridgeContext);
  }
  vscode.window.showInformationMessage(`Signed in to Osirus.AI${resolvedOrg.orgName ? ` (${resolvedOrg.orgName})` : ''}. You can keep working in VS Code.`);
}

async function loginToOsirusAccountWithPassword(): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  const config = vscode.workspace.getConfiguration('codexBridge');
  const email = await vscode.window.showInputBox({
    title: 'Login with Osirus.AI',
    prompt: 'Enter your Osirus account email.',
    ignoreFocusOut: true,
  });

  if (email === undefined) {
    return;
  }

  const password = await vscode.window.showInputBox({
    title: 'Osirus Password',
    prompt: 'Enter your Osirus account password.',
    password: true,
    ignoreFocusOut: true,
  });

  if (password === undefined) {
    return;
  }

  if (email.trim() === '' || password.trim() === '') {
    vscode.window.showErrorMessage('Enter both your Osirus email and password.');
    return;
  }

  const baseUrl = getOsirusAccountApiBaseUrl();
  const payload = await requestExternalJson<OsirusMobileSignInResponse>(
    'POST',
    `${baseUrl}/auth/mobile/signin`,
    {
      email: email.trim(),
      password,
      captcha: null,
    }
  );

  const accessToken = String(payload.access_token || '').trim();
  const refreshToken = String(payload.refresh_token || '').trim();
  if (!accessToken || !refreshToken) {
    throw new Error('Osirus sign-in did not return access and refresh tokens.');
  }

  await setOsirusCredentials({
    email: email.trim(),
    password,
  });
  await setOsirusAuthTokens({ accessToken, refreshToken });
  const resolvedOrg = await ensureOsirusActiveOrgSelection({
    promptUser: true,
    tokenOverride: accessToken,
    preferredOrgId: String(payload.active_org_id || '').trim() || null,
  });
  await config.update('runtimeProvider', 'osirus', vscode.ConfigurationTarget.Global);
  await config.update('authMode', 'none', vscode.ConfigurationTarget.Global);
  await setProviderApiKey('');
  await bridgeContext.workspaceState.update('codexBridge.osirusChatId', undefined);

  bridgeOutputChannel?.appendLine(`[bridge] signed in to Osirus.AI via ${baseUrl}/auth/mobile/signin`);
  bridgeOutputChannel?.appendLine(`[bridge] active Osirus org: ${resolvedOrg.orgName} (${resolvedOrg.orgId})`);
  refreshSidebar();
  await pushChatPanelState(bridgeContext);
  vscode.window.showInformationMessage(`Signed in to Osirus.AI for this extension${resolvedOrg.orgName ? ` (${resolvedOrg.orgName})` : ''}.`);
}

async function logoutFromOsirus(): Promise<void> {
  const config = vscode.workspace.getConfiguration('codexBridge');
  await setProviderApiKey('');
  await config.update('authMode', 'none', vscode.ConfigurationTarget.Global);

  if (bridgeContext) {
    await bridgeContext.workspaceState.update('codexBridge.sessionId', undefined);
  }

  await pushRuntimeConfig();
  refreshSidebar();
  vscode.window.showInformationMessage('Logged out from Osirus in this extension.');
}

async function logoutFromOsirusAccount(): Promise<void> {
  await clearOsirusAuthTokens();
  await clearOsirusCredentials();
  await clearStoredOsirusActiveOrg();
  if (bridgeContext) {
    await bridgeContext.workspaceState.update('codexBridge.osirusChatId', undefined);
    await pushChatPanelState(bridgeContext);
  }
  refreshSidebar();
  vscode.window.showInformationMessage('Signed out from Osirus.AI in this extension.');
}

async function configureConnection(): Promise<void> {
  const config = vscode.workspace.getConfiguration('codexBridge');
  const currentBaseUrl = config.get<string>('baseUrl', 'http://127.0.0.1:4400');
  const currentRuntimeProvider = config.get<RuntimeProvider>('runtimeProvider', 'openai');
  const currentAuthMode = config.get<AuthMode>('authMode', 'chatgpt');
  const currentProviderApiBaseUrl = config.get<string>('providerApiBaseUrl', '');
  const currentProviderApiKey = await getProviderApiKey();
  const currentDefaultModel = config.get<string>('defaultModel', '');
  const currentWorkspaceRoot = config.get<string>('workspaceRoot', '');
  const currentAutoStartLocalBridge = config.get<boolean>('autoStartLocalBridge', true);
  const currentLocalCodexPath = config.get<string>('localCodexPath', '');
  let baseUrl = currentBaseUrl;
  let workspaceRoot = currentWorkspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  let autoStartLocalBridge = currentAutoStartLocalBridge;
  let localCodexPath = currentLocalCodexPath;

  const runtimeProviderPick = await vscode.window.showQuickPick(
    [
      { label: 'OpenAI', value: 'openai' },
      { label: 'Osirus.AI', value: 'osirus' },
      { label: 'Osirus Agent', value: 'osirus_agent' },
      { label: 'Ollama', value: 'ollama' },
      { label: 'vLLM', value: 'vllm' },
      { label: 'OpenAI Compatible', value: 'openai_compatible' },
    ],
    {
      title: 'Runtime Provider',
      ignoreFocusOut: true,
      placeHolder: currentRuntimeProvider,
    }
  );
  if (!runtimeProviderPick) {
    return;
  }
  const selectedRuntimeProvider = runtimeProviderPick.value as RuntimeProvider;
  const supportedAuthModes = getSupportedAuthModes(selectedRuntimeProvider);
  const effectiveCurrentAuthMode = supportedAuthModes.includes(currentAuthMode)
    ? currentAuthMode
    : supportedAuthModes[0];

  const authModePick = await vscode.window.showQuickPick(
    supportedAuthModes.map((authMode) => ({
      label: getAuthModeDisplayLabel(authMode),
      value: authMode,
    })),
    {
      title: 'Authentication Mode',
      ignoreFocusOut: true,
      placeHolder: getAuthModeDisplayLabel(effectiveCurrentAuthMode),
    }
  );
  if (!authModePick) {
    return;
  }
  const selectedAuthMode = authModePick.value as AuthMode;

  const providerApiBaseUrlDefault = selectedRuntimeProvider === currentRuntimeProvider
    ? (currentProviderApiBaseUrl
      || getSuggestedProviderApiBaseUrl(selectedRuntimeProvider)
      || getProviderBaseUrlHint(selectedRuntimeProvider))
    : (getSuggestedProviderApiBaseUrl(selectedRuntimeProvider)
      || getProviderBaseUrlHint(selectedRuntimeProvider));

  const providerApiBaseUrl = await vscode.window.showInputBox({
    title: 'Provider API Base URL',
    value: providerApiBaseUrlDefault,
    prompt: providerRequiresBaseUrl(selectedRuntimeProvider)
      ? `Required for ${getProviderDisplayName(selectedRuntimeProvider)}.`
      : `Optional for ${getProviderDisplayName(selectedRuntimeProvider)}.`,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return providerRequiresBaseUrl(selectedRuntimeProvider)
          ? `Enter the ${getProviderDisplayName(selectedRuntimeProvider)} /v1 base URL.`
          : null;
      }

      return isValidAbsoluteUrl(trimmed) ? null : 'Enter a valid absolute URL.';
    },
  });
  if (providerApiBaseUrl === undefined) {
    return;
  }

  let providerApiKey = currentProviderApiKey;
  if (selectedRuntimeProvider !== 'osirus') {
    const providerApiKeyInput = await vscode.window.showInputBox({
      title: 'Provider API Key',
      value: currentProviderApiKey,
      password: true,
      prompt: 'Optional unless your upstream provider requires a key.',
      ignoreFocusOut: true,
    });
    if (providerApiKeyInput === undefined) {
      return;
    }
    providerApiKey = providerApiKeyInput;
  } else {
    providerApiKey = '';
  }

  const defaultModel = await vscode.window.showInputBox({
    title: 'Default Model',
    value: currentDefaultModel || getSuggestedDefaultModel(selectedRuntimeProvider, selectedAuthMode),
    prompt: 'Optional model override.',
    ignoreFocusOut: true,
  });
  if (defaultModel === undefined) {
    return;
  }

  const workspaceRootInput = await vscode.window.showInputBox({
    title: 'Workspace Root',
    value: workspaceRoot,
    prompt: 'Optional workspace root to send to the bridge.',
    ignoreFocusOut: true,
  });
  if (workspaceRootInput === undefined) {
    return;
  }
  workspaceRoot = workspaceRootInput;

  const advancedBridgeSettingsPick = await vscode.window.showQuickPick(
    [
      { label: 'Keep current bridge settings', value: 'keep' },
      { label: 'Edit bridge URL and runtime options', value: 'edit' },
    ],
    {
      title: 'Bridge Settings',
      ignoreFocusOut: true,
      placeHolder: `Current bridge: ${currentBaseUrl}`,
    }
  );
  if (!advancedBridgeSettingsPick) {
    return;
  }

  if (advancedBridgeSettingsPick.value === 'edit') {
    const baseUrlInput = await vscode.window.showInputBox({
      title: 'Codex Bridge Base URL',
      value: currentBaseUrl,
      prompt: 'Example: http://127.0.0.1:4400',
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          new URL(value);
          return null;
        } catch (error) {
          return 'Enter a valid absolute URL.';
        }
      },
    });
    if (baseUrlInput === undefined) {
      return;
    }
    baseUrl = baseUrlInput;

    const autoStartLocalBridgePick = await vscode.window.showQuickPick(
      [
        { label: 'Auto-start local bridge', value: 'true' },
        { label: 'Do not auto-start local bridge', value: 'false' },
      ],
      {
        title: 'Local Bridge Management',
        ignoreFocusOut: true,
        placeHolder: currentAutoStartLocalBridge ? 'Auto-start local bridge' : 'Do not auto-start local bridge',
      }
    );
    if (!autoStartLocalBridgePick) {
      return;
    }
    autoStartLocalBridge = autoStartLocalBridgePick.value === 'true';

    const localCodexPathInput = await vscode.window.showInputBox({
      title: 'Local Codex Path',
      value: currentLocalCodexPath,
      prompt: 'Optional absolute path to a local Codex executable. Leave blank to prefer the bundled runtime.',
      ignoreFocusOut: true,
    });
    if (localCodexPathInput === undefined) {
      return;
    }
    localCodexPath = localCodexPathInput;
  }

  await config.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  await config.update('runtimeProvider', selectedRuntimeProvider, vscode.ConfigurationTarget.Global);
  await config.update('authMode', selectedAuthMode, vscode.ConfigurationTarget.Global);
  await config.update('providerApiBaseUrl', providerApiBaseUrl.trim(), vscode.ConfigurationTarget.Global);
  await setProviderApiKey(providerApiKey);
  await config.update('defaultModel', defaultModel.trim(), vscode.ConfigurationTarget.Global);
  await config.update('workspaceRoot', workspaceRoot.trim(), vscode.ConfigurationTarget.Global);
  await config.update('autoStartLocalBridge', autoStartLocalBridge, vscode.ConfigurationTarget.Global);
  await config.update('localCodexPath', localCodexPath.trim(), vscode.ConfigurationTarget.Global);

  if (shouldManageLocalBridge()) {
    await ensureLocalBridgeRunning();
  }

  const pushed = await pushRuntimeConfig({ suppressErrors: true });
  refreshSidebar();
  vscode.window.showInformationMessage(
    pushed ? 'Codex Bridge settings saved and synced to the bridge.' : 'Codex Bridge settings saved locally.'
  );
}

async function checkHealth(): Promise<void> {
  try {
    await ensureLocalBridgeRunning();
    await pushRuntimeConfig();
    const health = await requestJson<BridgeHealthResponse>('GET', '/health');
    if (health.ok !== true) {
      throw new Error(health.error || 'Bridge health check failed.');
    }

    const runtimeProvider = health.runtime_config?.runtime_provider || 'unknown';
    const authMode = health.runtime_config?.auth_mode || 'unknown';
    const runtimeKind = health.runtime_kind || 'unknown';
    vscode.window.showInformationMessage(
      `Codex Bridge is healthy. Runtime: ${runtimeKind}. Provider: ${runtimeProvider}. Auth: ${authMode}.`
    );
  } catch (error) {
    vscode.window.showErrorMessage(getErrorMessage(error));
  }
}

async function openChatPanel(context: vscode.ExtensionContext): Promise<void> {
  if (getCurrentRuntimeProvider() !== 'osirus') {
    await ensureLocalBridgeRunning();
  }
  refreshSidebar();

  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  chatPanel = vscode.window.createWebviewPanel(
    'codexBridgeChat',
    'Codex Bridge Chat',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  chatPanel.onDidDispose(() => {
    chatPanel = undefined;
  }, null, context.subscriptions);

  chatPanel.webview.onDidReceiveMessage(async (message) => {
    if (!chatPanel) {
      return;
    }

    try {
      if (message?.type === 'ready') {
        await pushChatPanelState(context);
        return;
      }

      if (message?.type === 'newThread') {
        const thread = await createLocalChatThread(getCurrentRuntimeProvider());
        chatPanel.webview.postMessage({ type: 'status', value: `Started ${thread.title.toLowerCase()}.` });
        await pushChatPanelState(context);
        return;
      }

      if (message?.type === 'openThread') {
        const threadId = String(message.threadId || '').trim();
        if (!threadId) {
          return;
        }
        const thread = await getStoredChatThread(threadId);
        if (!thread || thread.provider !== getCurrentRuntimeProvider()) {
          return;
        }
        await setActiveThreadIdForProvider(thread.provider, thread.id);
        await pushChatPanelState(context);
        return;
      }

      if (message?.type !== 'sendMessage') {
        return;
      }

      const prompt = String(message.prompt || '').trim();
      if (!prompt) {
        return;
      }
      const attachments = Array.isArray(message.attachments)
        ? message.attachments.filter((attachment: any) => Boolean(attachment?.dataUrl))
        : [];

      const runtimeProvider = getCurrentRuntimeProvider();
      let activeThread = await getOrCreateActiveThread(runtimeProvider);
      const userMessage: LocalChatMessage = {
        id: createLocalId('msg'),
        role: 'user',
        content: prompt,
        createdAt: Date.now(),
      };
      activeThread = await appendStoredThreadMessage(activeThread.id, userMessage);

      const modelSelectionId = runtimeProvider === 'osirus'
        ? String(message.modelSelectionId || activeThread.selectedModelId || '').trim()
        : '';

      if (runtimeProvider === 'osirus') {
        await getValidOsirusAccessToken();
        if (attachments.length) {
          bridgeOutputChannel?.appendLine('[bridge] Osirus.AI full Codex mode ignores native chat attachments for now while routing through the bundled Codex runtime.');
        }
        if (modelSelectionId && modelSelectionId !== activeThread.selectedModelId) {
          activeThread = await updateStoredThreadMessages(activeThread.id, activeThread.messages, {
            selectedModelId: modelSelectionId,
          });
        }
      }

      chatPanel.webview.postMessage({ type: 'status', value: 'Syncing runtime config...' });
      await pushRuntimeConfig({
        modelOverride: runtimeProvider === 'osirus' ? modelSelectionId : undefined,
      });

      let activeSessionId = activeThread.sessionId || '';
      if (activeSessionId) {
        try {
          await requestJson<BridgeSessionResponse>('GET', `/chat/sessions/${encodeURIComponent(activeSessionId)}`, undefined, {
            suppressLog: true,
            timeoutMs: 4000,
          });
        } catch (error) {
          activeSessionId = '';
        }
      }
      if (!activeSessionId) {
        const createResponse = await requestJson<SessionCreateResponse>('POST', '/chat/sessions', {
          context: buildChatContext(),
        });
        activeSessionId = extractSessionId(createResponse);
        if (!activeSessionId) {
          throw new Error('Bridge did not return a session id.');
        }
        activeThread = await updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          sessionId: activeSessionId,
        });
      }

      chatPanel.webview.postMessage({ type: 'status', value: 'Sending message...' });
      try {
        await requestJson<Record<string, unknown>>(
          'POST',
          `/chat/sessions/${encodeURIComponent(activeSessionId)}/messages`,
          {
            message: prompt,
            context: buildChatContext(),
          }
        );
      } catch (sendError) {
        const msg = getErrorMessage(sendError).toLowerCase();
        if (!msg.includes('session') && !msg.includes('not found')) {
          throw sendError;
        }

        const createResponse = await requestJson<SessionCreateResponse>('POST', '/chat/sessions', {
          context: buildChatContext(),
        });
        activeSessionId = extractSessionId(createResponse);
        if (!activeSessionId) {
          throw new Error('Bridge did not return a replacement session id.');
        }
        activeThread = await updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          sessionId: activeSessionId,
        });
        await requestJson<Record<string, unknown>>(
          'POST',
          `/chat/sessions/${encodeURIComponent(activeSessionId)}/messages`,
          {
            message: prompt,
            context: buildChatContext(),
          }
        );
      }

      chatPanel.webview.postMessage({ type: 'status', value: 'Waiting for Codex reply...' });
      const completedSession = await waitForSessionCompletion(activeSessionId);
      const assistantText = extractAssistantTextFromSession(completedSession);
      await updateStoredThreadMessages(activeThread.id, mapBridgeSessionMessagesToLocal(completedSession.messages), {
        sessionId: activeSessionId,
      });
      chatPanel.webview.postMessage({ type: 'assistantDone', value: assistantText });
      await pushChatPanelState(context);
      chatPanel.webview.postMessage({ type: 'status', value: '' });
    } catch (error) {
      chatPanel.webview.postMessage({ type: 'error', value: getErrorMessage(error) });
    }
  }, null, context.subscriptions);

  chatPanel.webview.html = getWebviewHtml();
}

function getBaseUrl(): string {
  return vscode.workspace.getConfiguration('codexBridge').get<string>('baseUrl', 'http://127.0.0.1:4400').replace(/\/+$/, '');
}

function getOsirusSignupUrl(): string {
  return vscode.workspace.getConfiguration('codexBridge').get<string>('osirusSignupUrl', 'https://osirus.ai/signup');
}

function getOsirusApiKeysUrl(): string {
  return vscode.workspace.getConfiguration('codexBridge').get<string>('osirusApiKeysUrl', 'https://osirus.ai/api-keys');
}

function getCurrentRuntimeProvider(): RuntimeProvider {
  return vscode.workspace.getConfiguration('codexBridge').get<RuntimeProvider>('runtimeProvider', 'openai');
}

async function migrateLegacyOsirusProvider(): Promise<void> {
  const config = vscode.workspace.getConfiguration('codexBridge');
  const runtimeProvider = config.get<RuntimeProvider>('runtimeProvider', 'openai');
  const providerApiBaseUrl = config.get<string>('providerApiBaseUrl', '').trim();

  if (runtimeProvider === 'osirus' && /\/api\/agents\/[^/]+\/v1/i.test(providerApiBaseUrl)) {
    await config.update('runtimeProvider', 'osirus_agent', vscode.ConfigurationTarget.Global);
    bridgeOutputChannel?.appendLine('[bridge] migrated legacy osirus provider to osirus_agent based on agent-scoped /v1 URL');
    refreshSidebar();
  }
}

function getCurrentAuthMode(): AuthMode {
  return vscode.workspace.getConfiguration('codexBridge').get<AuthMode>('authMode', 'chatgpt');
}

function getSupportedAuthModes(provider: RuntimeProvider): AuthMode[] {
  switch (provider) {
    case 'openai':
      return ['chatgpt', 'api_key'];
    case 'osirus':
      return ['none'];
    case 'osirus_agent':
      return ['api_key'];
    case 'ollama':
      return ['none'];
    case 'vllm':
    case 'openai_compatible':
      return ['api_key', 'none'];
    default:
      return ['none'];
  }
}

function getAuthModeDisplayLabel(authMode: AuthMode): string {
  switch (authMode) {
    case 'chatgpt':
      return 'ChatGPT Sign-In';
    case 'api_key':
      return 'Direct API Key';
    case 'none':
      return 'No Login';
    default:
      return authMode;
  }
}

function providerNeedsSavedApiKey(provider: RuntimeProvider, authMode: AuthMode): boolean {
  return authMode === 'api_key' && provider !== 'ollama' && provider !== 'osirus';
}

function getProviderDisplayName(provider: RuntimeProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'osirus':
      return 'Osirus.AI';
    case 'osirus_agent':
      return 'Osirus Agent';
    case 'ollama':
      return 'Ollama';
    case 'vllm':
      return 'vLLM';
    case 'openai_compatible':
      return 'OpenAI-Compatible';
    default:
      return 'Codex Bridge';
  }
}

function getProviderIcon(provider: RuntimeProvider): string {
  switch (provider) {
    case 'openai':
      return 'A';
    case 'osirus':
      return 'O';
    case 'osirus_agent':
      return 'G';
    case 'ollama':
      return 'L';
    case 'vllm':
      return 'V';
    case 'openai_compatible':
      return 'C';
    default:
      return 'C';
  }
}

function getProviderSetupSummary(provider: RuntimeProvider, authMode: AuthMode): string {
  switch (provider) {
    case 'openai':
      return authMode === 'chatgpt'
        ? 'Use your ChatGPT sign-in or switch to an API key for direct OpenAI access.'
        : 'Use your OpenAI API key to connect to the remote OpenAI Responses endpoint.';
    case 'osirus':
      return 'Connect to the regular Osirus.AI experience. Chat uses your Osirus account and the same model sources as the Osirus app.';
    case 'osirus_agent':
      return 'Connect your Osirus agent-scoped OpenAI-compatible `/v1` endpoint with an API key.';
    case 'ollama':
      return 'Connect to a local Ollama server. No API key is usually required.';
    case 'vllm':
      return 'Connect to your vLLM OpenAI-compatible `/v1` endpoint.';
    case 'openai_compatible':
      return 'Connect any OpenAI-compatible `/v1` endpoint with the right base URL and credentials.';
    default:
      return 'Configure your bridge provider and credentials.';
  }
}

function getProviderBaseUrlHint(provider: RuntimeProvider): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'osirus':
      return 'https://osirus.ai/api';
    case 'osirus_agent':
      return 'https://example.osirus.ai/api/agents/AGENT_ID/v1';
    case 'ollama':
      return 'http://127.0.0.1:11434/v1';
    case 'vllm':
      return 'http://127.0.0.1:8000/v1';
    case 'openai_compatible':
      return 'https://your-provider.example.com/v1';
    default:
      return '';
  }
}

function getSuggestedProviderApiBaseUrl(provider: RuntimeProvider): string {
  switch (provider) {
    case 'openai':
      return 'https://api.openai.com/v1';
    case 'osirus':
      return 'https://osirus.ai/api';
    case 'ollama':
      return 'http://127.0.0.1:11434/v1';
    case 'vllm':
      return 'http://127.0.0.1:8000/v1';
    default:
      return '';
  }
}

function getConfiguredProviderApiBaseUrl(): string {
  return vscode.workspace.getConfiguration('codexBridge').get<string>('providerApiBaseUrl', '').trim();
}

function getOsirusAccountApiBaseUrl(): string {
  const configured = getConfiguredProviderApiBaseUrl();
  if (configured !== '' && isValidAbsoluteUrl(configured)) {
    return configured.replace(/\/+$/, '');
  }

  return 'https://osirus.ai/api';
}

function getSuggestedDefaultModel(provider: RuntimeProvider, authMode: AuthMode): string {
  switch (provider) {
    case 'openai':
      return authMode === 'chatgpt' ? 'gpt-5-codex' : 'gpt-5-codex';
    case 'ollama':
      return 'gpt-oss:20b';
    case 'vllm':
    case 'osirus':
    case 'osirus_agent':
    case 'openai_compatible':
      return '';
    default:
      return '';
  }
}

function providerRequiresBaseUrl(provider: RuntimeProvider): boolean {
  return ['osirus', 'osirus_agent', 'vllm', 'openai_compatible'].includes(provider);
}

function isValidAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch (error) {
    return false;
  }
}

async function initializeExtension(): Promise<void> {
  updateStatusBar('starting');
  refreshSidebar();

  if (!isStatusBarButtonEnabled()) {
    bridgeStatusBarItem?.hide();
  }

  if (!shouldManageLocalBridge()) {
    updateStatusBar('ready');
    return;
  }

  try {
    await ensureLocalBridgeRunning();
    await pushRuntimeConfig();
    updateStatusBar('ready');
    refreshSidebar();
  } catch (error) {
    bridgeOutputChannel?.appendLine(`[bridge] startup initialization failed: ${getErrorMessage(error)}`);
    updateStatusBar('error');
    refreshSidebar();
  }
}

function getBridgeRootPath(): string {
  if (!bridgeContext) {
    throw new Error('Codex Bridge extension context is not available.');
  }

  return path.resolve(bridgeContext.extensionPath, '..');
}

function getBridgeServerPath(): string {
  return path.join(getBridgeRootPath(), 'server.mjs');
}

function getExtensionRootPath(): string {
  if (!bridgeContext) {
    throw new Error('Codex Bridge extension context is not available.');
  }

  return bridgeContext.extensionPath;
}

function getBundledCodexRelativePath(): string {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  return path.join('bundled-runtime', `${process.platform}-${process.arch}`, executableName);
}

function getBundledCodexPath(): string {
  return path.join(getExtensionRootPath(), getBundledCodexRelativePath());
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function resolveLocalCodexRuntime(): Promise<{ command: string; source: string }> {
  const config = vscode.workspace.getConfiguration('codexBridge');
  const overridePath = config.get<string>('localCodexPath', '').trim();

  if (overridePath !== '') {
    if (await pathExists(overridePath)) {
      return { command: overridePath, source: 'configured override' };
    }

    throw new Error(`Configured local Codex path does not exist: ${overridePath}`);
  }

  const bundledPath = getBundledCodexPath();
  if (await pathExists(bundledPath)) {
    return {
      command: bundledPath,
      source: `bundled runtime (${process.platform}-${process.arch})`,
    };
  }

  return { command: 'codex', source: 'system PATH' };
}

async function getIsolatedCodexHomePath(): Promise<string> {
  if (!bridgeContext) {
    throw new Error('Codex Bridge extension context is not ready.');
  }

  const codexHomePath = path.join(bridgeContext.globalStorageUri.fsPath, 'codex-home');
  await mkdir(codexHomePath, { recursive: true });
  return codexHomePath;
}

function getBaseUrlInfo(): URL {
  return new URL(getBaseUrl());
}

function isLocalBaseUrl(): boolean {
  try {
    const url = getBaseUrlInfo();
    return ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch (error) {
    return false;
  }
}

function shouldManageLocalBridge(): boolean {
  const config = vscode.workspace.getConfiguration('codexBridge');
  return config.get<boolean>('autoStartLocalBridge', true) && isLocalBaseUrl();
}

function isStatusBarButtonEnabled(): boolean {
  return vscode.workspace.getConfiguration('codexBridge').get<boolean>('showStatusBarButton', true);
}

function getLocalBridgePort(): string {
  const url = getBaseUrlInfo();
  if (url.port) {
    return url.port;
  }

  return url.protocol === 'https:' ? '443' : '80';
}

async function getRuntimeConfigPayload(options?: { modelOverride?: string }): Promise<RuntimeConfigPayload> {
  const config = vscode.workspace.getConfiguration('codexBridge');
  const runtimeProvider = config.get<RuntimeProvider>('runtimeProvider', 'openai');
  const workspaceRoot = config.get<string>('workspaceRoot', '') || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const configuredBaseUrl = config.get<string>('providerApiBaseUrl', '');
  let authMode = config.get<AuthMode>('authMode', 'chatgpt');
  let providerApiKey = await getProviderApiKey();
  let providerApiBaseUrl = configuredBaseUrl;

  if (runtimeProvider === 'osirus') {
    providerApiKey = await getValidOsirusAccessToken();
    providerApiBaseUrl = configuredBaseUrl || getOsirusAccountApiBaseUrl();
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

async function hasSavedApiKey(): Promise<boolean> {
  return (await getProviderApiKey()).trim() !== '';
}

async function getOsirusAccessToken(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }

  return (await bridgeContext.secrets.get(OSIRUS_ACCESS_TOKEN_SECRET_KEY)) || '';
}

async function getOsirusRefreshToken(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }

  return (await bridgeContext.secrets.get(OSIRUS_REFRESH_TOKEN_SECRET_KEY)) || '';
}

async function getOsirusEmail(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }

  return (await bridgeContext.secrets.get(OSIRUS_EMAIL_SECRET_KEY)) || '';
}

async function getOsirusPassword(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }

  return (await bridgeContext.secrets.get(OSIRUS_PASSWORD_SECRET_KEY)) || '';
}

async function setOsirusCredentials(credentials: { email: string; password: string }): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  await bridgeContext.secrets.store(OSIRUS_EMAIL_SECRET_KEY, credentials.email.trim());
  await bridgeContext.secrets.store(OSIRUS_PASSWORD_SECRET_KEY, credentials.password);
}

async function clearOsirusCredentials(): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  await bridgeContext.secrets.delete(OSIRUS_EMAIL_SECRET_KEY);
  await bridgeContext.secrets.delete(OSIRUS_PASSWORD_SECRET_KEY);
}

async function setOsirusAuthTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  await bridgeContext.secrets.store(OSIRUS_ACCESS_TOKEN_SECRET_KEY, tokens.accessToken.trim());
  await bridgeContext.secrets.store(OSIRUS_REFRESH_TOKEN_SECRET_KEY, tokens.refreshToken.trim());
}

async function clearOsirusAuthTokens(): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  await bridgeContext.secrets.delete(OSIRUS_ACCESS_TOKEN_SECRET_KEY);
  await bridgeContext.secrets.delete(OSIRUS_REFRESH_TOKEN_SECRET_KEY);
}

async function hasOsirusAccountSession(): Promise<boolean> {
  return (await getOsirusAccessToken()).trim() !== '';
}

async function getSavedOsirusSelectedModelId(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }

  return (await bridgeContext.secrets.get(OSIRUS_SELECTED_MODEL_SECRET_KEY)) || '';
}

async function setSavedOsirusSelectedModelId(value: string): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    await bridgeContext.secrets.delete(OSIRUS_SELECTED_MODEL_SECRET_KEY);
  } else {
    await bridgeContext.secrets.store(OSIRUS_SELECTED_MODEL_SECRET_KEY, trimmed);
  }
}

function getOsirusOrgLabel(membership: OsirusOrgMembership): string {
  return String(membership.org?.name || membership.org?.slug || membership.orgId || membership.id || '').trim();
}

async function getStoredOsirusActiveOrgId(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }
  return String(bridgeContext.globalState.get<string>(OSIRUS_ACTIVE_ORG_ID_STATE_KEY) || '').trim();
}

async function getStoredOsirusActiveOrgName(): Promise<string> {
  if (!bridgeContext) {
    return '';
  }
  return String(bridgeContext.globalState.get<string>(OSIRUS_ACTIVE_ORG_NAME_STATE_KEY) || '').trim();
}

async function setStoredOsirusActiveOrg(orgId: string, orgName?: string): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  const trimmedOrgId = orgId.trim();
  const trimmedOrgName = String(orgName || '').trim();
  await bridgeContext.globalState.update(OSIRUS_ACTIVE_ORG_ID_STATE_KEY, trimmedOrgId || undefined);
  await bridgeContext.globalState.update(OSIRUS_ACTIVE_ORG_NAME_STATE_KEY, trimmedOrgName || undefined);
}

async function clearStoredOsirusActiveOrg(): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  await bridgeContext.globalState.update(OSIRUS_ACTIVE_ORG_ID_STATE_KEY, undefined);
  await bridgeContext.globalState.update(OSIRUS_ACTIVE_ORG_NAME_STATE_KEY, undefined);
}

function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getWorkspaceFingerprint(): string {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = folders.map((folder) => folder.uri.toString()).sort();
  if (roots.length > 0) {
    return roots.join('|');
  }
  return `single:${vscode.workspace.name || 'workspace'}:${vscode.env.remoteName || 'local'}`;
}

async function getThreadScopeKey(provider: RuntimeProvider): Promise<string> {
  if (provider === 'osirus') {
    const orgId = await getStoredOsirusActiveOrgId();
    return `${getWorkspaceFingerprint()}::org:${orgId || 'none'}`;
  }
  return getWorkspaceFingerprint();
}

async function getActiveThreadStateKey(provider: RuntimeProvider): Promise<string> {
  return `${ACTIVE_THREAD_STATE_KEY_PREFIX}.${provider}.${await getThreadScopeKey(provider)}`;
}

function sanitizeLocalChatMessage(value: any): LocalChatMessage | null {
  const role = normalizeOsirusHistoryRole(value?.role);
  const content = String(value?.content || '').trim();
  if (!role || !content) {
    return null;
  }

  return {
    id: String(value?.id || createLocalId('msg')).trim(),
    role,
    content,
    createdAt: Number(value?.createdAt || value?.created_at || Date.now()) || Date.now(),
  };
}

function sanitizeLocalChatThread(value: any): LocalChatThread | null {
  const provider = String(value?.provider || '').trim() as RuntimeProvider;
  const validProvider = ['openai', 'ollama', 'vllm', 'osirus', 'osirus_agent', 'openai_compatible'].includes(provider)
    ? provider
    : null;
  if (!validProvider) {
    return null;
  }

  const messages = Array.isArray(value?.messages)
    ? value.messages
      .map((message: any) => sanitizeLocalChatMessage(message))
      .filter((message: LocalChatMessage | null): message is LocalChatMessage => Boolean(message))
    : [];

  return {
    id: String(value?.id || createLocalId('thread')).trim(),
    provider: validProvider,
    title: String(value?.title || 'New chat').trim() || 'New chat',
    summary: String(value?.summary || '').trim(),
    workspaceFingerprint: String(value?.workspaceFingerprint || value?.workspace_fingerprint || '').trim() || getWorkspaceFingerprint(),
    createdAt: Number(value?.createdAt || value?.created_at || Date.now()) || Date.now(),
    updatedAt: Number(value?.updatedAt || value?.updated_at || Date.now()) || Date.now(),
    sessionId: String(value?.sessionId || '').trim() || undefined,
    osirusChatId: String(value?.osirusChatId || '').trim() || undefined,
    selectedModelId: String(value?.selectedModelId || '').trim() || undefined,
    messages,
  };
}

async function getStoredChatThreads(): Promise<LocalChatThread[]> {
  if (!bridgeContext) {
    return [];
  }

  const raw = bridgeContext.globalState.get<any[]>(CHAT_THREADS_GLOBAL_STATE_KEY, []);
  return (Array.isArray(raw) ? raw : [])
    .map((thread) => sanitizeLocalChatThread(thread))
    .filter((thread: LocalChatThread | null): thread is LocalChatThread => Boolean(thread))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_THREADS);
}

async function saveStoredChatThreads(threads: LocalChatThread[]): Promise<void> {
  if (!bridgeContext) {
    return;
  }

  const normalized = [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_THREADS);
  await bridgeContext.globalState.update(CHAT_THREADS_GLOBAL_STATE_KEY, normalized);
}

async function upsertStoredChatThread(thread: LocalChatThread): Promise<LocalChatThread> {
  const threads = await getStoredChatThreads();
  const nextThreads = threads.filter((entry) => entry.id !== thread.id);
  nextThreads.unshift({
    ...thread,
    updatedAt: thread.updatedAt || Date.now(),
  });
  await saveStoredChatThreads(nextThreads);
  return thread;
}

async function getStoredChatThread(threadId: string): Promise<LocalChatThread | undefined> {
  const threads = await getStoredChatThreads();
  return threads.find((thread) => thread.id === threadId);
}

function getCurrentProviderWorkspaceThreads(threads: LocalChatThread[], provider: RuntimeProvider): LocalChatThread[] {
  return threads.filter((thread) => thread.provider === provider);
}

async function getActiveThreadIdForProvider(provider: RuntimeProvider): Promise<string> {
  if (!bridgeContext) {
    return '';
  }
  return String(bridgeContext.workspaceState.get<string>(await getActiveThreadStateKey(provider)) || '').trim();
}

async function setActiveThreadIdForProvider(provider: RuntimeProvider, threadId?: string): Promise<void> {
  if (!bridgeContext) {
    return;
  }
  await bridgeContext.workspaceState.update(await getActiveThreadStateKey(provider), threadId || undefined);
}

function deriveThreadTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return 'New chat';
  }
  return collapsed.length > 48 ? `${collapsed.slice(0, 48).trimEnd()}...` : collapsed;
}

function summarizeThreadFromMessages(messages: LocalChatMessage[]): string {
  const lastMeaningful = [...messages].reverse().find((message) => message.content.trim() !== '');
  if (!lastMeaningful) {
    return '';
  }
  const collapsed = lastMeaningful.content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 90 ? `${collapsed.slice(0, 90).trimEnd()}...` : collapsed;
}

async function createLocalChatThread(provider: RuntimeProvider, seed?: Partial<LocalChatThread>): Promise<LocalChatThread> {
  const now = Date.now();
  const scopeKey = await getThreadScopeKey(provider);
  const thread: LocalChatThread = {
    id: seed?.id || createLocalId('thread'),
    provider,
    title: seed?.title || 'New chat',
    summary: seed?.summary || '',
    workspaceFingerprint: seed?.workspaceFingerprint || scopeKey,
    createdAt: seed?.createdAt || now,
    updatedAt: seed?.updatedAt || now,
    sessionId: seed?.sessionId,
    osirusChatId: seed?.osirusChatId,
    selectedModelId: seed?.selectedModelId,
    messages: seed?.messages || [],
  };

  await upsertStoredChatThread(thread);
  await setActiveThreadIdForProvider(provider, thread.id);
  return thread;
}

async function getOrCreateActiveThread(provider: RuntimeProvider): Promise<LocalChatThread> {
  const threads = await getStoredChatThreads();
  const scopeKey = await getThreadScopeKey(provider);
  const scopedThreads = getCurrentProviderWorkspaceThreads(threads, provider)
    .filter((thread) => thread.workspaceFingerprint === scopeKey);
  const activeThreadId = await getActiveThreadIdForProvider(provider);
  const existing = scopedThreads.find((thread) => thread.id === activeThreadId);
  if (existing) {
    return existing;
  }

  if (scopedThreads[0]) {
    await setActiveThreadIdForProvider(provider, scopedThreads[0].id);
    return scopedThreads[0];
  }

  return createLocalChatThread(provider);
}

async function updateStoredThreadMessages(
  threadId: string,
  messages: LocalChatMessage[],
  patch?: Partial<LocalChatThread>
): Promise<LocalChatThread> {
  const existing = await getStoredChatThread(threadId);
  if (!existing) {
    throw new Error('Chat thread was not found.');
  }

  const nextThread: LocalChatThread = {
    ...existing,
    ...patch,
    title: (patch?.title || existing.title || 'New chat').trim() || 'New chat',
    summary: summarizeThreadFromMessages(messages),
    messages,
    updatedAt: Date.now(),
  };
  await upsertStoredChatThread(nextThread);
  return nextThread;
}

async function appendStoredThreadMessage(
  threadId: string,
  message: LocalChatMessage,
  patch?: Partial<LocalChatThread>
): Promise<LocalChatThread> {
  const existing = await getStoredChatThread(threadId);
  if (!existing) {
    throw new Error('Chat thread was not found.');
  }

  const nextMessages = [...existing.messages, message];
  const proposedTitle = existing.title === 'New chat' && message.role === 'user'
    ? deriveThreadTitle(message.content)
    : existing.title;
  return updateStoredThreadMessages(threadId, nextMessages, {
    ...patch,
    title: patch?.title || proposedTitle,
  });
}

function mapBridgeSessionMessagesToLocal(messages: BridgeSessionRecord['messages']): LocalChatMessage[] {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role = normalizeOsirusHistoryRole(message?.role);
      const content = String(message?.text || '').trim();
      if (!role || !content) {
        return null;
      }
      return {
        id: createLocalId('msg'),
        role,
        content,
        createdAt: Date.now(),
      };
    })
    .filter((message: LocalChatMessage | null): message is LocalChatMessage => Boolean(message));
}

function mapOsirusHistoryToLocal(messages: OsirusChatHistoryMessage[]): LocalChatMessage[] {
  return messages.map((message) => ({
    id: message.id || createLocalId('msg'),
    role: message.role,
    content: message.content,
    createdAt: Date.now(),
  }));
}

function resolveSelectedOsirusModelIdFromHistory(
  history: OsirusChatHistoryMessage[],
  options: OsirusModelOption[]
): string {
  for (const message of [...history].reverse()) {
    const productId = String(message.productId || '').trim();
    if (productId) {
      const productMatch = options.find((option) => option.kind === 'product' && option.productId === productId);
      if (productMatch) {
        return productMatch.id;
      }
    }

    const providerSettingId = String(message.providerSettingId || '').trim();
    const modelSlug = String(message.modelSlug || message.modelId || '').trim();
    if (providerSettingId && modelSlug) {
      const providerMatch = options.find((option) =>
        option.kind === 'provider' &&
        option.providerSettingId === providerSettingId &&
        String(option.modelSlug || option.modelId || '').trim() === modelSlug
      );
      if (providerMatch) {
        return preferOsirusProductOption(providerMatch, options).id;
      }
    }
  }

  return '';
}

function shouldKeepLocalOsirusMessages(localMessages: LocalChatMessage[], fetchedMessages: LocalChatMessage[]): boolean {
  if (!localMessages.length) {
    return false;
  }
  if (!fetchedMessages.length) {
    return true;
  }
  if (fetchedMessages.length < localMessages.length) {
    return true;
  }

  const localTail = [...localMessages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim() !== '');
  if (!localTail) {
    return false;
  }

  return !fetchedMessages.some((message) =>
    message.role === 'assistant' &&
    message.content.trim() === localTail.content.trim()
  );
}

function reconcileOsirusMessages(localMessages: LocalChatMessage[], fetchedMessages: LocalChatMessage[]): LocalChatMessage[] {
  if (shouldKeepLocalOsirusMessages(localMessages, fetchedMessages)) {
    return localMessages;
  }
  return fetchedMessages;
}

function decodeDataUrlAttachment(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Attachment data was not a valid base64 data URL.');
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function appendOsirusAttachments(formData: FormData, attachments: WebviewAttachment[]): void {
  for (const attachment of attachments) {
    const name = String(attachment.name || 'attachment').trim() || 'attachment';
    const decoded = decodeDataUrlAttachment(attachment.dataUrl);
    const bytes = new Uint8Array(decoded.buffer);
    const blob = new Blob([bytes], {
      type: String(attachment.mimeType || decoded.mimeType || 'application/octet-stream'),
    });
    formData.append('attachments', blob, name);
  }
}

function appendOsirusModelSelection(formData: FormData, selected: OsirusModelOption): void {
  if (selected.kind === 'product' && selected.productId) {
    formData.append('product_id', selected.productId);
  }
  if (selected.kind === 'provider') {
    if (selected.providerSettingId) {
      formData.append('provider_setting_id', selected.providerSettingId);
    }
    if (selected.modelId) {
      formData.append('model_id', selected.modelId);
    }
  }
  if (selected.modelSlug) {
    formData.append('model_slug', selected.modelSlug);
  }
}

function normalizeOsirusConversationMode(value: unknown): 'voice' | 'chat' | 'search' | 'copilot' | 'agent' | undefined {
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'object' && value
      ? String((value as Record<string, unknown>).value || (value as Record<string, unknown>).id || (value as Record<string, unknown>).key || '')
      : '';
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === 'voice' ||
    normalized === 'chat' ||
    normalized === 'search' ||
    normalized === 'copilot' ||
    normalized === 'agent'
  ) {
    return normalized;
  }
  return undefined;
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

function buildOsirusChatFormData(
  prompt: string,
  chatId: string,
  selected: OsirusModelOption,
  attachments: WebviewAttachment[] = [],
  options?: { stream?: boolean }
): FormData {
  const formData = new FormData();
  formData.append('chatId', chatId);
  formData.append('content', prompt);
  formData.append('role', 'user');
  formData.append('generate', 'true');
  // Regular Osirus.AI chat should behave like the main chat UI, not copilot/search/agent flows.
  formData.append('mode', 'chat');
  formData.append('is_stream', options?.stream ? 'true' : 'false');
  appendOsirusModelSelection(formData, selected);
  if (attachments.length) {
    appendOsirusAttachments(formData, attachments);
  }
  return formData;
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
  const runtimeProvider = getCurrentRuntimeProvider();
  const activeThread = await getOrCreateActiveThread(runtimeProvider);
  let refreshedThread = activeThread;
  let osirusModels: OsirusModelOption[] = [];
  let selectedOsirusModelId = activeThread.selectedModelId || '';

  if (runtimeProvider === 'osirus' && await hasOsirusAccountSession()) {
    try {
      osirusModels = await fetchOsirusModelOptions();
      selectedOsirusModelId = selectedOsirusModelId || await getSavedOsirusSelectedModelId();
      if (!osirusModels.some((option) => option.id === selectedOsirusModelId)) {
        selectedOsirusModelId = osirusModels[0]?.id || '';
      }
      if (selectedOsirusModelId && selectedOsirusModelId !== activeThread.selectedModelId) {
        refreshedThread = await updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          selectedModelId: selectedOsirusModelId,
        });
      }
      if (refreshedThread.osirusChatId) {
        const snapshot = await fetchOsirusChatSnapshot(refreshedThread.osirusChatId);
        const resolvedHistoryModelId = resolveSelectedOsirusModelIdFromHistory(snapshot.messages, osirusModels);
        refreshedThread = await updateStoredThreadMessages(
          refreshedThread.id,
          reconcileOsirusMessages(refreshedThread.messages, mapOsirusHistoryToLocal(snapshot.messages)),
          {
            title: snapshot.title || refreshedThread.title,
            selectedModelId: resolvedHistoryModelId || selectedOsirusModelId || refreshedThread.selectedModelId,
          }
        );
        if (resolvedHistoryModelId) {
          selectedOsirusModelId = resolvedHistoryModelId;
        }
      }
    } catch (error) {
      bridgeOutputChannel?.appendLine(`[bridge] failed to build Osirus chat panel state: ${getErrorMessage(error)}`);
    }
  }

  const scopeKey = await getThreadScopeKey(runtimeProvider);
  const threads = getCurrentProviderWorkspaceThreads(await getStoredChatThreads(), runtimeProvider)
    .filter((thread) => thread.workspaceFingerprint === scopeKey)
    .map((thread) => ({
    id: thread.id,
    title: thread.title,
    summary: thread.summary,
    updatedAt: thread.updatedAt,
    provider: thread.provider,
    active: thread.id === refreshedThread.id,
  } as ChatPanelThreadSummary));
  const chatContext = buildChatContext();

  return {
    baseUrl: getBaseUrl(),
    runtimeProvider,
    activeThreadId: refreshedThread.id,
    activeThreadTitle: refreshedThread.title,
    osirusChatId: refreshedThread.osirusChatId || '',
    osirusModels,
    selectedOsirusModelId: selectedOsirusModelId || refreshedThread.selectedModelId || '',
    osirusMessages: runtimeProvider === 'osirus' ? refreshedThread.messages : [],
    threads: threads.map((thread) => ({
      ...thread,
      updatedLabel: formatThreadTime(thread.updatedAt),
    })),
    messages: refreshedThread.messages,
    context: chatContext,
    activeOrgName: runtimeProvider === 'osirus' ? await getStoredOsirusActiveOrgName() : '',
    activeOrgId: runtimeProvider === 'osirus' ? await getStoredOsirusActiveOrgId() : '',
  };
}

async function pushChatPanelState(context: vscode.ExtensionContext): Promise<void> {
  if (!chatPanel) {
    return;
  }

  chatPanel.webview.postMessage({
    type: 'state',
    payload: await buildChatPanelState(context),
  });
}

async function requestOsirusJsonWithToken<T>(
  token: string,
  method: string,
  path: string,
  body?: BodyInit | Record<string, unknown>,
  init?: { headers?: Record<string, string> }
): Promise<T> {
  const url = `${getOsirusAccountApiBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(init?.headers || {}),
  };

  let finalBody: BodyInit | Record<string, unknown> | undefined;
  if (body instanceof FormData) {
    finalBody = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    finalBody = body as Record<string, unknown>;
  }

  return requestExternalJson<T>(method, url, finalBody, headers);
}

async function fetchOsirusOrgMemberships(token: string): Promise<OsirusOrgMembership[]> {
  const payload = normalizeOsirusApiData(await requestOsirusJsonWithToken<any>(token, 'GET', '/orgs'));
  const memberships = Array.isArray(payload?.memberships)
    ? payload.memberships
    : Array.isArray(payload?.results)
      ? payload.results
      : [];

  return memberships
    .map((membership: any) => ({
      id: String(membership?.id || '').trim(),
      orgId: String(membership?.orgId || membership?.org?.id || '').trim(),
      role: String(membership?.role || '').trim() || undefined,
      org: membership?.org
        ? {
            id: String(membership.org.id || membership?.orgId || '').trim(),
            name: String(membership.org.name || '').trim() || undefined,
            slug: String(membership.org.slug || '').trim() || undefined,
          }
        : undefined,
    }))
    .filter((membership: OsirusOrgMembership) => membership.orgId !== '');
}

async function getOsirusActiveOrgId(token: string): Promise<string> {
  const payload = normalizeOsirusApiData(await requestOsirusJsonWithToken<OsirusActiveOrgResponse>(token, 'GET', '/orgs/active'));
  return String(payload?.orgId || payload?.org_id || '').trim();
}

async function setOsirusActiveOrg(token: string, orgId: string): Promise<string> {
  const payload = normalizeOsirusApiData(await requestOsirusJsonWithToken<OsirusActiveOrgResponse>(
    token,
    'POST',
    '/orgs/active',
    { org_id: orgId }
  ));
  const nextAccessToken = String(payload?.accessToken || payload?.access_token || '').trim();
  const nextRefreshToken = String(payload?.refreshToken || payload?.refresh_token || '').trim();
  if (nextAccessToken && nextRefreshToken) {
    await setOsirusAuthTokens({
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
    });
    bridgeOutputChannel?.appendLine('[bridge] rotated Osirus mobile tokens after org switch');
  }
  return String(payload?.orgId || payload?.org_id || orgId).trim();
}

async function ensureOsirusActiveOrgSelection(options?: {
  promptUser?: boolean;
  tokenOverride?: string;
  preferredOrgId?: string | null;
}): Promise<{ orgId: string; orgName: string }> {
  const token = String(options?.tokenOverride || '').trim() || await getValidOsirusAccessToken();
  const memberships = await fetchOsirusOrgMemberships(token);
  if (!memberships.length) {
    await clearStoredOsirusActiveOrg();
    throw new Error('Your Osirus account does not have any active organizations yet.');
  }

  const serverActiveOrgId = await getOsirusActiveOrgId(token);
  const storedOrgId = await getStoredOsirusActiveOrgId();
  const preferredOrgId = String(options?.preferredOrgId || '').trim();

  let selectedMembership: OsirusOrgMembership | undefined;
  if (memberships.length === 1) {
    selectedMembership = memberships[0];
  } else if (options?.promptUser) {
    const currentOrgId = preferredOrgId || storedOrgId || serverActiveOrgId;
    const picked = await vscode.window.showQuickPick(
      memberships.map((membership) => ({
        label: getOsirusOrgLabel(membership),
        description: membership.role ? `Role: ${membership.role}` : undefined,
        detail: membership.orgId === currentOrgId ? 'Current active org' : membership.orgId,
        membership,
      })),
      {
        title: 'Choose Osirus Organization',
        ignoreFocusOut: true,
        placeHolder: 'Select the Osirus organization this extension should use.',
      }
    );
    if (!picked) {
      throw new Error('Osirus organization selection was canceled.');
    }
    selectedMembership = picked.membership;
  } else {
    selectedMembership =
      memberships.find((membership) => membership.orgId === preferredOrgId) ||
      memberships.find((membership) => membership.orgId === storedOrgId) ||
      memberships.find((membership) => membership.orgId === serverActiveOrgId) ||
      memberships[0];
  }

  if (!selectedMembership) {
    throw new Error('Unable to resolve an Osirus organization for this session.');
  }

  const selectedOrgId = selectedMembership.orgId;
  if (selectedOrgId && selectedOrgId !== serverActiveOrgId) {
    await setOsirusActiveOrg(token, selectedOrgId);
    bridgeOutputChannel?.appendLine(`[bridge] set active Osirus org to ${selectedOrgId}`);
  }

  const selectedOrgName = getOsirusOrgLabel(selectedMembership);
  if (bridgeContext && selectedOrgId !== storedOrgId) {
    await bridgeContext.workspaceState.update('codexBridge.osirusChatId', undefined);
  }
  await setStoredOsirusActiveOrg(selectedOrgId, selectedOrgName);
  refreshSidebar();
  return { orgId: selectedOrgId, orgName: selectedOrgName };
}

async function refreshOpenOsirusChatState(context: vscode.ExtensionContext): Promise<void> {
  if (!chatPanel || getCurrentRuntimeProvider() !== 'osirus' || !(await hasOsirusAccountSession())) {
    return;
  }
  await pushChatPanelState(context);
}

async function refreshOsirusAccessToken(): Promise<string> {
  const refreshToken = (await getOsirusRefreshToken()).trim();
  if (refreshToken === '') {
    throw new Error('No Osirus refresh token is available. Sign in again.');
  }

  let payload: OsirusMobileRefreshResponse;
  try {
    payload = await requestExternalJson<OsirusMobileRefreshResponse>(
      'POST',
      `${getOsirusAccountApiBaseUrl()}/auth/mobile/refresh`,
      { refreshToken }
    );
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    if (message.includes('422') || message.includes('401') || message.includes('403') || message.includes('invalid refresh token')) {
      await clearOsirusAuthTokens();
      if (bridgeContext) {
        await bridgeContext.workspaceState.update('codexBridge.osirusChatId', undefined);
      }
      refreshSidebar();
      try {
        return await signInToOsirusWithStoredCredentials();
      } catch (signInError) {
        throw new Error('Your Osirus.AI session expired. Sign in again from the sidebar.');
      }
    }
    throw error;
  }

  const accessToken = String(payload.access_token || '').trim();
  const nextRefreshToken = String(payload.refresh_token || '').trim();
  if (!accessToken || !nextRefreshToken) {
    throw new Error('Osirus token refresh did not return new tokens.');
  }

  await setOsirusAuthTokens({ accessToken, refreshToken: nextRefreshToken });
  try {
    await ensureOsirusActiveOrgSelection({ promptUser: false, tokenOverride: accessToken });
  } catch (error) {
    bridgeOutputChannel?.appendLine(`[bridge] Osirus org refresh warning: ${getErrorMessage(error)}`);
  }
  bridgeOutputChannel?.appendLine('[bridge] refreshed Osirus.AI account token');
  return accessToken;
}

async function signInToOsirusWithStoredCredentials(): Promise<string> {
  const email = (await getOsirusEmail()).trim();
  const password = await getOsirusPassword();
  if (!email || !password) {
    throw new Error('Stored Osirus credentials are not available. Sign in again from the sidebar.');
  }

  const baseUrl = getOsirusAccountApiBaseUrl();
  const payload = await requestExternalJson<OsirusMobileSignInResponse>(
    'POST',
    `${baseUrl}/auth/mobile/signin`,
    {
      email,
      password,
      captcha: null,
    }
  );

  const accessToken = String(payload.access_token || '').trim();
  const refreshToken = String(payload.refresh_token || '').trim();
  if (!accessToken || !refreshToken) {
    throw new Error('Osirus sign-in did not return access and refresh tokens.');
  }

  await setOsirusAuthTokens({ accessToken, refreshToken });
  try {
    await ensureOsirusActiveOrgSelection({
      promptUser: false,
      tokenOverride: accessToken,
      preferredOrgId: String(payload.active_org_id || '').trim() || null,
    });
  } catch (error) {
    bridgeOutputChannel?.appendLine(`[bridge] Osirus org restore warning: ${getErrorMessage(error)}`);
  }
  bridgeOutputChannel?.appendLine('[bridge] restored Osirus.AI session using stored credentials');
  return accessToken;
}

async function getValidOsirusAccessToken(): Promise<string> {
  const accessToken = (await getOsirusAccessToken()).trim();
  if (accessToken === '') {
    throw new Error('No Osirus access token is available. Sign in first.');
  }

  try {
    await requestExternalJson(
      'GET',
      `${getOsirusAccountApiBaseUrl()}/auth/mobile/me`,
      undefined,
      {
        'Authorization': `Bearer ${accessToken}`,
      }
    );
    return accessToken;
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    if (!message.includes('401') && !message.includes('403') && !message.includes('expired')) {
      throw error;
    }
  }

  return refreshOsirusAccessToken();
}

function normalizeOsirusApiData(payload: any): any {
  if (Array.isArray(payload)) {
    return payload.map((item) => normalizeOsirusApiData(item));
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    out[camelKey] = normalizeOsirusApiData(value);
  }
  return out;
}

async function requestOsirusJson<T>(
  method: string,
  path: string,
  body?: BodyInit | Record<string, unknown>,
  init?: { headers?: Record<string, string> }
): Promise<T> {
  const currentToken = (await getOsirusAccessToken()).trim();
  if (currentToken === '') {
    throw new Error('Sign in to Osirus.AI first.');
  }

  try {
    return await requestOsirusJsonWithToken<T>(currentToken, method, path, body, init);
  } catch (error) {
    const message = getErrorMessage(error).toLowerCase();
    if (!message.includes('401') && !message.includes('403') && !message.includes('expired')) {
      throw error;
    }
  }

  const refreshedToken = await refreshOsirusAccessToken();
  return requestOsirusJsonWithToken<T>(refreshedToken, method, path, body, init);
}

async function fetchOsirusModelOptions(): Promise<OsirusModelOption[]> {
  await ensureOsirusActiveOrgSelection({ promptUser: false });
  const productsPayload = normalizeOsirusApiData(await requestOsirusJson<any>(
    'GET',
    '/products?supports_chat=true&isPublic=true&limit=50&page=1'
  ));
  const providersPayload = normalizeOsirusApiData(await requestOsirusJson<any>(
    'GET',
    '/provider?include=my_settings&is_connected=true&has_chat=true&limit=1000&page=1'
  ));

  const options: OsirusModelOption[] = [];
  const results = Array.isArray(productsPayload?.results) ? productsPayload.results : [];
  for (const product of results) {
    const productId = String(product?.id || '').trim();
    if (!productId) {
      continue;
    }

    const modelSlug = String(product?.modelSetting?.modelSlug || product?.slug || '').trim();
    options.push({
      id: `product:${productId}`,
      label: String(product?.name || productId),
      kind: 'product',
      productId,
      modelSlug,
      providerKey: String(product?.modelSetting?.provider || '').trim() || undefined,
      hasStream: Boolean(product?.modelSetting?.hasStream),
      conversationMode: normalizeOsirusConversationMode(product?.conversation_mode) || 'chat',
      llmContent: typeof product?.llm_content === 'string' ? product.llm_content : undefined,
      generationMode: typeof product?.generation_mode === 'string' ? product.generation_mode : undefined,
      searchId: typeof product?.search_id === 'string' ? product.search_id : undefined,
      recipients: Array.isArray(product?.recipients) ? product.recipients : undefined,
    });
  }

  const providers = Array.isArray(providersPayload?.results) ? providersPayload.results : [];
  for (const provider of providers) {
    const providerKey = String(provider?.key || '').trim();
    if (!providerKey) {
      continue;
    }

    const providerLabel = String(provider?.label || provider?.name || providerKey).trim();
    const settings = Array.isArray(provider?.mySettings)
      ? provider.mySettings
      : Array.isArray(provider?.my_settings)
        ? provider.my_settings
        : [];

    for (const setting of settings) {
      const providerSettingId = String(setting?.id || '').trim();
      if (!providerSettingId) {
        continue;
      }

      const modelsPayload = normalizeOsirusApiData(await requestOsirusJson<any>(
        'GET',
        `/provider/${encodeURIComponent(providerKey)}/settings/${encodeURIComponent(providerSettingId)}/models?limit=200`
      ));
      const models = Array.isArray(modelsPayload?.models)
        ? modelsPayload.models
        : Array.isArray(modelsPayload?.results)
          ? modelsPayload.results
          : Array.isArray(modelsPayload?.data?.models)
            ? modelsPayload.data.models
            : [];

      for (const model of models) {
        const modelId = String(model?.id || model?.modelId || model?.model_id || '').trim();
        if (!modelId) {
          continue;
        }

        options.push({
          id: `provider:${providerSettingId}:${modelId}`,
          label: `${String(model?.name || modelId)} (${providerLabel})`,
          kind: 'provider',
          providerSettingId,
          modelId,
          modelSlug: String(model?.modelSlug || model?.slug || modelId).trim(),
          providerKey,
          hasStream: Boolean(model?.hasStream),
          conversationMode: normalizeOsirusConversationMode(model?.conversation_mode) || 'chat',
          llmContent: typeof model?.llm_content === 'string' ? model.llm_content : undefined,
          generationMode: typeof model?.generation_mode === 'string' ? model.generation_mode : undefined,
          searchId: typeof model?.search_id === 'string' ? model.search_id : undefined,
          recipients: Array.isArray(model?.recipients) ? model.recipients : undefined,
        });
      }
    }
  }

  const deduped = new Map<string, OsirusModelOption>();
  for (const option of options) {
    if (!deduped.has(option.id)) {
      deduped.set(option.id, option);
    }
  }

  return Array.from(deduped.values());
}

function normalizeOsirusHistoryRole(value: unknown): 'user' | 'assistant' | 'system' | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'user' || normalized === 'assistant' || normalized === 'system') {
    return normalized;
  }
  return null;
}

function extractOsirusMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((entry: any) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (typeof entry?.text === 'string') {
          return entry.text;
        }
        if (typeof entry?.content === 'string') {
          return entry.content;
        }
        return '';
      })
      .filter(Boolean);
    return parts.join('\n').trim();
  }

  if (typeof message?.text === 'string') {
    return String(message.text).trim();
  }

  return '';
}

async function fetchOsirusChatSnapshot(chatId: string): Promise<OsirusChatSnapshot> {
  const resolvedChatId = String(chatId || '').trim();
  if (!resolvedChatId || resolvedChatId === 'new') {
    return {
      chatId: resolvedChatId,
      title: '',
      messages: [],
    };
  }

  const payload = normalizeOsirusApiData(await requestOsirusJson<any>(
    'GET',
    `/chat/${encodeURIComponent(resolvedChatId)}`
  ));
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const normalizedMessages = messages
    .map((message: any) => {
      const role = normalizeOsirusHistoryRole(message?.role);
      const content = extractOsirusMessageText(message);
      const id = String(message?.id || '').trim() || `msg-${Math.random().toString(36).slice(2)}`;
      if (!role || !content) {
        return null;
      }
      return {
        id,
        role,
        content,
        productId: String(message?.productId || message?.product_id || '').trim() || undefined,
        providerSettingId: String(message?.providerSettingId || message?.provider_setting_id || '').trim() || undefined,
        modelId: String(message?.modelId || message?.model_id || '').trim() || undefined,
        modelSlug: String(message?.modelSlug || message?.model_slug || '').trim() || undefined,
      };
    })
    .filter((message: OsirusChatHistoryMessage | null): message is OsirusChatHistoryMessage => Boolean(message));

  return {
    chatId: String(payload?.id || payload?.chat?.id || resolvedChatId).trim() || resolvedChatId,
    title: String(payload?.name || payload?.chat?.name || '').trim(),
    messages: normalizedMessages,
  };
}

async function fetchOsirusChatHistory(chatId: string): Promise<OsirusChatHistoryMessage[]> {
  return (await fetchOsirusChatSnapshot(chatId)).messages;
}

async function sendOsirusChatMessage(prompt: string, modelSelectionId: string, existingChatId?: string): Promise<{ chatId: string; assistantText: string; options: OsirusModelOption[]; selectedModelId: string }> {
  const options = await fetchOsirusModelOptions();
  const matched = options.find((option) => option.id === modelSelectionId) || options[0];
  if (!matched) {
    throw new Error('No Osirus chat models are available for this account.');
  }
  const selected = preferOsirusProductOption(matched, options);

  await setSavedOsirusSelectedModelId(selected.id);

  const resolvedChatId = String(existingChatId || '').trim() || 'new';
  const formData = buildOsirusChatFormData(prompt, resolvedChatId, selected);
  bridgeOutputChannel?.appendLine(
    `[bridge] osirus send chatId=${resolvedChatId} model=${selected.id}`
  );

  const payload = normalizeOsirusApiData(await requestOsirusJson<any>(
    'POST',
    `/chat/${encodeURIComponent(resolvedChatId)}/messages?context_scope=chat`,
    formData
  ));

  const responseChatId = String(payload?.chat?.id || payload?.chatId || '').trim();
  const assistantContent = payload?.message?.content;
  const assistantText =
    typeof assistantContent === 'string'
      ? assistantContent.trim()
      : typeof payload?.message?.text === 'string'
        ? String(payload.message.text).trim()
        : '';

  if (!responseChatId) {
    throw new Error('Osirus did not return a chat id.');
  }

  if (!assistantText) {
    throw new Error('Osirus returned a chat response without assistant text.');
  }

  return {
    chatId: responseChatId,
    assistantText,
    options,
    selectedModelId: selected.id,
  };
}

function pullCompleteSseFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  while (true) {
    const unix = rest.indexOf('\n\n');
    const windows = rest.indexOf('\r\n\r\n');
    const hasUnix = unix !== -1;
    const hasWindows = windows !== -1;
    if (!hasUnix && !hasWindows) {
      break;
    }
    const useWindows = hasWindows && (!hasUnix || windows < unix);
    const idx = useWindows ? windows : unix;
    const sepLen = useWindows ? 4 : 2;
    frames.push(rest.slice(0, idx));
    rest = rest.slice(idx + sepLen);
  }
  return { frames, rest };
}

function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  const lines = frame.split(/\r?\n/);
  let eventName = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim() || 'message';
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!dataLines.length) {
    return null;
  }

  const raw = dataLines.join('\n');
  try {
    return { event: eventName, data: JSON.parse(raw) };
  } catch (error) {
    return { event: eventName, data: raw };
  }
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    carry += decoder.decode(value, { stream: true });
    const drained = pullCompleteSseFrames(carry);
    carry = drained.rest;
    for (const frame of drained.frames) {
      const parsed = parseSseFrame(frame);
      if (parsed) {
        onEvent(parsed.event, parsed.data);
      }
    }
  }

  carry += decoder.decode();
  if (carry.trim()) {
    const parsed = parseSseFrame(carry);
    if (parsed) {
      onEvent(parsed.event, parsed.data);
    }
  }
}

async function streamOsirusChatMessage(
  prompt: string,
  modelSelectionId: string,
  onDelta: (delta: string) => void,
  existingChatId?: string,
  attachments: WebviewAttachment[] = []
): Promise<{ chatId: string; assistantText: string; options: OsirusModelOption[]; selectedModelId: string }> {
  const options = await fetchOsirusModelOptions();
  const matched = options.find((option) => option.id === modelSelectionId) || options[0];
  if (!matched) {
    throw new Error('No Osirus chat models are available for this account.');
  }
  const selected = preferOsirusProductOption(matched, options);

  await setSavedOsirusSelectedModelId(selected.id);

  const resolvedChatId = String(existingChatId || '').trim() || 'new';
  const formData = buildOsirusChatFormData(prompt, resolvedChatId, selected, attachments, {
    stream: true,
  });
  bridgeOutputChannel?.appendLine(
    `[bridge] osirus stream chatId=${resolvedChatId} model=${selected.id}`
  );

  const token = await getValidOsirusAccessToken();
  const url = `${getOsirusAccountApiBaseUrl()}/chat/${encodeURIComponent(resolvedChatId)}/messages?context_scope=chat`;
  bridgeOutputChannel?.appendLine(`[bridge] -> POST ${url} body="[form-data stream]"`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${token}`,
      'x-osirus-chat-scope': 'chat',
    },
    body: formData,
  });

  if (!response.ok || !response.body) {
    const raw = await response.text();
    throw new Error(raw || `Osirus streaming chat failed with status ${response.status}.`);
  }

  let responseChatId = resolvedChatId === 'new' ? '' : resolvedChatId;
  let assistantText = '';
  await consumeSseStream(response.body, (eventName, payload) => {
    const data = normalizeOsirusApiData(payload);
    if (eventName === 'chat_created' || (eventName === 'message' && typeof data === 'object' && data && 'type' in (data as Record<string, unknown>) && (data as Record<string, unknown>).type === 'chat_created')) {
      const nextChatId = String((data as any)?.chatId || '').trim();
      if (nextChatId) {
        responseChatId = nextChatId;
      }
      return;
    }
    if (eventName === 'delta') {
      const delta = String((data as any)?.delta || '');
      if (delta) {
        assistantText += delta;
        onDelta(delta);
      }
    }
  });

  if (!responseChatId) {
    throw new Error('Osirus did not return a chat id while streaming.');
  }

  if (!assistantText.trim()) {
    throw new Error('Osirus stream ended before any assistant text was received.');
  }

  return {
    chatId: responseChatId,
    assistantText,
    options,
    selectedModelId: selected.id,
  };
}

async function ensureLocalBridgeRunning(): Promise<void> {
  if (!shouldManageLocalBridge()) {
    return;
  }

  const existingBridge = await probeBridge();
  if (existingBridge.healthOk) {
    bridgeOutputChannel?.appendLine(`[bridge] using existing bridge at ${existingBridge.baseUrl}`);
    updateStatusBar('ready');
    refreshSidebar();
    return;
  }

  if (bridgeProcess && !bridgeProcess.killed) {
    await waitForBridgeReady();
    updateStatusBar('ready');
    refreshSidebar();
    return;
  }

  updateStatusBar('starting');
  const started = await startLocalBridge(false);
  if (!started) {
    updateStatusBar('error');
    throw new Error('Unable to start local codex-bridge.');
  }

  await waitForBridgeReady();
  updateStatusBar('ready');
  refreshSidebar();
}

async function startLocalBridge(showMessage: boolean): Promise<boolean> {
  if (!isLocalBaseUrl()) {
    if (showMessage) {
      vscode.window.showWarningMessage('Local bridge management only works when codexBridge.baseUrl points to localhost or 127.0.0.1.');
    }
    return false;
  }

  if (bridgeProcess && !bridgeProcess.killed) {
    const existingProbe = await probeBridge();
    if (existingProbe.healthOk) {
      if (showMessage) {
        vscode.window.showInformationMessage('Local codex-bridge is already running.');
      }
      return true;
    }
  }

  const existingBridge = await probeBridge();
  if (existingBridge.healthOk) {
    bridgeOutputChannel?.appendLine(`[bridge] detected existing bridge at ${existingBridge.baseUrl}; skipping sidecar spawn`);
    if (showMessage) {
      vscode.window.showInformationMessage(`Using existing Codex Bridge at ${existingBridge.baseUrl}.`);
    }
    updateStatusBar('ready');
    refreshSidebar();
    return true;
  }

  if (existingBridge.socketReachable) {
    const detail = formatBridgeProbe(existingBridge);
    bridgeOutputChannel?.appendLine(`[bridge] port already in use: ${detail}`);
    updateStatusBar('error');
    if (showMessage) {
      vscode.window.showErrorMessage(detail);
    }
    return false;
  }

  const serverPath = getBridgeServerPath();
  const bridgeRoot = getBridgeRootPath();
  const port = getLocalBridgePort();
  const runtime = await resolveLocalCodexRuntime();
  const isolatedCodexHome = await getIsolatedCodexHomePath();
  const env = {
    ...process.env,
    CODEX_BRIDGE_PORT: port,
    CODEX_BRIDGE_HOST: getBaseUrlInfo().hostname,
    CODEX_BIN: runtime.command,
    CODEX_HOME: isolatedCodexHome,
  };

  bridgeOutputChannel?.appendLine(`[bridge] starting ${serverPath} on port ${port} using ${runtime.source}: ${runtime.command}`);
  bridgeOutputChannel?.appendLine(`[bridge] isolated CODEX_HOME: ${isolatedCodexHome}`);

  bridgeProcess = spawn(process.execPath, [serverPath], {
    cwd: bridgeRoot,
    env,
  });

  // Clear any stale session ID — the new bridge process has no sessions in memory
  if (bridgeContext) {
    void bridgeContext.workspaceState.update('codexBridge.sessionId', undefined);
  }

  bridgeProcess.stdout.on('data', (chunk: Buffer) => {
    bridgeOutputChannel?.append(chunk.toString());
  });

  bridgeProcess.stderr.on('data', (chunk: Buffer) => {
    bridgeOutputChannel?.append(chunk.toString());
  });

  bridgeProcess.on('exit', (code, signal) => {
    bridgeOutputChannel?.appendLine(`[bridge] exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    bridgeProcess = undefined;
    updateStatusBar('stopped');
    refreshSidebar();
  });

  bridgeProcess.on('error', (error: Error) => {
    bridgeOutputChannel?.appendLine(`[bridge] process error: ${error.message}`);
    updateStatusBar('error');
    refreshSidebar();
  });

  if (showMessage) {
    vscode.window.showInformationMessage(`Starting local codex-bridge on ${getBaseUrl()}...`);
    bridgeOutputChannel?.show(true);
  }

  return true;
}

async function stopLocalBridge(showMessage: boolean): Promise<void> {
  if (!bridgeProcess) {
    if (showMessage) {
      vscode.window.showInformationMessage('Local codex-bridge is not running.');
    }
    return;
  }

  const runningProcess = bridgeProcess;
  bridgeProcess = undefined;
  runningProcess.kill();
  updateStatusBar('stopped');
  refreshSidebar();

  if (showMessage) {
    vscode.window.showInformationMessage('Stopped local codex-bridge.');
  }
}

async function restartLocalBridge(): Promise<void> {
  await stopLocalBridge(false);
  const started = await startLocalBridge(true);
  if (!started) {
    return;
  }

  await waitForBridgeReady();
  vscode.window.showInformationMessage('Local codex-bridge restarted.');
  refreshSidebar();
}

async function waitForBridgeReady(timeoutMs = 12000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const probe = await probeBridge();
    if (probe.healthOk) {
      return;
    }

    await delay(350);
  }

  const diagnostics = await probeBridge();
  throw new Error(`Timed out waiting for Codex Bridge. ${formatBridgeProbe(diagnostics)}`);
}

async function pushRuntimeConfig(options?: { suppressErrors?: boolean; modelOverride?: string }): Promise<boolean> {
  try {
    const response = await requestJson<{ ok?: boolean }>('POST', '/runtime/config', await getRuntimeConfigPayload({
      modelOverride: options?.modelOverride,
    }));
    return response.ok === true;
  } catch (error) {
    const detail = await describeBridgeFailure(`runtime config sync failed: ${getErrorMessage(error)}`);
    bridgeOutputChannel?.appendLine(`[bridge] ${detail}`);
    if (options?.suppressErrors) {
      return false;
    }
    throw new Error(detail);
  }
}

async function waitForSessionCompletion(sessionId: string, timeoutMs = 180000): Promise<BridgeSessionRecord> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const payload = await requestJson<BridgeSessionResponse>('GET', `/chat/sessions/${encodeURIComponent(sessionId)}`, undefined, {
      timeoutMs: 5000,
      suppressLog: true,
    });
    const session = payload.session;
    if (!session) {
      throw new Error('Bridge did not return a session while waiting for completion.');
    }

    const status = String(session.status || '').toLowerCase();
    if (status === 'idle') {
      return session;
    }

    if (status === 'error') {
      throw new Error(session.last_error || 'Codex session failed.');
    }

    await delay(700);
  }

  throw new Error(`Timed out waiting for Codex reply for session ${sessionId}.`);
}

function extractAssistantTextFromSession(session: BridgeSessionRecord): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') {
      continue;
    }

    const text = String(message?.text || '').trim();
    if (text !== '') {
      return text;
    }
  }

  throw new Error('Codex finished without returning an assistant message.');
}

async function ensureSessionId(context: vscode.ExtensionContext): Promise<string> {
  const existingSessionId = context.workspaceState.get<string>('codexBridge.sessionId');
  if (existingSessionId) {
    // Validate the session still exists on the bridge (it resets on each process restart)
    try {
      const check = await requestJson<{ ok?: boolean }>('GET', `/chat/sessions/${encodeURIComponent(existingSessionId)}`);
      if (check.ok === true) {
        return existingSessionId;
      }
    } catch (error) {
      // Session gone (bridge restarted) — fall through to create a new one
    }
    await context.workspaceState.update('codexBridge.sessionId', undefined);
  }

  const payload = {
    context: buildChatContext(),
  };
  const response = await requestJson<SessionCreateResponse>('POST', '/chat/sessions', payload);
  const sessionId = extractSessionId(response);
  if (!sessionId) {
    bridgeOutputChannel?.appendLine(`[bridge] create session response missing id: ${safeJsonStringify(response)}`);
    throw new Error(response.error || 'Bridge did not return a session id.');
  }

  await context.workspaceState.update('codexBridge.sessionId', sessionId);
  return sessionId;
}

function buildChatContext(): Record<string, unknown> {
  const activeEditor = vscode.window.activeTextEditor;
  const document = activeEditor?.document;

  return {
    source: 'vscode',
    scope: 'editor',
    current_entity: {
      type: document ? 'file' : 'workspace',
      name: document ? vscode.workspace.asRelativePath(document.uri) : (vscode.workspace.name || 'Workspace'),
      path: document?.uri.fsPath || '',
      language: document?.languageId || '',
      content: document ? document.getText() : '',
    },
    active_editor: {
      title: document ? vscode.workspace.asRelativePath(document.uri) : '',
      route: document?.uri.toString() || '',
      content: document ? document.getText() : '',
    },
    open_tabs: vscode.window.tabGroups.all.flatMap((group) =>
      group.tabs.map((tab) => ({
        label: tab.label,
      }))
    ),
  };
}

async function requestJson<T>(method: string, path: string, body?: unknown, options?: RequestJsonOptions): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 12000;
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();

  if (!options?.suppressLog) {
    const summary = body === undefined ? '' : ` body=${safeJsonStringify(sanitizeForLog(body)).slice(0, 400)}`;
    bridgeOutputChannel?.appendLine(`[bridge] -> ${method} ${url}${summary}`);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutHandle);
    const message = error instanceof Error ? error.message : 'Unknown fetch failure.';
    if (!options?.suppressLog) {
      bridgeOutputChannel?.appendLine(`[bridge] request failed ${method} ${url}: ${message}`);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out contacting Codex Bridge at ${url}.`);
    }
    throw new Error(`Unable to reach Codex Bridge at ${url}: ${message}`);
  }

  clearTimeout(timeoutHandle);

  const raw = await response.text();
  const elapsedMs = Date.now() - startedAt;
  let payload: T | Record<string, unknown> = {} as T;
  if (raw) {
    try {
      payload = JSON.parse(raw) as T;
    } catch (error) {
      if (!options?.suppressLog) {
        bridgeOutputChannel?.appendLine(`[bridge] non-JSON response from ${method} ${url}: ${raw.slice(0, 500)}`);
      }
      throw new Error(`Codex Bridge returned invalid JSON for ${method} ${path}.`);
    }
  }

  if (!response.ok) {
    const errorMessage = typeof payload === 'object' && payload && 'error' in payload
      ? String((payload as Record<string, unknown>).error || 'Request failed.')
      : `Request failed with status ${response.status}.`;
    if (!options?.suppressLog) {
      bridgeOutputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms): ${errorMessage}`);
    }
    throw new Error(errorMessage);
  }

  if (!options?.suppressLog) {
    bridgeOutputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms)`);
  }

  return payload as T;
}

async function requestExternalJson<T>(
  method: string,
  url: string,
  body?: BodyInit | unknown,
  headers?: Record<string, string>
): Promise<T> {
  const startedAt = Date.now();
  const logBody = body instanceof FormData ? '[form-data]' : sanitizeForLog(body);
  bridgeOutputChannel?.appendLine(`[bridge] -> ${method} ${url}${body === undefined ? '' : ` body=${safeJsonStringify(logBody).slice(0, 300)}`}`);

  const requestHeaders = {
    'Accept': 'application/json',
    ...(headers || {}),
  } as Record<string, string>;

  let requestBody: BodyInit | undefined;
  if (body instanceof FormData) {
    requestBody = body;
  } else if (body !== undefined) {
    if (!requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: requestBody,
  });

  const raw = await response.text();
  const elapsedMs = Date.now() - startedAt;
  let payload: T | Record<string, unknown> = {} as T;
  if (raw) {
    try {
      payload = JSON.parse(raw) as T;
    } catch (error) {
      bridgeOutputChannel?.appendLine(`[bridge] non-JSON response from ${method} ${url}: ${raw.slice(0, 500)}`);
      throw new Error(`Received invalid JSON from ${url}.`);
    }
  }

  if (!response.ok) {
    const errorMessage = typeof payload === 'object' && payload && 'error' in payload
      ? String((payload as Record<string, unknown>).error || `Request failed with status ${response.status}.`)
      : `Request failed with status ${response.status}.`;
    bridgeOutputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms): ${errorMessage}`);
    throw new Error(errorMessage);
  }

  bridgeOutputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms)`);
  return payload as T;
}

async function probeBridge(timeoutMs = 1500): Promise<BridgeProbeResult> {
  const url = getBaseUrlInfo();
  const host = url.hostname;
  const port = Number.parseInt(getLocalBridgePort(), 10);
  const socketReachable = await canConnectToPort(host, port, timeoutMs);

  if (!socketReachable) {
    return {
      baseUrl: getBaseUrl(),
      host,
      port,
      socketReachable,
      healthOk: false,
      healthError: `Nothing is listening on ${host}:${port}.`,
    };
  }

  try {
    const health = await requestJson<BridgeHealthResponse>('GET', '/health', undefined, { timeoutMs, suppressLog: true });
    return {
      baseUrl: getBaseUrl(),
      host,
      port,
      socketReachable,
      healthOk: health.ok === true,
      healthError: health.ok === true ? undefined : (health.error || 'Bridge responded but did not report healthy status.'),
    };
  } catch (error) {
    return {
      baseUrl: getBaseUrl(),
      host,
      port,
      socketReachable,
      healthOk: false,
      healthError: getErrorMessage(error),
    };
  }
}

async function canConnectToPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function formatBridgeProbe(result: BridgeProbeResult): string {
  if (!result.socketReachable) {
    return `Configured bridge URL ${result.baseUrl} is not reachable because nothing is listening on ${result.host}:${result.port}.`;
  }

  if (result.healthOk) {
    return `Configured bridge URL ${result.baseUrl} is healthy.`;
  }

  return `Configured bridge URL ${result.baseUrl} accepts TCP connections, but /health did not succeed: ${result.healthError || 'Unknown bridge health failure.'}`;
}

async function describeBridgeFailure(prefix: string): Promise<string> {
  if (!isLocalBaseUrl()) {
    return prefix;
  }

  const probe = await probeBridge();
  return `${prefix}. ${formatBridgeProbe(probe)}`;
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

function extractAssistantText(payload: Record<string, unknown>): string {
  const candidates: unknown[] = [
    payload.message,
    payload.output_text,
    payload.text,
    payload.content,
    payload.reply,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return JSON.stringify(payload, null, 2);
}

function extractSessionId(payload: unknown): string {
  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue;
    }

    seen.add(current);
    const record = current as Record<string, unknown>;
    const candidates = [record.session_id, record.id, record.sessionId, record.thread_id];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate.trim();
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return '';
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return '[unserializable response payload]';
  }
}

function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (/(password|api[-_]?key|token|authorization|secret)/i.test(key)) {
      sanitized[key] = '[redacted]';
      continue;
    }

    sanitized[key] = sanitizeForLog(entry);
  }

  return sanitized;
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
  if (!bridgeStatusBarItem) {
    return;
  }

  if (!isStatusBarButtonEnabled()) {
    bridgeStatusBarItem.hide();
    return;
  }

  switch (state) {
    case 'starting':
      bridgeStatusBarItem.text = '$(sync~spin) Codex Bridge';
      bridgeStatusBarItem.tooltip = `Codex Bridge is starting at ${getBaseUrl()}`;
      break;
    case 'ready':
      bridgeStatusBarItem.text = '$(sparkle) Codex Bridge';
      bridgeStatusBarItem.tooltip = `Open Codex Bridge chat at ${getBaseUrl()}`;
      break;
    case 'stopped':
      bridgeStatusBarItem.text = '$(circle-slash) Codex Bridge';
      bridgeStatusBarItem.tooltip = 'Codex Bridge is stopped. Click to open chat and restart if auto-start is enabled.';
      break;
    case 'error':
      bridgeStatusBarItem.text = '$(warning) Codex Bridge';
      bridgeStatusBarItem.tooltip = 'Codex Bridge startup failed. Use "Codex Bridge: Show Bridge Logs" for details.';
      break;
    default:
      bridgeStatusBarItem.text = '$(sparkle) Codex Bridge';
      bridgeStatusBarItem.tooltip = 'Open Codex Bridge chat.';
      break;
  }

  bridgeStatusBarItem.show();
}

function refreshSidebar(): void {
  void sidebarProvider?.refresh();
}

function getBridgeState(): 'ready' | 'starting' | 'stopped' | 'remote' {
  if (!isLocalBaseUrl()) {
    return 'remote';
  }

  if (bridgeProcess && !bridgeProcess.killed) {
    return 'ready';
  }

  return shouldManageLocalBridge() ? 'starting' : 'stopped';
}

class CodexBridgeSidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case 'openChat':
          if (bridgeContext) {
            await openChatPanel(bridgeContext);
          }
          break;
        case 'configure':
          await configureConnection();
          break;
        case 'health':
          await checkHealth();
          break;
        case 'logs':
          bridgeOutputChannel?.show(true);
          break;
        case 'login':
          if (getCurrentRuntimeProvider() === 'osirus_agent') {
            await loginToOsirus();
          } else if (getCurrentRuntimeProvider() === 'osirus') {
            await loginToOsirusAccount();
          } else {
            await configureConnection();
          }
          break;
        case 'logout':
          if (getCurrentRuntimeProvider() === 'osirus_agent') {
            await logoutFromOsirus();
          } else if (getCurrentRuntimeProvider() === 'osirus') {
            await logoutFromOsirusAccount();
          } else {
            await setProviderApiKey('');
            vscode.window.showInformationMessage('Provider API key cleared for this extension.');
            refreshSidebar();
          }
          break;
        case 'switchOrg':
          if (getCurrentRuntimeProvider() === 'osirus') {
            const resolved = await ensureOsirusActiveOrgSelection({ promptUser: true });
            if (bridgeContext) {
              await refreshOpenOsirusChatState(bridgeContext);
            }
            vscode.window.showInformationMessage(`Switched Osirus organization to ${resolved.orgName}.`);
          }
          break;
        case 'signup':
          if (getCurrentRuntimeProvider() === 'osirus_agent' || getCurrentRuntimeProvider() === 'osirus') {
            await vscode.env.openExternal(vscode.Uri.parse(getOsirusSignupUrl()));
          } else {
            await configureConnection();
          }
          break;
        case 'apiKeys':
          if (getCurrentRuntimeProvider() === 'osirus_agent') {
            await vscode.env.openExternal(vscode.Uri.parse(getOsirusApiKeysUrl()));
          } else {
            await configureConnection();
          }
          break;
        default:
          break;
      }
    });

    this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    this.view.webview.html = await getSidebarHtml();
  }
}

async function getSidebarHtml(): Promise<string> {
  const baseUrl = escapeHtml(getBaseUrl());
  const runtimeProvider = getCurrentRuntimeProvider();
  const authMode = getCurrentAuthMode();
  const provider = escapeHtml(runtimeProvider);
  const providerDisplayName = escapeHtml(getProviderDisplayName(runtimeProvider));
  const providerIcon = escapeHtml(getProviderIcon(runtimeProvider));
  const requiresSavedApiKey = providerNeedsSavedApiKey(runtimeProvider, authMode);
  const signedIn = runtimeProvider === 'osirus'
    ? await hasOsirusAccountSession()
    : (requiresSavedApiKey ? await hasSavedApiKey() : true);
  const runtime = escapeHtml(await getLocalRuntimeSummary());
  const state = getBridgeState();
  const stateLabel = state === 'remote'
    ? 'Remote Bridge'
    : (state === 'ready' ? 'Local Bridge Ready' : (state === 'starting' ? 'Auto-Start Enabled' : 'Local Bridge Stopped'));
  const apiKeysUrl = escapeHtml(getOsirusApiKeysUrl());
  const setupSummary = escapeHtml(getProviderSetupSummary(runtimeProvider, authMode));
  const baseUrlHint = escapeHtml(getProviderBaseUrlHint(runtimeProvider));
  const activeOsirusOrgName = runtimeProvider === 'osirus' ? escapeHtml(await getStoredOsirusActiveOrgName()) : '';
  const activeOsirusOrgId = runtimeProvider === 'osirus' ? escapeHtml(await getStoredOsirusActiveOrgId()) : '';
  const loginButtonLabel = runtimeProvider === 'osirus_agent'
    ? 'Login'
    : (runtimeProvider === 'osirus' ? 'Login with Osirus' : 'Configure');
  const signupButtonLabel = runtimeProvider === 'osirus_agent' || runtimeProvider === 'osirus'
    ? 'Signup'
    : 'Connection Help';
  const readyCopy = runtimeProvider === 'osirus_agent'
    ? 'Your Osirus Agent connection is ready. Open chat to work with Codex Bridge, or clear the API key to disconnect this extension.'
    : runtimeProvider === 'osirus'
      ? 'Your Osirus.AI account is connected to this extension. Open chat to use your Osirus model picker and regular Osirus chat path.'
    : `Your ${getProviderDisplayName(runtimeProvider)} connection is ready. Open chat to work with Codex Bridge, adjust the connection, or inspect logs.`;
  const welcomeTitle = runtimeProvider === 'osirus_agent'
    ? 'Welcome to Osirus Agent'
    : `Welcome to ${getProviderDisplayName(runtimeProvider)}`;
  const setupCopy = runtimeProvider === 'osirus_agent'
    ? `Connect your Osirus account to start using Codex Bridge from VS Code. Login uses an API key. Need one first? Visit <a class="inline-link" href="${apiKeysUrl}" id="apiKeysLink">API Keys</a>.`
    : runtimeProvider === 'osirus'
      ? `Sign in with your Osirus account to use regular Osirus.AI chat in this extension. Base URL: <span class="inline-code">${baseUrlHint}</span>.`
    : `${setupSummary}${baseUrlHint ? ` Base URL: <span class="inline-code">${baseUrlHint}</span>.` : ''}`;
  const authLabel = runtimeProvider === 'osirus' && signedIn ? 'osirus_account' : authMode;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
    }
    .card {
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-editorWidget-background);
      border-radius: 14px;
      padding: 14px;
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
      color: var(--vscode-descriptionForeground);
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
      color: var(--vscode-descriptionForeground);
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
      border: 1px solid var(--vscode-input-border);
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
      color: var(--vscode-descriptionForeground);
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
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
    }
    a.inline-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .inline-code {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
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
      <div class="pill">${escapeHtml(stateLabel)}</div>
      <div class="welcome">Welcome back</div>
      <div class="copy">${escapeHtml(readyCopy)}</div>
      <div class="meta">Bridge: ${baseUrl}<br>Provider: ${provider}${runtimeProvider === 'osirus' && activeOsirusOrgName ? `<br>Org: ${activeOsirusOrgName}${activeOsirusOrgId ? ` (${activeOsirusOrgId})` : ''}` : ''}<br>Auth: ${escapeHtml(authLabel)}<br>Runtime: ${runtime}</div>
      <div class="buttons">
        <button id="openChat">Open Chat</button>
        <button id="configure" class="secondary">Configure Connection</button>
        ${runtimeProvider === 'osirus' ? `<button id="switchOrg" class="secondary">Switch Org</button>` : ''}
        ${requiresSavedApiKey || runtimeProvider === 'osirus' ? `<button id="logout" class="secondary">${runtimeProvider === 'osirus' ? 'Sign Out' : 'Clear API Key'}</button>` : ''}
        <button id="health" class="secondary">Check Health</button>
        <button id="logs" class="secondary">Show Logs</button>
      </div>
    ` : `
      <div class="pill">${escapeHtml(stateLabel)}</div>
      <div class="welcome">${escapeHtml(welcomeTitle)}</div>
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

function escapeHtml(value: string): string {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getWebviewHtml(): string {
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
      white-space: pre-wrap;
      line-height: 1.45;
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
  <div class="layout">
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
        <div id="controls" class="controls" hidden>
          <label for="modelSelect">Model</label>
          <select id="modelSelect"></select>
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
  <script>
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const statusNode = document.getElementById('status');
    const metaNode = document.getElementById('meta');
    const threadTitleNode = document.getElementById('threadTitle');
    const historyRail = document.getElementById('historyRail');
    const threadList = document.getElementById('threadList');
    const historySearch = document.getElementById('historySearch');
    const form = document.getElementById('composer');
    const prompt = document.getElementById('prompt');
    const controls = document.getElementById('controls');
    const modelSelect = document.getElementById('modelSelect');
    const attachmentList = document.getElementById('attachmentList');
    const attachmentInput = document.getElementById('attachmentInput');
    const attachButton = document.getElementById('attachButton');
    const composerNote = document.getElementById('composerNote');
    const ctxEntityName = document.getElementById('ctxEntityName');
    const ctxEntityPath = document.getElementById('ctxEntityPath');
    const ctxEntityLanguage = document.getElementById('ctxEntityLanguage');
    const ctxEditorTitle = document.getElementById('ctxEditorTitle');
    const ctxEditorRoute = document.getElementById('ctxEditorRoute');
    const ctxTabs = document.getElementById('ctxTabs');
    let runtimeProvider = 'openai';
    let activeAssistantNode = null;
    let composerAttachments = [];
    let state = {
      activeThreadId: '',
      activeThreadTitle: 'Codex Bridge',
      threads: [],
      messages: [],
      osirusChatId: '',
      osirusModels: [],
      selectedOsirusModelId: '',
      context: null,
      activeOrgName: '',
      activeOrgId: '',
      baseUrl: '',
    };

    function makeAttachmentId() {
      return 'attachment-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    }

    function escapeHtml(value) {
      return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function renderMessages(history) {
      messages.innerHTML = '';
      activeAssistantNode = null;
      for (const item of history || []) {
        const role = String(item.role || '').toLowerCase();
        const content = String(item.content || item.text || '');
        if ((role === 'user' || role === 'assistant' || role === 'system') && content.trim()) {
          appendMessage(role === 'system' ? 'assistant' : role, content);
        }
      }
    }

    function renderModelOptions(models, selectedId) {
      modelSelect.innerHTML = '';
      for (const model of models || []) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.label || model.id;
        if (model.id === selectedId) {
          option.selected = true;
        }
        modelSelect.appendChild(option);
      }
    }

    function appendMessage(role, value) {
      const node = document.createElement('div');
      node.className = 'message ' + role;
      node.textContent = value;
      messages.appendChild(node);
      messages.scrollTop = messages.scrollHeight;
      return node;
    }

    function renderComposerAttachments() {
      attachmentList.innerHTML = '';
      if (!composerAttachments.length) {
        attachmentList.classList.remove('visible');
        return;
      }

      attachmentList.classList.add('visible');
      for (const attachment of composerAttachments) {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        chip.innerHTML =
          '<span>' + escapeHtml(attachment.name || 'Attachment') + '</span>' +
          '<button type="button" data-attachment-id="' + escapeHtml(attachment.id) + '">×</button>';
        chip.querySelector('button').addEventListener('click', function() {
          composerAttachments = composerAttachments.filter(function(item) {
            return item.id !== attachment.id;
          });
          renderComposerAttachments();
        });
        attachmentList.appendChild(chip);
      }
    }

    function fileToDataUrl(file) {
      return new Promise(function(resolve, reject) {
        const reader = new FileReader();
        reader.onload = function() { resolve(String(reader.result || '')); };
        reader.onerror = function() { reject(new Error('Unable to read attachment.')); };
        reader.readAsDataURL(file);
      });
    }

    async function addSelectedAttachments(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) {
        return;
      }
      const next = [];
      for (const file of files.slice(0, 6 - composerAttachments.length)) {
        const dataUrl = await fileToDataUrl(file);
        next.push({
          id: makeAttachmentId(),
          name: String(file.name || 'attachment'),
          mimeType: String(file.type || 'application/octet-stream'),
          sizeBytes: Number(file.size || 0),
          dataUrl,
          kind: String(file.type || '').startsWith('image/') ? 'image' : 'file',
        });
      }
      composerAttachments = composerAttachments.concat(next);
      renderComposerAttachments();
    }

    function renderThreadList() {
      const filter = String(historySearch.value || '').trim().toLowerCase();
      const threads = Array.isArray(state.threads) ? state.threads : [];
      const visible = threads.filter(function(thread) {
        if (!filter) {
          return true;
        }
        const haystack = (String(thread.title || '') + ' ' + String(thread.summary || '')).toLowerCase();
        return haystack.includes(filter);
      });

      threadList.innerHTML = '';
      if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = filter ? 'No chats match that search yet.' : 'Start a new chat to build local history for this workspace.';
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

    function renderState(payload) {
      state = Object.assign({}, state, payload || {});
      runtimeProvider = String(state.runtimeProvider || 'openai');
      threadTitleNode.textContent = String(state.activeThreadTitle || 'Codex Bridge');
      metaNode.textContent =
        'Bridge: ' + String(state.baseUrl || '') +
        ' | Provider: ' + runtimeProvider +
        (runtimeProvider === 'osirus' && state.activeOrgName ? ' | Org: ' + state.activeOrgName : '');

      const osirusModels = Array.isArray(state.osirusModels) ? state.osirusModels : [];
      const selectedOsirusModelId = String(state.selectedOsirusModelId || '');
      controls.hidden = !(runtimeProvider === 'osirus' && osirusModels.length);
      attachButton.hidden = true;
      composerNote.textContent = runtimeProvider === 'osirus'
        ? 'Osirus.AI is using the bundled Codex runtime in full agent mode. Shift+Enter adds a newline.'
        : 'Stored local history for this workspace. Shift+Enter adds a newline.';
      if (!controls.hidden) {
        renderModelOptions(osirusModels, selectedOsirusModelId);
      }

      renderMessages(Array.isArray(state.messages) ? state.messages : []);
      renderThreadList();
      renderContextPanel(state.context || null);
    }

    function ensureAssistantStreamNode() {
      if (!activeAssistantNode) {
        activeAssistantNode = appendMessage('assistant', '');
      }
      return activeAssistantNode;
    }

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'state') {
        renderState(message.payload || {});
        return;
      }
      if (message.type === 'statePatch') {
        state = Object.assign({}, state, message.payload || {});
        return;
      }
      if (message.type === 'status') {
        statusNode.textContent = message.value || '';
        statusNode.classList.remove('error');
        return;
      }
      if (message.type === 'assistantMessage') {
        appendMessage('assistant', String(message.value || ''));
        return;
      }
      if (message.type === 'assistantStart') {
        activeAssistantNode = appendMessage('assistant', '');
        return;
      }
      if (message.type === 'assistantDelta') {
        const node = ensureAssistantStreamNode();
        node.textContent = String(node.textContent || '') + String(message.value || '');
        messages.scrollTop = messages.scrollHeight;
        return;
      }
      if (message.type === 'assistantDone') {
        const finalValue = String(message.value || '');
        if (activeAssistantNode) {
          activeAssistantNode.textContent = finalValue;
        } else {
          appendMessage('assistant', finalValue);
        }
        activeAssistantNode = null;
        return;
      }
      if (message.type === 'error') {
        statusNode.textContent = String(message.value || 'Unexpected error');
        statusNode.classList.add('error');
        activeAssistantNode = null;
      }
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = String(prompt.value || '').trim();
      if (!value) {
        return;
      }
      appendMessage('user', value);
      vscode.postMessage({
        type: 'sendMessage',
        prompt: value,
        modelSelectionId: runtimeProvider === 'osirus' ? String(modelSelect.value || '') : '',
        osirusChatId: String(state.osirusChatId || ''),
        attachments: runtimeProvider === 'osirus' ? composerAttachments : [],
      });
      prompt.value = '';
      composerAttachments = [];
      renderComposerAttachments();
      statusNode.textContent = 'Working...';
      statusNode.classList.remove('error');
    });

    prompt.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }

      event.preventDefault();
      form.requestSubmit();
    });

    historySearch.addEventListener('input', function() {
      renderThreadList();
    });

    document.getElementById('newThread').addEventListener('click', function() {
      vscode.postMessage({ type: 'newThread' });
    });

    document.getElementById('toggleHistory').addEventListener('click', function() {
      historyRail.classList.toggle('hidden');
    });

    document.getElementById('historyButton').addEventListener('click', function() {
      historyRail.classList.toggle('hidden');
    });

    attachButton.addEventListener('click', function() {
      attachmentInput.click();
    });

    attachmentInput.addEventListener('change', async function(event) {
      const target = event.target;
      await addSelectedAttachments(target.files);
      target.value = '';
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
