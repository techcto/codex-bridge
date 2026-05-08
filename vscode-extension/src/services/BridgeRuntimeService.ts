import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { formatBridgeProbe, probeBridge } from '../bridge/probe';
import type { BridgeProbeResult, RuntimeConfigPayload } from '../types';

export type BridgeRuntimeState = 'ready' | 'starting' | 'stopped' | 'remote';

export type LocalCodexRuntime = {
  command: string;
  source: string;
};

export type BridgeRuntimeServiceDeps = {
  getBaseUrl: () => string;
  getBaseUrlInfo: () => URL;
  getBridgeRootPath: () => string;
  getBridgeServerPath: () => string;
  getErrorMessage: (error: unknown) => string;
  getIsolatedCodexHomePath: () => Promise<string>;
  getLocalBridgePort: () => string;
  getRuntimeConfigPayload: (options?: { modelOverride?: string }) => Promise<RuntimeConfigPayload>;
  isLocalBaseUrl: () => boolean;
  onSessionReset: () => Promise<void>;
  outputChannel?: vscode.OutputChannel;
  refreshSidebar: () => void;
  requestJson: <T>(method: string, path: string, body?: unknown, options?: { suppressLog?: boolean; timeoutMs?: number }) => Promise<T>;
  resolveLocalCodexRuntime: () => Promise<LocalCodexRuntime>;
  shouldManageLocalBridge: () => boolean;
  updateStatusBar: (state: 'idle' | 'starting' | 'ready' | 'stopped' | 'error') => void;
};

export class BridgeRuntimeService {
  private readonly deps: BridgeRuntimeServiceDeps;
  private bridgeProcess: ChildProcessWithoutNullStreams | undefined;
  private bridgeState: BridgeRuntimeState = 'stopped';

  public constructor(deps: BridgeRuntimeServiceDeps) {
    this.deps = deps;
    this.bridgeState = this.deps.isLocalBaseUrl() ? 'stopped' : 'remote';
  }

  public async ensureRunning(): Promise<void> {
    if (!this.deps.shouldManageLocalBridge()) {
      this.bridgeState = this.deps.isLocalBaseUrl() ? 'stopped' : 'remote';
      return;
    }

    const existingBridge = await this.probeBridge();
    if (existingBridge.healthOk) {
      this.bridgeState = 'ready';
      this.deps.outputChannel?.appendLine(`[bridge] using existing bridge at ${existingBridge.baseUrl}`);
      this.deps.updateStatusBar('ready');
      this.deps.refreshSidebar();
      return;
    }

    if (this.bridgeProcess && !this.bridgeProcess.killed) {
      await this.waitForReady();
      this.bridgeState = 'ready';
      this.deps.updateStatusBar('ready');
      this.deps.refreshSidebar();
      return;
    }

    this.bridgeState = 'starting';
    this.deps.updateStatusBar('starting');
    const started = await this.start(false);
    if (!started) {
      this.bridgeState = 'stopped';
      this.deps.updateStatusBar('error');
      throw new Error('Unable to start local codex-bridge.');
    }

    await this.waitForReady();
    this.bridgeState = 'ready';
    this.deps.updateStatusBar('ready');
    this.deps.refreshSidebar();
  }

