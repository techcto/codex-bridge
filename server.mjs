import { createServer } from 'node:http';
import { URL } from 'node:url';
import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppServerClient } from './app-server-client.mjs';
const port = Number.parseInt(process.env.CODEX_BRIDGE_PORT || '4318', 10);
const defaultWorkspaceRoot = process.env.CODEX_WORKSPACE_ROOT || '/workspace/solodev';
const codexHome = process.env.CODEX_HOME || '/home/codex/.codex';
const runtimeKind = process.env.CODEX_RUNTIME_KIND || 'app_server_adapter';
const defaultLoginHint = process.env.CODEX_LOGIN_HINT || 'Connect Codex here once so the CMS can open chat without setup screens.';
const loginCommand = process.env.CODEX_LOGIN_COMMAND || 'codex login';
let activeDeviceAuth = null;
let resolvedWorkingDirectory = null;
const chatSessions = new Map();
const threadSessionIndex = new Map();
const bridgeTempRoot = join(tmpdir(), 'codex-bridge');
const codexConfigPath = join(codexHome, 'config.toml');
const chatTurnTimeoutMs = Number.parseInt(process.env.CODEX_CHAT_TURN_TIMEOUT_MS || '180000', 10);
const loginStatusCacheTtlMs = Number.parseInt(process.env.CODEX_LOGIN_STATUS_CACHE_MS || '3000', 10);
let cachedLoginStatusSummary = null;
let loginStatusPromise = null;
let appServerClient = null;
let activeRuntimeConfig = normalizeRuntimeConfig();
let appliedRuntimeConfigHash = '';

function buildCorsHeaders(request) {
  const origin = request.headers.origin || '*';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, OpenAI-Beta, Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function sendJson(request, response, payload, statusCode = 200) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...buildCorsHeaders(request),
  });
  response.end(JSON.stringify(payload));
}

function sendSseHeaders(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    ...buildCorsHeaders(request),
  });
}

function writeSse(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendHtml(request, response, html, statusCode = 200, options = {}) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  if (options.allowFrame) {
    const defaultAncestors = `'self'`;
    const parentOrigin = String(options.parentOrigin || '').trim();
    const frameAncestors = parentOrigin
      ? `${defaultAncestors} ${parentOrigin}`
      : defaultAncestors;
    headers['Content-Security-Policy'] = `frame-ancestors ${frameAncestors};`;
  } else {
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }

  response.writeHead(statusCode, {
    ...headers,
    ...buildCorsHeaders(request),
  });
  response.end(html);
}

function sendEmpty(response, statusCode = 204) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
  });
  response.end();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stripAnsi(value) {
  return String(value || '').replaceAll(/\u001b\[[0-9;]*m/g, '');
}

function getConfiguredWorkspaceRoot() {
  return activeRuntimeConfig.workspace_root || defaultWorkspaceRoot;
}

function normalizeRuntimeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return ['openai', 'vllm', 'ollama', 'openai_compatible', 'osirus'].includes(provider) ? provider : 'openai';
}

function normalizeAuthMode(value, runtimeProvider = 'openai') {
  const authMode = String(value || '').trim().toLowerCase();
  if (['chatgpt', 'api_key', 'none'].includes(authMode)) {
    return authMode;
  }

  return runtimeProvider === 'openai' ? 'chatgpt' : 'none';
}

function normalizeRuntimeConfig(payload = {}) {
  const runtimeProvider = normalizeRuntimeProvider(payload.runtime_provider);
  const derivedAuthMode = payload.auth_mode
    ?? (runtimeProvider === 'openai' && String(process.env.OPENAI_API_KEY || '').trim() !== '' ? 'api_key' : (runtimeProvider === 'openai' ? 'chatgpt' : 'none'));
  return {
    runtime_provider: runtimeProvider,
    auth_mode: normalizeAuthMode(derivedAuthMode, runtimeProvider),
    provider_api_base_url: String(payload.provider_api_base_url || payload.base_url || process.env.CODEX_PROVIDER_API_BASE_URL || '').trim(),
    provider_api_key: String(payload.provider_api_key || process.env.CODEX_PROVIDER_API_KEY || process.env.OPENAI_API_KEY || '').trim(),
    default_model: String(payload.default_model || process.env.CODEX_DEFAULT_MODEL || '').trim(),
    workspace_root: String(payload.workspace_root || process.env.CODEX_WORKSPACE_ROOT || defaultWorkspaceRoot).trim() || defaultWorkspaceRoot,
  };
}

function runtimeConfigHash(config = activeRuntimeConfig) {
  return JSON.stringify({
    runtime_provider: config.runtime_provider || 'openai',
    auth_mode: config.auth_mode || 'chatgpt',
    provider_api_base_url: config.provider_api_base_url || '',
    provider_api_key: config.provider_api_key || '',
    default_model: config.default_model || '',
    workspace_root: config.workspace_root || defaultWorkspaceRoot,
  });
}

function runtimeRequiresLogin(config = activeRuntimeConfig) {
  return config.runtime_provider === 'openai' && config.auth_mode === 'chatgpt';
}

function runtimeHasDirectApiKey(config = activeRuntimeConfig) {
  return String(config.provider_api_key || '').trim() !== '';
}

function getRuntimeAuthState(config = activeRuntimeConfig) {
  if (runtimeRequiresLogin(config)) {
    return 'chatgpt';
  }

  if (runtimeHasDirectApiKey(config)) {
    return 'api_key';
  }

  return 'none';
}

function summarizeRuntimeConfig(config = activeRuntimeConfig) {
  return {
    runtime_provider: config.runtime_provider,
    auth_mode: config.auth_mode,
    provider_api_base_url: config.provider_api_base_url || '',
    has_provider_api_key: runtimeHasDirectApiKey(config),
    default_model: config.default_model || '',
    workspace_root: config.workspace_root || defaultWorkspaceRoot,
  };
}

function getDefaultUpstreamApiBaseUrl(config = activeRuntimeConfig) {
  if (config.runtime_provider === 'openai') {
    return 'https://api.openai.com/v1';
  }

  if (config.runtime_provider === 'ollama') {
    return 'http://127.0.0.1:11434/v1';
  }

  return '';
}

function getUpstreamApiBaseUrl(config = activeRuntimeConfig) {
  const configuredBaseUrl = String(config.provider_api_base_url || '').trim();
  const baseUrl = configuredBaseUrl || getDefaultUpstreamApiBaseUrl(config);
  if (!baseUrl) {
    return '';
  }

  try {
    const parsed = new URL(baseUrl);
    if (!parsed.pathname || parsed.pathname === '/') {
      parsed.pathname = '/v1';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    return '';
  }
}

function buildUpstreamApiUrl(requestUrl, config = activeRuntimeConfig) {
  const baseUrl = getUpstreamApiBaseUrl(config);
  if (!baseUrl) {
    return '';
  }

  const pathWithoutVersionPrefix = requestUrl.pathname === '/v1'
    ? ''
    : requestUrl.pathname.startsWith('/v1/')
      ? requestUrl.pathname.slice(3)
      : requestUrl.pathname;

  return `${baseUrl}${pathWithoutVersionPrefix}${requestUrl.search || ''}`;
}

function buildProxyRequestHeaders(request, config = activeRuntimeConfig) {
  const headers = {};
  const blockedHeaders = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'host',
    'origin',
    'referer',
    'transfer-encoding',
  ]);

  Object.entries(request.headers || {}).forEach(([key, value]) => {
    const normalizedKey = String(key || '').toLowerCase();
    if (blockedHeaders.has(normalizedKey)) {
      return;
    }

    if (Array.isArray(value)) {
      headers[key] = value.join(', ');
      return;
    }

    if (typeof value === 'string' && value.trim() !== '') {
      headers[key] = value;
    }
  });

  if (config.auth_mode === 'api_key' && runtimeHasDirectApiKey(config)) {
    headers.Authorization = `Bearer ${config.provider_api_key}`;
  }

  return headers;
}

