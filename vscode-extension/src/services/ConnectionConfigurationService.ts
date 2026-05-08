import * as vscode from 'vscode';
import {
  getAuthModeDisplayLabel,
  getProviderBaseUrlHint,
  getProviderDisplayName,
  getSuggestedDefaultModel,
  getSuggestedProviderApiBaseUrl,
  getSupportedAuthModes,
  providerRequiresBaseUrl,
} from '../providers';
import type { AuthMode, RuntimeProvider } from '../types';

export type ConnectionConfigurationServiceDeps = {
  ensureLocalBridgeRunning: () => Promise<void>;
  getProviderApiKey: () => Promise<string>;
  pushRuntimeConfig: (options?: { suppressErrors?: boolean; modelOverride?: string }) => Promise<boolean>;
  refreshSidebar: () => void;
  setProviderApiKey: (value: string) => Promise<void>;
  shouldManageLocalBridge: () => boolean;
};

export class ConnectionConfigurationService {
  private readonly deps: ConnectionConfigurationServiceDeps;

  public constructor(deps: ConnectionConfigurationServiceDeps) {
    this.deps = deps;
  }

  public async configure(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    const currentBaseUrl = config.get<string>('baseUrl', 'http://127.0.0.1:4400');
    const currentRuntimeProvider = config.get<RuntimeProvider>('runtimeProvider', 'openai');
    const currentAuthMode = config.get<AuthMode>('authMode', 'chatgpt');
    const currentProviderApiBaseUrl = config.get<string>('providerApiBaseUrl', '');
    const currentProviderApiKey = await this.deps.getProviderApiKey();
    const currentDefaultModel = config.get<string>('defaultModel', '');
    const currentWorkspaceRoot = config.get<string>('workspaceRoot', '');
    const currentAutoStartLocalBridge = config.get<boolean>('autoStartLocalBridge', true);
    const currentLocalCodexPath = config.get<string>('localCodexPath', '');
    const activeDocumentUri = vscode.window.activeTextEditor?.document?.uri;
    const activeWorkspaceFolder = activeDocumentUri ? vscode.workspace.getWorkspaceFolder(activeDocumentUri) : undefined;
    let baseUrl = currentBaseUrl;
    let workspaceRoot = activeWorkspaceFolder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || currentWorkspaceRoot || '';
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

        return this.isValidAbsoluteUrl(trimmed) ? null : 'Enter a valid absolute URL.';
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
          } catch (_error) {
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
    await this.deps.setProviderApiKey(providerApiKey);
    await config.update('defaultModel', defaultModel.trim(), vscode.ConfigurationTarget.Global);
    await config.update('workspaceRoot', workspaceRoot.trim(), vscode.ConfigurationTarget.Global);
    await config.update('autoStartLocalBridge', autoStartLocalBridge, vscode.ConfigurationTarget.Global);
    await config.update('localCodexPath', localCodexPath.trim(), vscode.ConfigurationTarget.Global);

    if (this.deps.shouldManageLocalBridge()) {
      await this.deps.ensureLocalBridgeRunning();
    }

    const pushed = await this.deps.pushRuntimeConfig({ suppressErrors: true });
    this.deps.refreshSidebar();
    void vscode.window.showInformationMessage(
      pushed ? 'Codex Bridge settings saved and synced to the bridge.' : 'Codex Bridge settings saved locally.'
    );
  }

  private isValidAbsoluteUrl(value: string): boolean {
    try {
      new URL(value);
      return true;
    } catch (_error) {
      return false;
    }
  }
}