  public async start(showMessage: boolean): Promise<boolean> {
    if (!this.deps.isLocalBaseUrl()) {
      this.bridgeState = 'remote';
      if (showMessage) {
        void vscode.window.showWarningMessage('Local bridge management only works when codexBridge.baseUrl points to localhost or 127.0.0.1.');
      }
      return false;
    }

    if (this.bridgeProcess && !this.bridgeProcess.killed) {
      const existingProbe = await this.probeBridge();
      if (existingProbe.healthOk) {
        if (showMessage) {
          void vscode.window.showInformationMessage('Local codex-bridge is already running.');
        }
        return true;
      }
    }

    const existingBridge = await this.probeBridge();
    if (existingBridge.healthOk) {
      this.bridgeState = 'ready';
      this.deps.outputChannel?.appendLine(`[bridge] detected existing bridge at ${existingBridge.baseUrl}; skipping sidecar spawn`);
      if (showMessage) {
        void vscode.window.showInformationMessage(`Using existing Codex Bridge at ${existingBridge.baseUrl}.`);
      }
      this.deps.updateStatusBar('ready');
      this.deps.refreshSidebar();
      return true;
    }

    if (existingBridge.socketReachable) {
      this.bridgeState = 'stopped';
      const detail = formatBridgeProbe(existingBridge);
      this.deps.outputChannel?.appendLine(`[bridge] port already in use: ${detail}`);
      this.deps.updateStatusBar('error');
      if (showMessage) {
        void vscode.window.showErrorMessage(detail);
      }
      return false;
    }

    const serverPath = this.deps.getBridgeServerPath();
    const bridgeRoot = this.deps.getBridgeRootPath();
    const port = this.deps.getLocalBridgePort();
    const runtime = await this.deps.resolveLocalCodexRuntime();
    const isolatedCodexHome = await this.deps.getIsolatedCodexHomePath();
    const env = {
      ...process.env,
      CODEX_BRIDGE_PORT: port,
      CODEX_BRIDGE_HOST: this.deps.getBaseUrlInfo().hostname,
      CODEX_BIN: runtime.command,
      CODEX_HOME: isolatedCodexHome,
    };

    this.deps.outputChannel?.appendLine(`[bridge] starting ${serverPath} on port ${port} using ${runtime.source}: ${runtime.command}`);
    this.deps.outputChannel?.appendLine(`[bridge] isolated CODEX_HOME: ${isolatedCodexHome}`);
    this.bridgeState = 'starting';

    this.bridgeProcess = spawn(process.execPath, [serverPath], {
      cwd: bridgeRoot,
      env,
    });

    await this.deps.onSessionReset();

    this.bridgeProcess.stdout.on('data', (chunk: Buffer) => {
      this.deps.outputChannel?.append(chunk.toString());
    });

    this.bridgeProcess.stderr.on('data', (chunk: Buffer) => {
      this.deps.outputChannel?.append(chunk.toString());
    });

    this.bridgeProcess.on('exit', (code, signal) => {
      this.deps.outputChannel?.appendLine(`[bridge] exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.bridgeProcess = undefined;
      this.bridgeState = 'stopped';
      this.deps.updateStatusBar('stopped');
      this.deps.refreshSidebar();
    });

    this.bridgeProcess.on('error', (error: Error) => {
      this.deps.outputChannel?.appendLine(`[bridge] process error: ${error.message}`);
      this.bridgeState = 'stopped';
      this.deps.updateStatusBar('error');
      this.deps.refreshSidebar();
    });

    if (showMessage) {
      void vscode.window.showInformationMessage(`Starting local codex-bridge on ${this.deps.getBaseUrl()}...`);
      this.deps.outputChannel?.show(true);
    }

    return true;
  }

  public async stop(showMessage: boolean): Promise<void> {
    if (!this.bridgeProcess) {
      if (showMessage) {
        void vscode.window.showInformationMessage('Local codex-bridge is not running.');
      }
      return;
    }

    const runningProcess = this.bridgeProcess;
    this.bridgeProcess = undefined;
    runningProcess.kill();
    this.bridgeState = 'stopped';
    this.deps.updateStatusBar('stopped');
    this.deps.refreshSidebar();

    if (showMessage) {
      void vscode.window.showInformationMessage('Stopped local codex-bridge.');
    }
  }

  public async restart(): Promise<void> {
    await this.stop(false);
    const started = await this.start(true);
    if (!started) {
      return;
    }

    await this.waitForReady();
    void vscode.window.showInformationMessage('Local codex-bridge restarted.');
    this.deps.refreshSidebar();
  }

  public async waitForReady(timeoutMs = 12000): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const probe = await this.probeBridge();
      if (probe.healthOk) {
        return;
      }

      await this.delay(350);
    }

    const diagnostics = await this.probeBridge();
    throw new Error(`Timed out waiting for Codex Bridge. ${formatBridgeProbe(diagnostics)}`);
  }

  public async pushRuntimeConfig(options?: { suppressErrors?: boolean; modelOverride?: string }): Promise<boolean> {
    try {
      const response = await this.deps.requestJson<{ ok?: boolean }>(
        'POST',
        '/runtime/config',
        await this.deps.getRuntimeConfigPayload({ modelOverride: options?.modelOverride })
      );
      return response.ok === true;
    } catch (error) {
      const detail = await this.describeFailure(`runtime config sync failed: ${this.deps.getErrorMessage(error)}`);
      this.deps.outputChannel?.appendLine(`[bridge] ${detail}`);
      if (options?.suppressErrors) {
        return false;
      }
      throw new Error(detail);
    }
  }

  public getState(): BridgeRuntimeState {
    if (!this.deps.isLocalBaseUrl()) {
      return 'remote';
    }

    if (this.bridgeProcess && !this.bridgeProcess.killed) {
      return 'ready';
    }

    return this.bridgeState;
  }

  public async describeFailure(prefix: string): Promise<string> {
    if (!this.deps.isLocalBaseUrl()) {
      return prefix;
    }

    const probe = await this.probeBridge();
    return `${prefix}. ${formatBridgeProbe(probe)}`;
  }

  private async probeBridge(timeoutMs = 1500): Promise<BridgeProbeResult> {
    return probeBridge({
      getBaseUrl: this.deps.getBaseUrl,
      getBaseUrlInfo: this.deps.getBaseUrlInfo,
      getLocalBridgePort: this.deps.getLocalBridgePort,
      getErrorMessage: this.deps.getErrorMessage,
      requestJson: this.deps.requestJson,
    }, timeoutMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