async function proxyOpenAiCompatibleRequest(request, response, requestUrl) {
  const targetUrl = buildUpstreamApiUrl(requestUrl);
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
      return;
    }

    for await (const chunk of upstreamResponse.body) {
      response.write(chunk);
    }

    response.end();
  } catch (error) {
    return sendJson(request, response, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to proxy the OpenAI-compatible API request.',
    }, 502);
  }
}

function toTomlString(value) {
  return `"${String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function buildCodexConfigToml(config = activeRuntimeConfig) {
  const lines = [];
  const model = String(config.default_model || '').trim();
  const baseUrl = String(config.provider_api_base_url || '').trim();

  if (config.runtime_provider === 'openai') {
    lines.push('model_provider = "openai"');
    if (model) {
      lines.push(`model = ${toTomlString(model)}`);
    }

    if (config.auth_mode === 'api_key') {
      lines.push('preferred_auth_method = "apikey"');
      lines.push('');
      lines.push('[model_providers.openai]');
      lines.push('name = "OpenAI"');
      lines.push('env_key = "OPENAI_API_KEY"');
      lines.push('wire_api = "responses"');
      if (baseUrl) {
        lines.push(`base_url = ${toTomlString(baseUrl)}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }

  const providerId = config.runtime_provider === 'ollama'
    ? 'cms_ollama'
    : (config.runtime_provider === 'osirus' ? 'cms_osirus' : 'cms_local');
  const defaultBaseUrl = config.runtime_provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : '';
  lines.push(`model_provider = ${toTomlString(providerId)}`);
  if (model) {
    lines.push(`model = ${toTomlString(model)}`);
  }
  lines.push('');
  lines.push(`[model_providers.${providerId}]`);
  lines.push(`name = ${toTomlString(
    config.runtime_provider === 'ollama'
      ? 'Ollama'
      : (config.runtime_provider === 'vllm'
        ? 'vLLM'
        : (config.runtime_provider === 'osirus' ? 'Osirus.AI' : 'OpenAI Compatible'))
  )}`);
  lines.push(`base_url = ${toTomlString(baseUrl || defaultBaseUrl)}`);
  lines.push('wire_api = "responses"');
  if (config.auth_mode === 'api_key' && runtimeHasDirectApiKey(config)) {
    lines.push('env_key = "CODEX_PROVIDER_API_KEY"');
  }

  return `${lines.join('\n')}\n`;
}

function buildCodexEnv(config = activeRuntimeConfig) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_PROVIDER_API_KEY;
  env.CODEX_WORKSPACE_ROOT = config.workspace_root || defaultWorkspaceRoot;

  if (config.runtime_provider === 'openai' && config.auth_mode === 'api_key' && runtimeHasDirectApiKey(config)) {
    env.OPENAI_API_KEY = config.provider_api_key;
  } else if (config.auth_mode === 'api_key' && runtimeHasDirectApiKey(config)) {
    env.CODEX_PROVIDER_API_KEY = config.provider_api_key;
  }

  return env;
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

  const nextHash = runtimeConfigHash(nextConfig);
  if (nextHash !== appliedRuntimeConfigHash) {
    await mkdir(codexHome, { recursive: true });
    await writeFile(codexConfigPath, buildCodexConfigToml(nextConfig), 'utf8');
    appliedRuntimeConfigHash = nextHash;
  }

  if (changed) {
    invalidateLoginStatusCache();
    activeDeviceAuth = null;
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
    codex_home: codexHome,
    workspace_root: getConfiguredWorkspaceRoot(),
    runtime_config: summarizeRuntimeConfig(),
    capabilities: {
      chat_sessions: true,
      session_streaming: true,
      device_auth: true,
      cms_generation_routes: true,
      openai_compatible_routes: true,
      app_server_transport: runtimeKind === 'app_server_adapter',
      long_lived_worker: runtimeKind === 'app_server_adapter',
    },
  };
}

function summarizeContext(context = {}) {
  const current = context.current_entity || {};
  const activeEditor = context.active_editor || {};
  const selectedRegion = context.selected_region || {};
  const pageMetadata = context.page_metadata || {};
  const visualContext = context.visual_context || {};
  const openTabs = Array.isArray(context.open_tabs) ? context.open_tabs : [];
  const lines = [];

  if (context.scope) {
    lines.push(`Scope: ${context.scope}`);
  }

  if (current.name || current.path || current.route) {
    lines.push('Current entity:');
    if (current.type) lines.push(`- type: ${current.type}`);
    if (current.name) lines.push(`- name: ${current.name}`);
    if (current.id) lines.push(`- id: ${current.id}`);
    if (current.path) lines.push(`- path: ${current.path}`);
    if (current.route) lines.push(`- route: ${current.route}`);
  }

  if (current.content) {
    lines.push('Current entity content:');
    lines.push(current.content);
  }

  if (activeEditor.route || activeEditor.title || activeEditor.content) {
    lines.push('Active editor:');
    if (activeEditor.title) lines.push(`- title: ${activeEditor.title}`);
    if (activeEditor.route) lines.push(`- route: ${activeEditor.route}`);
    if (activeEditor.content) {
      lines.push('Active editor content:');
      lines.push(activeEditor.content);
    }
  }

  if (selectedRegion.dynamic_div_id || selectedRegion.object_id) {
    lines.push('Selected page region:');
    if (selectedRegion.dynamic_div_id) lines.push(`- dynamic div: ${selectedRegion.dynamic_div_id}`);
    if (selectedRegion.module_object_id) lines.push(`- module object id: ${selectedRegion.module_object_id}`);
    if (selectedRegion.object_id) lines.push(`- object id: ${selectedRegion.object_id}`);
  }

  if (Object.keys(pageMetadata).length) {
    lines.push('Page metadata and publishing context:');
    Object.entries(pageMetadata).forEach(([key, value]) => {
      if (String(value || '').trim() !== '') {
        lines.push(`- ${key}: ${value}`);
      }
    });
  }

  if (Object.keys(visualContext).length) {
    lines.push('Visible browser/editor snapshot:');
    Object.entries(visualContext).forEach(([key, value]) => {
      if (String(value || '').trim() !== '') {
        lines.push(`- ${key}:`);
        lines.push(String(value));
      }
    });
  }

  if (openTabs.length) {
    lines.push('Open tabs:');
    openTabs.slice(0, 10).forEach((tab) => {
      const title = tab.title || tab.name || 'Untitled';
      const route = tab.route || tab.url || '';
      lines.push(`- ${title}${route ? ` (${route})` : ''}`);
    });
  }

  return lines.join('\n');
}

