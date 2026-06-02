import { createServer } from 'node:http';
import { URL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppServerClient } from './app-server-client.mjs';
import {
  buildCorsHeaders,
  escapeHtml,
  sendEmpty,
  sendHtml,
  sendJson,
  sendSseHeaders,
  writeSse,
} from './server-lib/http.mjs';
import { buildCodexPrompt } from './server-lib/prompt.mjs';
import {
  buildCodexConfigToml,
  buildCodexEnv as buildCodexEnvValue,
  buildProxyRequestHeaders,
  buildUpstreamApiUrl,
  getRuntimeAuthState,
  normalizeRuntimeConfig as normalizeRuntimeConfigValue,
  runtimeConfigHash as runtimeConfigHashValue,
  runtimeHasDirectApiKey,
  runtimeRequiresLogin,
  summarizeRuntimeConfig as summarizeRuntimeConfigValue,
} from './server-lib/runtime-config.mjs';
import { renderCmsThinkingPage as renderCmsThinkingPageHtml, renderPage as renderLandingPageHtml } from './server-lib/pages.mjs';
import { sanitizeAttachments } from './server-lib/attachments.mjs';
import { AuthService } from './server-lib/auth-service.mjs';
import { ChatSessionService } from './server-lib/chat-session-service.mjs';
import { createBridgeRequestHandler } from './server-lib/request-handler.mjs';
const bridgeScriptDirectory = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.CODEX_BRIDGE_PORT || '4399', 10);
const host = process.env.CODEX_BRIDGE_HOST || '127.0.0.1';
const codexBin = String(process.env.CODEX_BIN || 'codex').trim() || 'codex';
const defaultWorkspaceRoot = String(process.env.CODEX_WORKSPACE_ROOT || process.cwd() || bridgeScriptDirectory).trim() || bridgeScriptDirectory;
const codexHome = process.env.CODEX_HOME || '/home/codex/.codex';
const runtimeKind = process.env.CODEX_RUNTIME_KIND || 'app_server_adapter';
const defaultLoginHint = process.env.CODEX_LOGIN_HINT || 'Connect Codex here once so your host app can open chat without setup screens.';
const loginCommand = process.env.CODEX_LOGIN_COMMAND || 'codex login';
let resolvedWorkingDirectory = null;
const bridgeTempRoot = join(tmpdir(), 'codex-bridge');
const codexConfigPath = join(codexHome, 'config.toml');
const chatTurnTimeoutMs = Number.parseInt(process.env.CODEX_CHAT_TURN_TIMEOUT_MS || '180000', 10);
const maxConcurrentTurns = Number.parseInt(process.env.CODEX_MAX_CONCURRENT_TURNS || '4', 10);
const maxQueuedTurns = Number.parseInt(process.env.CODEX_MAX_QUEUED_TURNS || '40', 10);
const loginStatusCacheTtlMs = Number.parseInt(process.env.CODEX_LOGIN_STATUS_CACHE_MS || '3000', 10);
const codexCliSandboxMode = String(process.env.CODEX_SANDBOX_MODE || 'workspace-write').trim() || 'workspace-write';
const codexAppSandboxType = codexCliSandboxMode === 'read-only' ? 'readOnly' : 'workspaceWrite';
let appServerClient = null;
let recentAppServerStderr = '';
let activeRuntimeConfig = normalizeRuntimeConfig();
let appliedRuntimeConfigHash = '';
let authService = null;
let chatSessionService = null;

function getConfiguredWorkspaceRoot() {
  return activeRuntimeConfig.workspace_root || defaultWorkspaceRoot;
}

function normalizeRuntimeConfig(payload = {}) {
  return normalizeRuntimeConfigValue(payload, {
    defaultWorkspaceRoot,
    environment: process.env,
  });
}

function runtimeConfigHash(config = activeRuntimeConfig) {
  return runtimeConfigHashValue(config, defaultWorkspaceRoot);
}

function summarizeRuntimeConfig(config = activeRuntimeConfig) {
  return summarizeRuntimeConfigValue(config, defaultWorkspaceRoot);
}