function buildCodexPrompt({ session, message, attachments = [] }) {
  const contextSummary = summarizeContext(session.context);
  const currentType = session.context?.current_entity?.type || 'workspace';
  const autoApply = session.context?.auto_apply === true;
  const pageRules = currentType === 'page'
    ? [
        'This CMS page editor uses STML page structure plus backing asset files/modules.',
        'A page is often composed of multiple underlying files, not one single editable document.',
        'The current page content may be STML/XML page structure, not the final backing HTML file to edit directly.',
        'dynamicDiv regions are structural placeholders. For file-backed regions, real content changes belong in the underlying asset file/module content, with the STML structure kept in sync.',
        'When proposing a page change, identify the likely backing file or region to update. Do not pretend the whole page is one raw file unless the context clearly shows that.',
        'If a selected page region is present and it points to module object 2 with an object id, treat that as the backing asset file target for the edit.',
        'A page change may also require updating page metadata such as title, meta description, meta keywords, H1/content title, menu label, body attributes, header code, cache TTL, and publication state.',
        'If title, meta description, or meta keywords are blank or obviously placeholder values such as "..", ".. ..", "...", or similar filler, infer solid replacements from the visible page content, selected region, and editor context unless the user explicitly says to leave them alone.',
        'When the user asks for a page refresh, promo page, landing page update, hero update, or SEO-oriented rewrite, include improved title, meta_description, and meta_keywords in the response even if the user did not hand you exact values.',
        'Prefer concise, publishable metadata over placeholders. The user can edit later, but do not leave obviously incomplete metadata untouched when the page context gives enough signal.',
        'Use the visible browser/editor snapshot to understand what the user is actually looking at, including heading text, visible labels, DOM structure, and selected region markup.',
        'If the user asks to publish, stage, draft, or update SEO/page metadata, include those page-level changes explicitly in your answer rather than only returning content markup.',
        'For page edits, you must return one primary ```json code block with {"mode":"browser_actions","summary":"...","actions":[...]} so the CMS can update the live editor like a user would.',
        'Valid page browser actions are: set_field {field,value}, set_codemirror {field,value}, set_editor_html {target:"pageContent",value}, append_editor_html {target:"pageContent",value}, replace_selection_html {value}, set_inline_html {value}, insert_dynamic_div {position,value}.',
        'Use set_inline_html when the selected dynamicDiv is the main target and you want the CMS to update that active inline region using the same browser editing flow a user would trigger.',
        'Use set_codemirror for CodeMirror-backed fields such as headerBlock when you want to update code/config text the same way a user would.',
        'Use insert_dynamic_div to insert a new content block into or around the selected page region. Valid positions are append, prepend, before, and after.',
        'Common page field names are: title, description, content_title, meta_description, meta_keywords, menu, body_id, body_role, body_class, headerBlock, file_cache.',
        'Do not include publish as an automatic action. The user will review and click Publish manually after the page edits are applied.',
        'Do not answer with “paste this into index.stml”, “I cannot modify directly”, or other proposal-only wording for page edits. Return browser_actions instead.',
        'If the user asks to change the selected page block, return set_inline_html for that selected region whenever possible.',
      ].join('\n')
    : '';
  const focusedEntityRules = currentType !== 'workspace'
    ? 'For focused entity chats, do not answer with generic “paste this somewhere” guidance. Return the exact content for the target CMS-managed file or region whenever the target is identifiable from context.'
    : '';
  const applyRules = autoApply
    ? 'The CMS can auto-apply your response to the current focused entity. If the user asks for a concrete change, return the final replacement content for that current entity in a single primary code block, with minimal extra framing.'
    : 'Do not modify repository files directly yourself. Instead, return the exact CMS-managed content, code block, or structured file/region update the CMS should save through its authenticated API flow.';
  const attachmentNotes = attachments.length
    ? [
        'The user attached supplemental assets to this prompt.',
        ...attachments.map((attachment, index) => `Attachment ${index + 1}: ${attachment.name || `image-${index + 1}`}${attachment.mime_type ? ` (${attachment.mime_type})` : ''}`),
        'If an attached image is present, inspect it carefully and treat it as part of the user request.',
      ].join('\n')
    : '';

  return [
    'You are embedded inside the Solodev CMS as an AI coding and content assistant.',
    'The user expects a conversational response that can include code samples, implementation notes, and clickable file paths when relevant.',
    'Do not modify repository files directly from Codex.',
    applyRules,
    'Prefer discussing work in terms of CMS-managed entities and API-driven changes instead of editing raw files directly.',
    'When you mention files, always include the repo-relative path.',
    'If current context is provided, use it as the starting point for your answer.',
    focusedEntityRules,
    pageRules,
    attachmentNotes,
    contextSummary ? `CMS context:\n${contextSummary}` : '',
    `User request:\n${message}`,
  ].filter(Boolean).join('\n\n');
}

function createChatSession(payload = {}) {
  const now = Date.now();
  const sessionId = randomUUID();
  const session = {
    id: sessionId,
    threadId: '',
    status: 'idle',
    mode: payload.mode === 'entity' ? 'entity' : 'workspace',
    context: payload.context && typeof payload.context === 'object' ? payload.context : {},
    messages: [],
    events: [],
    pendingAttachments: [],
    running: false,
    lastError: null,
    subscribers: new Set(),
    createdAt: now,
    updatedAt: now,
  };

  chatSessions.set(sessionId, session);
  return session;
}

function serializeSession(session) {
  return {
    id: session.id,
    thread_id: session.threadId || null,
    status: session.status,
    mode: session.mode,
    context: session.context,
    messages: session.messages,
    events: session.events.slice(-40),
    running: session.running,
    last_error: session.lastError,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
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

function extractAssistantText(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const text = String(message?.text || '').trim();
    if (text) return text;
  }
  return '';
}

async function generateCmsPageHtml({ prompt, instruction, context = {} }) {
  const trimmedPrompt = String(prompt || '').trim();
  if (!trimmedPrompt) {
    throw new Error('Prompt is required.');
  }
  const session = createChatSession({ mode: 'workspace', context });
  const message = `${instruction}\n\nWebsite/page idea: ${trimmedPrompt}`;
  await runChatTurn(session, message);
  const assistantText = extractAssistantText(session);
  const html = normalizeGeneratedHtml(assistantText);
  if (!html || html === 'No response returned.') {
    throw new Error(session.lastError || 'Codex finished without returning HTML.');
  }
  return {
    session_id: session.id,
    html,
  };
}

function publishSession(session, eventName = 'session.updated') {
  const payload = {
    session: serializeSession(session),
  };

  session.subscribers.forEach((subscriber) => {
    try {
      writeSse(subscriber, eventName, payload);
    } catch (error) {}
  });
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

function buildExecArgs({ session, prompt, imagePaths = [] }) {
  const workspaceRoot = getConfiguredWorkspaceRoot();
  const baseArgs = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-C',
    workspaceRoot,
  ];

  if (session.threadId) {
    const resumeArgs = [...baseArgs, 'resume'];
    imagePaths.forEach((imagePath) => {
      resumeArgs.push('-i', imagePath);
    });
    return [...resumeArgs, session.threadId, prompt];
  }

  imagePaths.forEach((imagePath) => {
    baseArgs.push('-i', imagePath);
  });

  return [...baseArgs, prompt];
}

async function runChatTurn(session, message) {
  if (runtimeKind === 'app_server_adapter') {
    return runChatTurnViaAppServer(session, message);
  }

  if (session.running) {
    throw new Error('Codex is already working on this conversation.');
  }

  session.running = true;
  session.status = 'running';
  session.updatedAt = Date.now();
  session.lastError = null;
  const attachments = Array.isArray(session.pendingAttachments) ? session.pendingAttachments : [];
  session.messages.push({
    id: randomUUID(),
    role: 'user',
    text: message,
    attachments,
    created_at: Date.now(),
  });
  publishSession(session);

  const prompt = buildCodexPrompt({ session, message, attachments });
  const tempImagePaths = await materializeImageAttachments(attachments);
  const args = buildExecArgs({ session, prompt, imagePaths: tempImagePaths });
  const child = await spawnCodex(args);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let assistantText = '';
    let finished = false;
    const timeoutHandle = setTimeout(() => {
      if (finished) {
        return;
      }

      try {
        child.kill('SIGTERM');
      } catch (error) {}
    }, chatTurnTimeoutMs);

    const finish = async (error = null) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeoutHandle);
      session.running = false;
      session.updatedAt = Date.now();
      session.pendingAttachments = [];
      await cleanupTempFiles(tempImagePaths);
      if (error) {
        session.status = 'error';
        session.lastError = error.message;
        publishSession(session, 'session.error');
        reject(error);
        return;
      }

      session.status = 'idle';
      publishSession(session, 'session.completed');
      resolve(session);
    };

    const handleEvent = (event) => {
      session.events.push({
        ...event,
        received_at: Date.now(),
      });
      publishSession(session, 'session.event');

      if (event.type === 'thread.started' && event.thread_id) {
        session.threadId = event.thread_id;
      }

      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        assistantText += event.item.text || '';
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';

      lines
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          try {
            handleEvent(JSON.parse(line));
          } catch (error) {
            session.events.push({
              type: 'bridge.output',
              text: line,
              received_at: Date.now(),
            });
          }
        });
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish(error);
    });

    child.on('exit', (code) => {
      if (stdout.trim() !== '') {
        try {
          handleEvent(JSON.parse(stdout.trim()));
        } catch (error) {
          session.events.push({
            type: 'bridge.output',
            text: stdout.trim(),
            received_at: Date.now(),
          });
        }
      }

      if (code !== 0) {
        const trimmedStderr = String(stderr || '').trim();
        const timeoutError = trimmedStderr === '' && code === null
          ? `Codex timed out after ${Math.round(chatTurnTimeoutMs / 1000)} seconds.`
          : '';
        finish(new Error((trimmedStderr || timeoutError || `Codex exited with code ${code ?? 1}`).trim()));
        return;
      }

      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        text: assistantText || 'No response returned.',
        created_at: Date.now(),
      });
      publishSession(session, 'session.message');
      finish();
    });
  });
}

async function runChatTurnViaAppServer(session, message) {
  if (session.running) {
    throw new Error('Codex is already working on this conversation.');
  }

  session.running = true;
  session.status = 'running';
  session.updatedAt = Date.now();
  session.lastError = null;
  const attachments = Array.isArray(session.pendingAttachments) ? session.pendingAttachments : [];
  session.messages.push({
    id: randomUUID(),
    role: 'user',
    text: message,
    attachments,
    created_at: Date.now(),
  });
  publishSession(session);

  const prompt = buildCodexPrompt({ session, message, attachments });
  const tempImagePaths = await materializeImageAttachments(attachments);
  session.pendingTempImagePaths = tempImagePaths;
  session.assistantItems = new Map();

  return new Promise((resolve, reject) => {
    let finished = false;
    let timeoutHandle = null;
    session.pendingResolve = resolve;
    session.pendingReject = reject;

    const finishWithError = async (error) => {
      if (finished) {
        return;
      }

      finished = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      await completeAppServerSession(session, error);
    };

    timeoutHandle = setTimeout(async () => {
      if (finished) {
        return;
      }

      finished = true;

      if (session.threadId && session.activeTurnId) {
        try {
          const client = await getAppServerClient();
          await client.request('turn/interrupt', {
            threadId: session.threadId,
            turnId: session.activeTurnId,
          });
        } catch (error) {}
      }

      await completeAppServerSession(
        session,
        new Error(`Codex timed out after ${Math.round(chatTurnTimeoutMs / 1000)} seconds.`)
      );
    }, chatTurnTimeoutMs);

    (async () => {
      try {
        const client = await getAppServerClient();
        const input = [
          {
            type: 'text',
            text: prompt,
            text_elements: [],
          },
          ...tempImagePaths.map((path) => ({
            type: 'localImage',
            path,
          })),
        ];

        if (!session.threadId) {
          const threadResponse = await client.request('thread/start', {
            cwd: getConfiguredWorkspaceRoot(),
            approvalPolicy: 'never',
            sandbox: 'read-only',
            serviceName: 'solodev-cms',
            ephemeral: false,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
          });

          registerSessionThread(session, threadResponse?.thread?.id || '');
        }

        const turnResponse = await client.request('turn/start', {
          threadId: session.threadId,
          input,
          cwd: getConfiguredWorkspaceRoot(),
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'readOnly',
            access: {
              type: 'fullAccess',
            },
            networkAccess: false,
          },
        });

        session.activeTurnId = turnResponse?.turn?.id || session.activeTurnId || null;
      } catch (error) {
        await finishWithError(error instanceof Error ? error : new Error('Codex App Server turn failed.'));
      }
    })();
  });
}

function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter((attachment) => attachment && typeof attachment === 'object')
    .map((attachment) => ({
      name: String(attachment.name || 'attachment').slice(0, 255),
      mime_type: String(attachment.mime_type || ''),
      kind: String(attachment.kind || 'file'),
      data_url: String(attachment.data_url || ''),
      size_bytes: Number(attachment.size_bytes || 0),
    }))
    .filter((attachment) => attachment.data_url);
}

function inferImageExtension(mimeType = '') {
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return '.jpg';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('gif')) return '.gif';
  return '.png';
}

async function materializeImageAttachments(attachments = []) {
  const images = attachments.filter((attachment) => attachment.kind === 'image' && attachment.data_url.startsWith('data:'));
  if (!images.length) {
    return [];
  }

  await mkdir(bridgeTempRoot, { recursive: true });
  const paths = [];

  for (const attachment of images) {
    const commaIndex = attachment.data_url.indexOf(',');
    if (commaIndex === -1) {
      continue;
    }

    const encoded = attachment.data_url.slice(commaIndex + 1);
    const buffer = Buffer.from(encoded, 'base64');
    const extension = extname(attachment.name || '') || inferImageExtension(attachment.mime_type);
    const filePath = join(bridgeTempRoot, `${randomUUID()}${extension}`);
    await writeFile(filePath, buffer);
    paths.push(filePath);
  }

  return paths;
}

async function cleanupTempFiles(paths = []) {
  await Promise.all(paths.map(async (filePath) => {
    try {
      await rm(filePath, { force: true });
    } catch (error) {}
  }));
}