async function proxyOpenAiCompatibleRequest(request, response, requestUrl) {
  const targetUrl = buildUpstreamApiUrl(requestUrl);
  logBridge(`proxy ${summarizeRequest(request)} -> ${targetUrl || '(missing upstream url)'}`);
  if (!targetUrl) {
    return sendJson(request, response, {
      ok: false,
      error: 'No upstream OpenAI-compatible API base URL is configured for this provider.',
    }, 400);
  }

  if (activeRuntimeConfig.runtime_provider === 'openai' && runtimeRequiresLogin() && !runtimeHasDirectApiKey()) {
    return sendJson(request, response, {
      ok: false,
      error: 'The OpenAI-compatible API proxy requires direct API credentials. ChatGPT sign-in mode only supports the Codex runtime routes.',
    }, 400);
  }

  try {
    const requestBody = ['GET', 'HEAD'].includes(request.method || 'GET')
      ? null
      : await readRawBody(request);
    const upstreamResponse = await fetch(targetUrl, {
      method: request.method || 'GET',
      headers: buildProxyRequestHeaders(request),
      body: requestBody && requestBody.length ? requestBody : undefined,
      duplex: requestBody && requestBody.length ? 'half' : undefined,
    });

    const responseHeaders = {
      ...buildCorsHeaders(request),
      'Cache-Control': 'no-store',
    };
    const blockedResponseHeaders = new Set([
      'connection',
      'content-length',
      'keep-alive',
      'transfer-encoding',
    ]);

    upstreamResponse.headers.forEach((value, key) => {
      if (!blockedResponseHeaders.has(String(key).toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    response.writeHead(upstreamResponse.status, responseHeaders);

    if (!upstreamResponse.body || request.method === 'HEAD') {
      response.end();
      logBridge(`proxy complete ${summarizeRequest(request)} <- ${upstreamResponse.status} from ${targetUrl}`);
      return;
    }

    for await (const chunk of upstreamResponse.body) {
      response.write(chunk);
    }

    response.end();
    logBridge(`proxy complete ${summarizeRequest(request)} <- ${upstreamResponse.status} from ${targetUrl}`);
  } catch (error) {
    logBridge(`proxy error ${summarizeRequest(request)} -> ${targetUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return sendJson(request, response, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to proxy the OpenAI-compatible API request.',
    }, 502);
  }
}

function buildCodexEnv(config = activeRuntimeConfig) {
  return buildCodexEnvValue(config, defaultWorkspaceRoot, process.env);
}

async function restartAppServerClient() {
  if (!appServerClient) {
    return;
  }

  const existingClient = appServerClient;
  appServerClient = null;

  try {
    await existingClient.stop();
  } catch (error) {}
}

async function applyRuntimeConfig(payload = {}, options = {}) {
  const nextConfig = normalizeRuntimeConfig(payload);
  const changed = runtimeConfigHash(nextConfig) !== runtimeConfigHash(activeRuntimeConfig);
  activeRuntimeConfig = nextConfig;
  logBridge(
    `runtime config provider=${nextConfig.runtime_provider} auth=${nextConfig.auth_mode} base_url=${nextConfig.provider_api_base_url || '(default)'} model=${nextConfig.default_model || '(auto)'} workspace_root=${nextConfig.workspace_root || defaultWorkspaceRoot}`
  );

  const nextHash = runtimeConfigHash(nextConfig);
  if (nextHash !== appliedRuntimeConfigHash) {
    await mkdir(codexHome, { recursive: true });
    await writeFile(codexConfigPath, buildCodexConfigToml(nextConfig), 'utf8');
    appliedRuntimeConfigHash = nextHash;
  }

  if (changed) {
    authService?.invalidateLoginStatusCache();
    resolvedWorkingDirectory = null;
    if (options.restart !== false) {
      await restartAppServerClient();
    }
  }

  return {
    changed,
    config: summarizeRuntimeConfig(nextConfig),
  };
}

async function ensureRuntimeConfigApplied() {
  await applyRuntimeConfig(activeRuntimeConfig, { restart: false });
}

function getRuntimeInfo() {
  return {
    runtime_kind: runtimeKind,
    protocol: runtimeKind === 'app_server_adapter' ? 'json-rpc-over-stdio + rest+sse adapter' : 'rest+sse',
    codex_command: codexBin,
    codex_home: codexHome,
    sandbox_mode: codexCliSandboxMode,
    workspace_root: getConfiguredWorkspaceRoot(),
    runtime_config: summarizeRuntimeConfig(),
    bridge_load: chatSessionService?.getBridgeLoad() || {
      active_turns: 0,
      pending_turns: 0,
      max_concurrent_turns: maxConcurrentTurns,
      max_queued_turns: maxQueuedTurns,
    },
    capabilities: {
      chat_sessions: true,
      session_streaming: true,
      device_auth: true,
      cms_generation_routes: true,
      openai_compatible_routes: true,
      app_server_transport: runtimeKind === 'app_server_adapter',
      long_lived_worker: runtimeKind === 'app_server_adapter',
      concurrency_controls: true,
    },
  };
}

function normalizeGeneratedHtml(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  const fencedMatch = value.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    value = String(fencedMatch[1]).trim();
  } else if (value.startsWith('```')) {
    value = value.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  }
  value = value.replace(/^use this as .*?:\s*/i, '').trim();
  value = value.replace(/\n?if you want, i can also provide:[\s\S]*$/i, '').trim();
  return value;
}

async function readJsonBody(request) {
  const raw = (await readRawBody(request)).toString('utf8').trim();
  if (raw === '') {
    return {};
  }

  return JSON.parse(raw);
}

async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (!chunks.length) {
    return Buffer.alloc(0);
  }

  return Buffer.concat(chunks);
}


function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function recordAppServerStderr(chunk) {
  const text = String(chunk || '');
  if (!text) {
    return;
  }

  recentAppServerStderr = `${recentAppServerStderr}${text}`.slice(-4000);
  const trimmed = text.trim();
  if (trimmed) {
    console.error(`[app-server stderr] ${trimmed}`);
  }
}

function logBridge(message) {
  console.log(`[bridge] ${message}`);
}

function summarizeRequest(request) {
  return `${request.method || 'GET'} ${request.url || '/'}`;
}

async function getCodexWorkingDirectory() {
  if (resolvedWorkingDirectory) {
    return resolvedWorkingDirectory;
  }

  try {
    await access(getConfiguredWorkspaceRoot(), fsConstants.R_OK | fsConstants.X_OK);
    resolvedWorkingDirectory = getConfiguredWorkspaceRoot();
  } catch (error) {
    try {
      await access(process.cwd(), fsConstants.R_OK | fsConstants.X_OK);
      resolvedWorkingDirectory = process.cwd();
    } catch (fallbackError) {
      resolvedWorkingDirectory = bridgeScriptDirectory;
    }
  }

  return resolvedWorkingDirectory;
}

async function spawnCodex(args, options = {}) {
  await ensureRuntimeConfigApplied();
  const cwd = await getCodexWorkingDirectory();
  const allowStdin = options?.allowStdin !== false;

  return spawn(codexBin, args, {
    env: buildCodexEnv(),
    cwd,
    stdio: [allowStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

async function getAppServerClient() {
  if (runtimeKind !== 'app_server_adapter') {
    return null;
  }

  await ensureRuntimeConfigApplied();

  if (appServerClient) {
    await appServerClient.start();
    return appServerClient;
  }

  const cwd = await getCodexWorkingDirectory();
  appServerClient = new AppServerClient({
    cwd,
    env: buildCodexEnv(),
    codexCommand: codexBin,
    clientInfo: {
      name: 'codex-bridge',
      title: 'Codex Bridge',
      version: '1.0.0',
    },
  });

  appServerClient.on('notification', ({ method, params }) => {
    authService?.handleAppServerNotification(method, params);
    chatSessionService?.handleAppServerNotification(method, params);
  });

  appServerClient.on('stderr', (chunk) => {
    recordAppServerStderr(chunk);
  });

  appServerClient.on('serverRequest', (payload) => {
    void (async () => {
      const handled = await chatSessionService?.handleAppServerServerRequest(payload);
      if (handled) {
        return;
      }

      logBridge(`unsupported app-server request ${String(payload?.method || 'unknown')}`);
      try {
        await appServerClient.respondToServerRequest(payload?.id, null, {
          code: -32000,
          message: `Unsupported App Server request: ${String(payload?.method || 'unknown')}`,
        });
      } catch (_error) {}
    })();
  });

  appServerClient.on('exit', (error) => {
    if (!error) {
      return;
    }

    const stderrHint = String(recentAppServerStderr || '').trim();
    const combinedError = stderrHint && error instanceof Error && !error.message.includes(stderrHint)
      ? new Error(`${error.message}\n${stderrHint}`)
      : error;
    if (!chatSessionService) {
      return;
    }

    for (const session of chatSessionService.chatSessions.values()) {
      if (!session.running) {
        continue;
      }

      chatSessionService.completeAppServerSession(session, combinedError || new Error('Codex App Server stopped.'));
    }
  });

  await appServerClient.start();
  return appServerClient;
}

function renderPage({ contextName, contextType, contextId, loginHint, authState }) {
  return renderLandingPageHtml({
    authState,
    codexHome,
    contextId,
    contextName,
    contextType,
    escapeHtml,
    loginCommand,
    loginHint,
    workspaceRoot: getConfiguredWorkspaceRoot(),
  });
}

function renderCmsThinkingPage() {
  return renderCmsThinkingPageHtml();
}

authService = new AuthService({
  getActiveRuntimeConfig: () => activeRuntimeConfig,
  getAppServerClient,
  getRuntimeAuthState,
  loginStatusCacheTtlMs,
  runtimeHasDirectApiKey,
  runtimeKind,
  runtimeRequiresLogin,
  spawnCodex,
  stripAnsi: (value) => value.replace(/\u001b\[[0-9;]*m/g, ''),
  wait,
});

chatSessionService = new ChatSessionService({
  bridgeTempRoot,
  buildCodexPrompt,
  chatTurnTimeoutMs,
  codexAppSandboxType,
  codexCliSandboxMode,
  getAppServerClient,
  getConfiguredWorkspaceRoot,
  getRecentAppServerStderr: () => recentAppServerStderr,
  logBridge,
  maxConcurrentTurns,
  maxQueuedTurns,
  normalizeGeneratedHtml,
  runtimeKind,
  spawnCodex,
});

const requestHandler = createBridgeRequestHandler({
  applyRuntimeConfig,
  authService,
  buildCorsHeaders,
  chatSessionService,
  defaultLoginHint,
  getRuntimeAuthState,
  getRuntimeInfo,
  logBridge,
  proxyOpenAiCompatibleRequest,
  readJsonBody,
  renderCmsThinkingPage,
  renderPage,
  runtimeHasDirectApiKey,
  runtimeRequiresLogin,
  sanitizeAttachments,
  sendEmpty,
  sendHtml,
  sendJson,
  sendSseHeaders,
  summarizeRuntimeConfig,
  writeSse,
});

createServer(requestHandler).listen(port, host, () => {
  console.log(`Codex bridge listening on ${host}:${port}`);
});