function getDeviceAuthState() {
  if (!activeDeviceAuth) {
    return null;
  }

  return {
    verification_url: activeDeviceAuth.verificationUrl,
    user_code: activeDeviceAuth.userCode,
    status: activeDeviceAuth.status,
    issued_at: activeDeviceAuth.issuedAt,
    expires_in_minutes: 15,
    error: activeDeviceAuth.error || null,
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function invalidateLoginStatusCache() {
  cachedLoginStatusSummary = null;
  loginStatusPromise = null;
}

async function getCodexWorkingDirectory() {
  if (resolvedWorkingDirectory) {
    return resolvedWorkingDirectory;
  }

  try {
    await access(getConfiguredWorkspaceRoot(), fsConstants.R_OK | fsConstants.X_OK);
    resolvedWorkingDirectory = getConfiguredWorkspaceRoot();
  } catch (error) {
    resolvedWorkingDirectory = '/opt/codex-bridge';
  }

  return resolvedWorkingDirectory;
}

async function spawnCodex(args) {
  await ensureRuntimeConfigApplied();
  const cwd = await getCodexWorkingDirectory();

  return spawn('codex', args, {
    env: buildCodexEnv(),
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
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
    clientInfo: {
      name: 'solodev-cms-codex-bridge',
      title: 'Solodev CMS Codex Bridge',
      version: '1.0.0',
    },
  });

  appServerClient.on('notification', ({ method, params }) => {
    handleAppServerNotification(method, params);
  });

  appServerClient.on('exit', (error) => {
    chatSessions.forEach((session) => {
      if (!session.running) {
        return;
      }

      completeAppServerSession(session, error || new Error('Codex App Server stopped.'));
    });
  });

  await appServerClient.start();
  return appServerClient;
}

function registerSessionThread(session, threadId) {
  if (!threadId) {
    return;
  }

  session.threadId = threadId;
  threadSessionIndex.set(threadId, session);
}

function appendSessionEvent(session, event) {
  session.events.push({
    ...event,
    received_at: Date.now(),
  });
  session.events = session.events.slice(-120);
  publishSession(session, 'session.event');
}

function getAssistantDraft(session) {
  if (!(session.assistantItems instanceof Map)) {
    return '';
  }

  return Array.from(session.assistantItems.values()).join('');
}

async function completeAppServerSession(session, error = null) {
  if (!session) {
    return;
  }

  if (!session.running && !session.pendingResolve && !session.pendingReject) {
    return;
  }

  const tempImagePaths = Array.isArray(session.pendingTempImagePaths) ? session.pendingTempImagePaths : [];
  session.pendingTempImagePaths = [];
  await cleanupTempFiles(tempImagePaths);

  session.running = false;
  session.updatedAt = Date.now();
  session.pendingAttachments = [];
  session.activeTurnId = null;

  if (error) {
    session.status = 'error';
    session.lastError = error.message;
    session.assistantItems = new Map();
    publishSession(session, 'session.error');
    if (typeof session.pendingReject === 'function') {
      session.pendingReject(error);
    }
    session.pendingResolve = null;
    session.pendingReject = null;
    return;
  }

  const assistantText = getAssistantDraft(session).trim() || 'No response returned.';
  session.assistantItems = new Map();
  session.messages.push({
    id: randomUUID(),
    role: 'assistant',
    text: assistantText,
    created_at: Date.now(),
  });
  session.status = 'idle';
  publishSession(session, 'session.message');
  publishSession(session, 'session.completed');
  if (typeof session.pendingResolve === 'function') {
    session.pendingResolve(session);
  }
  session.pendingResolve = null;
  session.pendingReject = null;
}

function handleAppServerNotification(method, params = {}) {
  if (method === 'account/login/completed') {
    if (activeDeviceAuth && (!activeDeviceAuth.loginId || activeDeviceAuth.loginId === params.loginId)) {
      activeDeviceAuth.status = params.success ? 'complete' : 'error';
      activeDeviceAuth.error = params.success ? null : (params.error || 'Device authentication failed.');
      activeDeviceAuth.exited = true;
      invalidateLoginStatusCache();
    }
    return;
  }

  const threadId = params.threadId || params.thread?.id || null;
  if (!threadId) {
    return;
  }

  const session = threadSessionIndex.get(threadId);
  if (!session) {
    return;
  }

  if (method === 'thread/started') {
    registerSessionThread(session, params.thread?.id || '');
    appendSessionEvent(session, {
      type: 'thread.started',
      thread_id: params.thread?.id || '',
      preview: params.thread?.preview || '',
    });
    return;
  }

  if (method === 'thread/status/changed') {
    const statusType = params.status?.type || '';
    session.status = statusType === 'systemError' ? 'error' : (statusType === 'active' ? 'running' : 'idle');
    session.running = statusType === 'active';
    session.updatedAt = Date.now();
    appendSessionEvent(session, {
      type: 'thread.status.changed',
      preview: statusType,
    });
    return;
  }

  if (method === 'turn/started') {
    session.running = true;
    session.status = 'running';
    session.activeTurnId = params.turn?.id || null;
    appendSessionEvent(session, {
      type: 'turn.started',
      turn_id: params.turn?.id || '',
    });
    return;
  }

  if (method === 'item/agentMessage/delta') {
    if (!(session.assistantItems instanceof Map)) {
      session.assistantItems = new Map();
    }

    const existing = session.assistantItems.get(params.itemId) || '';
    session.assistantItems.set(params.itemId, existing + (params.delta || ''));
    appendSessionEvent(session, {
      type: 'item.agent_message.delta',
      preview: String(params.delta || '').trim().slice(0, 180),
    });
    return;
  }

  if (method === 'item/completed') {
    const item = params.item || {};
    if (item.type === 'agentMessage') {
      if (!(session.assistantItems instanceof Map)) {
        session.assistantItems = new Map();
      }

      session.assistantItems.set(item.id, item.text || session.assistantItems.get(item.id) || '');
      appendSessionEvent(session, {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: item.text || '',
        },
      });
      return;
    }

    appendSessionEvent(session, {
      type: 'item.completed',
      preview: item.type || 'item',
      item: {
        type: item.type || 'item',
        text: item.command || item.text || item.query || '',
      },
    });
    return;
  }

  if (method === 'turn/plan/updated') {
    appendSessionEvent(session, {
      type: 'turn.plan.updated',
      preview: params.explanation || '',
      plan: params.plan || [],
    });
    return;
  }

  if (method === 'turn/completed') {
    if (params.turn?.status === 'failed') {
      completeAppServerSession(session, new Error(params.turn?.error?.message || 'Codex turn failed.'));
      return;
    }

    appendSessionEvent(session, {
      type: 'turn.completed',
      turn_id: params.turn?.id || '',
    });
    completeAppServerSession(session);
    return;
  }

  if (method === 'item/commandExecution/outputDelta') {
    appendSessionEvent(session, {
      type: 'command.execution.output',
      text: String(params.delta || '').trim().slice(0, 400),
    });
  }
}

function ensureDeviceAuth() {
  if (!runtimeRequiresLogin()) {
    return Promise.resolve({
      verification_url: '',
      user_code: '',
      status: 'complete',
      issued_at: Date.now(),
      expires_in_minutes: 0,
      error: null,
    });
  }

  if (runtimeKind === 'app_server_adapter') {
    return ensureDeviceAuthViaAppServer();
  }

  if (activeDeviceAuth && ['pending', 'ready'].includes(activeDeviceAuth.status)) {
    return activeDeviceAuth.promise;
  }

  invalidateLoginStatusCache();

  activeDeviceAuth = {
    status: 'pending',
    verificationUrl: '',
    userCode: '',
    issuedAt: Date.now(),
    error: null,
    child: null,
    promise: null,
  };

  activeDeviceAuth.promise = (async () => {
    const child = await spawnCodex(['login', '--device-auth']);

    return new Promise((resolve, reject) => {
      activeDeviceAuth.child = child;
      activeDeviceAuth.exited = false;
      let stdout = '';
      let stderr = '';
      let resolved = false;

      const maybeResolve = () => {
        const cleanStdout = stripAnsi(stdout);
        const urlMatch = cleanStdout.match(/https:\/\/auth\.openai\.com\/codex\/device/);
        const codeMatch = cleanStdout.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/);

        if (urlMatch && codeMatch && !resolved) {
          resolved = true;
          activeDeviceAuth.status = 'ready';
          activeDeviceAuth.verificationUrl = urlMatch[0];
          activeDeviceAuth.userCode = codeMatch[0];
          resolve(getDeviceAuthState());
        }
      };

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        maybeResolve();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('exit', (code) => {
        activeDeviceAuth.exited = true;
        if (!resolved) {
          activeDeviceAuth.status = 'error';
          activeDeviceAuth.error = (stderr || stdout || `Device auth exited with code ${code ?? 0}`).trim();
          reject(new Error(activeDeviceAuth.error));
          return;
        }

        activeDeviceAuth.status = code === 0 ? 'complete' : 'ready';
      });

      child.on('error', (error) => {
        activeDeviceAuth.exited = true;
        activeDeviceAuth.status = 'error';
        activeDeviceAuth.error = error.message;
        reject(error);
      });
    });
  })();

  return activeDeviceAuth.promise;
}

async function ensureDeviceAuthViaAppServer() {
  if (activeDeviceAuth && ['pending', 'ready'].includes(activeDeviceAuth.status)) {
    return activeDeviceAuth.promise;
  }

  invalidateLoginStatusCache();

  activeDeviceAuth = {
    status: 'pending',
    verificationUrl: '',
    userCode: '',
    issuedAt: Date.now(),
    error: null,
    child: null,
    promise: null,
    loginId: null,
    exited: false,
  };

  activeDeviceAuth.promise = (async () => {
    const client = await getAppServerClient();
    const payload = await client.request('account/login/start', {
      type: 'chatgptDeviceCode',
    });

    if (!payload || payload.type !== 'chatgptDeviceCode') {
      throw new Error('Codex App Server did not return a device-code login flow.');
    }

    activeDeviceAuth.status = 'ready';
    activeDeviceAuth.verificationUrl = payload.verificationUrl || '';
    activeDeviceAuth.userCode = payload.userCode || '';
    activeDeviceAuth.loginId = payload.loginId || null;
    return getDeviceAuthState();
  })();

  return activeDeviceAuth.promise;
}

async function finishPendingDeviceAuth() {
  if (runtimeKind === 'app_server_adapter') {
    return false;
  }

  if (!activeDeviceAuth?.child || activeDeviceAuth.exited) {
    return false;
  }

  try {
    invalidateLoginStatusCache();
    activeDeviceAuth.child.stdin.write('\n');
    await wait(1200);
    return true;
  } catch (error) {
    return false;
  }
}

async function loadLoginStatusSummary() {
  if (!runtimeRequiresLogin()) {
    if (activeRuntimeConfig.auth_mode === 'api_key' && !runtimeHasDirectApiKey()) {
      return {
        logged_in: false,
        auth_mode: 'api_key',
        message: 'Direct API mode is selected but no provider API key is configured.',
      };
    }

    return {
      logged_in: true,
      auth_mode: getRuntimeAuthState(),
      message: activeRuntimeConfig.auth_mode === 'none'
        ? 'No login required for this runtime provider.'
        : 'Direct API mode active',
    };
  }

  if (runtimeKind === 'app_server_adapter') {
    const client = await getAppServerClient();
    const result = await client.request('account/read', {
      refreshToken: false,
    });
    const account = result?.account || null;

    if (!account) {
      return {
        logged_in: false,
        auth_mode: 'chatgpt',
        message: 'Not logged in',
      };
    }

    if (account.type === 'apiKey') {
      return {
        logged_in: true,
        auth_mode: 'api_key',
        message: 'API key mode active',
      };
    }

    return {
      logged_in: true,
      auth_mode: 'chatgpt',
      message: account.email ? `Logged in as ${account.email}` : 'ChatGPT sign-in active',
    };
  }

  const result = await (async () => {
    const child = await spawnCodex(['login', 'status']);

    return new Promise((resolve) => {
      let output = '';

      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });

      child.on('exit', (code) => {
        resolve({
          code: code ?? 1,
          output: output.trim(),
        });
      });

      child.on('error', (error) => {
        resolve({
          code: 1,
          output: error.message,
        });
      });
    });
  })();

  return {
    logged_in: result.code === 0 && !/not logged in/i.test(result.output),
    auth_mode: 'chatgpt',
    message: result.output || 'Unknown login status',
  };
}

async function getLoginStatus({ force = false } = {}) {
  if (!runtimeRequiresLogin()) {
    return {
      ...(await loadLoginStatusSummary()),
      device_auth: getDeviceAuthState(),
    };
  }

  const now = Date.now();
  if (!force && cachedLoginStatusSummary && cachedLoginStatusSummary.expiresAt > now) {
    return {
      ...cachedLoginStatusSummary.value,
      device_auth: getDeviceAuthState(),
    };
  }

  if (!force && loginStatusPromise) {
    const value = await loginStatusPromise;
    return {
      ...value,
      device_auth: getDeviceAuthState(),
    };
  }

  loginStatusPromise = loadLoginStatusSummary()
    .then((value) => {
      cachedLoginStatusSummary = {
        value,
        expiresAt: Date.now() + loginStatusCacheTtlMs,
      };
      loginStatusPromise = null;
      return value;
    })
    .catch((error) => {
      loginStatusPromise = null;
      throw error;
    });

  const value = await loginStatusPromise;
  return {
    ...value,
    device_auth: getDeviceAuthState(),
  };
}

async function getLoginStatusWithFinalize() {
  let loginStatus = await getLoginStatus();

  if (!loginStatus.logged_in && activeDeviceAuth?.status === 'ready') {
    await finishPendingDeviceAuth();
    loginStatus = await getLoginStatus({ force: true });
  }

  return loginStatus;
}

function renderPage({ contextName, contextType, contextId, loginHint, authState }) {
  const subtitle = contextName
    ? `${contextType} #${contextId}: ${contextName}`
    : 'OpenAI Codex sidecar is ready for the CMS.';

  const authBadge = authState === 'api_key'
    ? 'API key detected'
    : 'ChatGPT sign-in mode';

  const authHelp = authState === 'api_key'
    ? 'This container can answer requests with the configured OpenAI API key.'
    : 'Use the CMS provider connection flow to start ChatGPT sign-in for the official Codex CLI.';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f4f6;
      --panel: #ffffff;
      --line: #d7dbe2;
      --text: #1f2937;
      --muted: #64748b;
      --accent: #2563eb;
      --good: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%);
      color: var(--text);
    }
    .shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1rem;
    }
    .hero, .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
    }
    .hero {
      padding: 1rem 1rem 1.1rem;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 0.76rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 0.5rem;
    }
    h1 {
      margin: 0 0 0.35rem;
      font-size: 1.15rem;
      line-height: 1.2;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
    }
    .card {
      padding: 1rem;
    }
    .label {
      font-size: 0.82rem;
      color: var(--muted);
      margin-bottom: 0.35rem;
    }
    .value {
      font-weight: 600;
      word-break: break-word;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.35rem 0.6rem;
      border-radius: 999px;
      background: rgba(15, 118, 110, 0.08);
      color: var(--good);
      font-size: 0.82rem;
      font-weight: 600;
      margin-top: 0.75rem;
    }
    .status-dot {
      width: 0.55rem;
      height: 0.55rem;
      border-radius: 999px;
      background: currentColor;
    }
    .commands {
      margin-top: 0.85rem;
      padding: 0.85rem;
      border-radius: 12px;
      background: #0f172a;
      color: #e2e8f0;
      overflow-x: auto;
      font-size: 0.86rem;
    }
    .commands code {
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="eyebrow">OpenAI Codex</div>
      <h1>Codex sidecar is available in the CMS</h1>
      <p>${escapeHtml(subtitle)}</p>
      <div class="status">
        <span class="status-dot"></span>
        ${escapeHtml(authBadge)}
      </div>
    </section>

    <section class="grid">
      <article class="card">
        <div class="label">Workspace</div>
        <div class="value">${escapeHtml(getConfiguredWorkspaceRoot())}</div>
      </article>
      <article class="card">
        <div class="label">Codex Home</div>
        <div class="value">${escapeHtml(codexHome)}</div>
      </article>
      <article class="card">
        <div class="label">Authentication</div>
        <div class="value">${escapeHtml(authHelp)}</div>
      </article>
    </section>

    <section class="card">
      <div class="label">Next Step</div>
      <div class="value">${escapeHtml(loginHint)}</div>
      <div class="commands"><code>${escapeHtml(loginCommand)}</code></div>
    </section>
  </div>
</body>
</html>`;
}

function renderCmsThinkingPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Thinking</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111827;
      color: #e5e7eb;
      font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 16px;
    }
    .card {
      width: min(560px, 100%);
      background: #1f2937;
      border: 1px solid #374151;
      border-radius: 12px;
      box-shadow: 0 16px 32px rgba(0, 0, 0, 0.35);
      padding: 18px;
    }
    .title {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 10px;
      font-size: 19px;
      font-weight: 600;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid #6b7280;
      border-top-color: #ffffff;
      animation: spin 0.9s linear infinite;
    }
    .status {
      color: #cbd5e1;
      font-size: 14px;
      min-height: 20px;
      margin-bottom: 10px;
    }
    .events {
      border: 1px solid #374151;
      border-radius: 10px;
      background: #111827;
      color: #93c5fd;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      max-height: 220px;
      overflow: auto;
      padding: 10px 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="title"><span class="spinner" aria-hidden="true"></span><span>Codex Thinking...</span></h1>
    <div class="status" id="status">Waiting for request from CMS...</div>
    <div class="events" id="events"></div>
  </div>
  <script>
    const statusEl = document.getElementById('status');
    const eventsEl = document.getElementById('events');
    let running = false;

    function setStatus(text) {
      statusEl.textContent = String(text || '');
      window.parent.postMessage({ type: 'codex_thinking_status', status: String(text || '') }, '*');
    }

    function pushEvent(text) {
      const eventText = String(text || '').trim();
      if (!eventText) return;
      const line = '[' + new Date().toLocaleTimeString() + '] ' + eventText;
      eventsEl.textContent += (eventsEl.textContent ? '\\n' : '') + line;
      eventsEl.scrollTop = eventsEl.scrollHeight;
      window.parent.postMessage({ type: 'codex_thinking_event', event: eventText }, '*');
    }

    function normalizeGeneratedHtml(raw) {
      let value = String(raw || '').trim();
      if (!value) return '';
      const fence = String.fromCharCode(96, 96, 96);
      const lower = value.toLowerCase();
      const firstFence = value.indexOf(fence);
      const secondFence = firstFence >= 0 ? value.indexOf(fence, firstFence + fence.length) : -1;
      if (firstFence >= 0 && secondFence > firstFence) {
        let inner = value.slice(firstFence + fence.length, secondFence).trim();
        if (inner.toLowerCase().startsWith('html')) {
          inner = inner.slice(4).trim();
        }
        value = inner;
      } else if (lower.startsWith(fence)) {
        value = value.slice(fence.length).trim();
        if (value.toLowerCase().startsWith('html')) {
          value = value.slice(4).trim();
        }
        if (value.endsWith(fence)) {
          value = value.slice(0, -fence.length).trim();
        }
      }
      const lowerValue = value.toLowerCase();
      if (lowerValue.startsWith('use this as ')) {
        const firstColon = value.indexOf(':');
        if (firstColon >= 0) {
          value = value.slice(firstColon + 1).trim();
        }
      }
      const tailMarker = '\\nif you want, i can also provide:';
      const markerIndex = value.toLowerCase().indexOf(tailMarker.trim());
      if (markerIndex >= 0) {
        value = value.slice(0, markerIndex).trim();
      }
      return value;
    }

    function extractAssistantText(session) {
      const messages = Array.isArray(session && session.messages) ? session.messages : [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'assistant') continue;
        const text = String(message.text || '').trim();
        if (text && text.toLowerCase() !== 'no response returned.') return text;
      }
      return '';
    }

    async function runTurn(payload) {
      if (running) return;
      running = true;
      try {
        const mode = String(payload.mode || '').trim();
        const prompt = String(payload.prompt || '').trim();
        const kind = String(payload.kind || '').trim();
        const schemaFields = Array.isArray(payload.schema_fields) ? payload.schema_fields : [];
        if (!prompt) throw new Error('Missing prompt.');

        setStatus('Creating Codex session...');
        const createResp = await fetch('/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ mode: 'workspace', context: {} }),
        });
        const createPayload = await createResp.json();
        const sessionId = String(createPayload?.session?.id || '');
        if (!createResp.ok || !sessionId) {
          throw new Error(String(createPayload?.error || 'Unable to create session.'));
        }
        pushEvent('Session started: ' + sessionId);

        let message = '';
        if (mode === 'add-module') {
          message = [
            'Create Bootstrap form-template HTML for this CMS module.',
            'Return only final HTML (no markdown, no commentary).',
            'Use schema field names exactly as provided for form controls.',
            'Module kind: ' + kind,
            'Module idea: ' + prompt,
            'Schema fields JSON: ' + JSON.stringify(schemaFields),
          ].join('\\n\\n');
        } else if (mode === 'add-form') {
          message = [
            (kind === 'signup'
              ? 'Create a Bootstrap form-template HTML for a signup form.'
              : 'Create a Bootstrap form-template HTML for a contact form.'),
            'Return only final HTML (no markdown, no commentary).',
            'Form idea: ' + prompt,
          ].join('\\n\\n');
        } else {
          message = [
            (kind === 'landing'
              ? 'Create a Bootstrap homepage HTML for this website idea and include a clear how-to-play style section for a lead form embed.'
              : 'Create a Bootstrap homepage HTML for this website idea.'),
            'Return only final HTML (no markdown, no commentary).',
            'Website idea: ' + prompt,
          ].join('\\n\\n');
        }

        setStatus('Sending prompt to Codex...');
        const sendResp = await fetch('/chat/sessions/' + encodeURIComponent(sessionId) + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ message }),
        });
        const sendPayload = await sendResp.json();
        if (!sendResp.ok || sendPayload?.ok === false) {
          throw new Error(String(sendPayload?.error || 'Unable to send prompt.'));
        }
        pushEvent('Prompt accepted.');

        setStatus('Codex is thinking...');
        const startedAt = Date.now();
        while ((Date.now() - startedAt) < 240000) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const pollResp = await fetch('/chat/sessions/' + encodeURIComponent(sessionId), {
            headers: { 'Accept': 'application/json' },
          });
          const pollPayload = await pollResp.json();
          const session = pollPayload?.session || {};
          const status = String(session?.status || '');

          if (status === 'error') {
            throw new Error(String(session?.last_error || 'Codex returned an error.'));
          }

          const events = Array.isArray(session?.events) ? session.events : [];
          if (events.length > 0) {
            const lastEvent = events[events.length - 1];
            const eventText = String(lastEvent?.preview || lastEvent?.text || '').trim();
            if (eventText) pushEvent(eventText);
          }

          if (status === 'idle') {
            const html = normalizeGeneratedHtml(extractAssistantText(session));
            if (!html) {
              throw new Error('Codex finished without returning HTML.');
            }
            setStatus('Complete.');
            window.parent.postMessage({
              type: 'codex_thinking_complete',
              mode,
              session_id: sessionId,
              html,
            }, '*');
            return;
          }
        }

        throw new Error('Codex generation timed out.');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Generation failed.';
        setStatus(message);
        window.parent.postMessage({ type: 'codex_thinking_error', error: message }, '*');
      } finally {
        running = false;
      }
    }

    window.addEventListener('message', (event) => {
      const data = event?.data || {};
      if (data.type !== 'codex_thinking_start') return;
      runTurn(data.payload || {});
    });
  </script>
</body>
</html>`;
}

createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const authState = getRuntimeAuthState();

  if (request.method === 'OPTIONS') {
    response.writeHead(204, buildCorsHeaders(request));
    response.end();
    return;
  }

  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
    return proxyOpenAiCompatibleRequest(request, response, url);
  }

  if (url.pathname === '/health') {
    const loginStatus = await getLoginStatusWithFinalize();
    return sendJson(request, response, {
      ok: true,
      service: 'codex-bridge',
      auth_state: authState,
      has_api_key: runtimeHasDirectApiKey(),
      ...getRuntimeInfo(),
      login_status: loginStatus,
    });
  }

  if (url.pathname === '/runtime/config' && request.method === 'GET') {
    return sendJson(request, response, {
      ok: true,
      service: 'codex-bridge',
      config: summarizeRuntimeConfig(),
    });
  }

  if (url.pathname === '/runtime/config' && request.method === 'POST') {
    try {
      const payload = await readJsonBody(request);
      const result = await applyRuntimeConfig(payload, { restart: true });
      return sendJson(request, response, {
        ok: true,
        service: 'codex-bridge',
        ...result,
      });
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to update runtime config',
      }, 400);
    }
  }

  if (url.pathname === '/runtime/info') {
    return sendJson(request, response, {
      ok: true,
      service: 'codex-bridge',
      ...getRuntimeInfo(),
    });
  }

  if (url.pathname === '/chat/sessions' && request.method === 'POST') {
    try {
      const payload = await readJsonBody(request);
      const session = createChatSession(payload);
      return sendJson(request, response, {
        ok: true,
        session: serializeSession(session),
      }, 201);
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to create chat session',
      }, 400);
    }
  }

  const sessionMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)$/i);
  if (sessionMatch && request.method === 'GET') {
    const session = chatSessions.get(sessionMatch[1]);
    if (!session) {
      return sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
    }

    return sendJson(request, response, {
      ok: true,
      session: serializeSession(session),
    });
  }

  const streamMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)\/stream$/i);
  if (streamMatch && request.method === 'GET') {
    const session = chatSessions.get(streamMatch[1]);
    if (!session) {
      return sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
    }

    sendSseHeaders(request, response);
    session.subscribers.add(response);
    writeSse(response, 'session.ready', { session: serializeSession(session) });

    const keepAlive = setInterval(() => {
      try {
        response.write(': keepalive\n\n');
      } catch (error) {}
    }, 15000);

    request.on('close', () => {
      clearInterval(keepAlive);
      session.subscribers.delete(response);
      try {
        response.end();
      } catch (error) {}
    });

    return;
  }

  const messageMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)\/messages$/i);
  if (messageMatch && request.method === 'POST') {
    const session = chatSessions.get(messageMatch[1]);
    if (!session) {
      return sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
    }

    try {
      const payload = await readJsonBody(request);
      const message = String(payload.message || '').trim();
      const attachments = sanitizeAttachments(payload.attachments);
      if (message === '' && attachments.length === 0) {
        return sendJson(request, response, { ok: false, error: 'Message or attachment is required' }, 400);
      }

      if (payload.context && typeof payload.context === 'object') {
        session.context = payload.context;
      }

      session.pendingAttachments = attachments;

      runChatTurn(session, message).catch(() => {});

      return sendJson(request, response, {
        ok: true,
        session: serializeSession(session),
      }, 202);
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to send message',
      }, 400);
    }
  }

  if (url.pathname === '/chat/sessions' && request.method === 'DELETE') {
    chatSessions.clear();
    threadSessionIndex.clear();
    return sendEmpty(response);
  }

  if (url.pathname === '/cms/thinking' && request.method === 'GET') {
    const parentOrigin = String(url.searchParams.get('parent_origin') || '').trim();
    return sendHtml(
      request,
      response,
      renderCmsThinkingPage(),
      200,
      { allowFrame: true, parentOrigin }
    );
  }

  if (url.pathname === '/cms/generate/add-page' && request.method === 'POST') {
    try {
      const payload = await readJsonBody(request);
      const prompt = String(payload.prompt || '').trim();
      const generated = await generateCmsPageHtml({
        prompt,
        context: payload.context && typeof payload.context === 'object' ? payload.context : {},
        instruction: 'Create a Bootstrap 5 landing page HTML for this CMS page request. Return only final HTML with no markdown fences and no extra commentary.',
      });
      return sendJson(request, response, {
        ok: true,
        session_id: generated.session_id,
        html: generated.html,
      });
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to generate page HTML',
      }, 400);
    }
  }

  if (url.pathname === '/cms/generate/add-website' && request.method === 'POST') {
    try {
      const payload = await readJsonBody(request);
      const prompt = String(payload.prompt || '').trim();
      const websiteKind = String(payload.website_kind || 'business').trim().toLowerCase();
      const pageInstruction = websiteKind === 'landing'
        ? 'Create a Bootstrap 5 homepage HTML for a landing website request. Include sections optimized for conversion and leave room for an embedded lead form module. Return only final HTML.'
        : 'Create a Bootstrap 5 homepage HTML for this website request. Return only final HTML with no markdown fences and no extra commentary.';
      const pageResult = await generateCmsPageHtml({
        prompt,
        context: payload.context && typeof payload.context === 'object' ? payload.context : {},
        instruction: pageInstruction,
      });

      let formHtml = '';
      if (websiteKind === 'landing') {
        const formResult = await generateCmsPageHtml({
          prompt,
          context: payload.context && typeof payload.context === 'object' ? payload.context : {},
          instruction: 'Create only a compact Bootstrap 5 lead form section HTML for this website request. Return only final HTML.',
        });
        formHtml = formResult.html;
      }

      return sendJson(request, response, {
        ok: true,
        session_id: pageResult.session_id,
        page_html: pageResult.html,
        form_html: formHtml,
      });
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to generate website HTML',
      }, 400);
    }
  }

  if (url.pathname === '/cms/generate/add-module' && request.method === 'POST') {
    try {
      const payload = await readJsonBody(request);
      const prompt = String(payload.prompt || '').trim();
      const moduleKind = String(payload.module_kind || 'blog').trim().toLowerCase();
      const schemaFields = Array.isArray(payload.schema_fields)
        ? payload.schema_fields
            .filter((field) => field && typeof field === 'object' && String(field.name || '').trim() !== '')
            .map((field) => ({
              name: String(field.name || '').trim(),
              type: String(field.type || '').trim(),
              length: String(field.length || '').trim(),
              allow_null: Boolean(field.allow_null),
              default_value: String(field.default_value || '').trim(),
            }))
        : [];
      const schemaHint = schemaFields.length
        ? `\n\nSchema fields to use exactly (name/type/length/null/default):\n${JSON.stringify(schemaFields, null, 2)}\n\nBuild Bootstrap form-template HTML that includes form controls matching these field names exactly.`
        : '';
      const moduleInstruction = moduleKind === 'calendar'
        ? 'Create a Bootstrap form-template HTML for a calendar/events module. Include practical fields such as event title, summary, start/end date, location, organizer, and status. Return only final HTML for form fields (no markdown fences).'
        : moduleKind === 'alerts'
          ? 'Create a Bootstrap form-template HTML for an alerts module. Include practical fields such as alert title, message, severity, start/end date, call-to-action label/url, and active status. Return only final HTML for form fields.'
          : 'Create a Bootstrap form-template HTML for a blog/content module. Include practical fields such as title, slug, summary, hero image, body content, publish date, author, tags, and status. Return only final HTML for form fields.';
      const moduleResult = await generateCmsPageHtml({
        prompt,
        context: payload.context && typeof payload.context === 'object' ? payload.context : {},
        instruction: `${moduleInstruction}${schemaHint}`,
      });
      return sendJson(request, response, {
        ok: true,
        session_id: moduleResult.session_id,
        form_html: moduleResult.html,
      });
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to generate module form template',
      }, 400);
    }
  }

  if (url.pathname === '/cms/generate/add-form' && request.method === 'POST') {
    try {
      const payload = await readJsonBody(request);
      const prompt = String(payload.prompt || '').trim();
      const formKind = String(payload.form_kind || 'contact').trim().toLowerCase();
      const formInstruction = formKind === 'signup'
        ? 'Create a Bootstrap form-template HTML for a signup form. Include first/last name, email, company (optional), marketing opt-in checkbox, and submit button. Return only final HTML form fields.'
        : 'Create a Bootstrap form-template HTML for a contact form. Include name, email, phone (optional), subject, message, consent checkbox, and submit button. Return only final HTML form fields.';
      const formResult = await generateCmsPageHtml({
        prompt,
        context: payload.context && typeof payload.context === 'object' ? payload.context : {},
        instruction: formInstruction,
      });
      return sendJson(request, response, {
        ok: true,
        session_id: formResult.session_id,
        form_html: formResult.html,
      });
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to generate form template',
      }, 400);
    }
  }

  if (url.pathname === '/auth/device') {
    if (!runtimeRequiresLogin()) {
      return sendJson(request, response, {
        ok: true,
        auth_mode: getRuntimeAuthState(),
        message: 'This runtime provider does not require device authentication.',
      });
    }

    try {
      const payload = await ensureDeviceAuth();
      return sendJson(request, response, {
        ok: true,
        auth_mode: 'chatgpt',
        ...payload,
      });
    } catch (error) {
      return sendJson(request, response, {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to start device auth',
      }, 500);
    }
  }

  if (url.pathname === '/auth/status') {
    const loginStatus = await getLoginStatusWithFinalize();
    return sendJson(request, response, {
      ok: true,
      ...loginStatus,
    });
  }

  if (url.pathname !== '/') {
    return sendJson(request, response, { ok: false, error: 'Not Found' }, 404);
  }

  const contextName = url.searchParams.get('context_name') || '';
  const contextType = url.searchParams.get('context_type') || 'document';
  const contextId = url.searchParams.get('context_id') || '';
  const loginHint = runtimeRequiresLogin()
    ? defaultLoginHint
    : 'This runtime provider is configured for direct API or local model access, so no interactive login is required.';

  return sendHtml(request, response, renderPage({
    contextName,
    contextType,
    contextId,
    loginHint,
    authState,
  }));
}).listen(port, '0.0.0.0', () => {
  console.log(`Codex bridge listening on ${port}`);
});
