export function normalizeRuntimeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return ['openai', 'vllm', 'ollama', 'openai_compatible', 'osirus', 'osirus_agent'].includes(provider) ? provider : 'openai';
}

export function normalizeAuthMode(value, runtimeProvider = 'openai') {
  const authMode = String(value || '').trim().toLowerCase();
  if (runtimeProvider === 'openai') {
    if (['chatgpt', 'api_key'].includes(authMode)) {
      return authMode;
    }
    return 'chatgpt';
  }

  if (runtimeProvider === 'osirus') {
    return authMode === 'api_key' ? 'api_key' : 'none';
  }

  if (runtimeProvider === 'osirus_agent') {
    return 'api_key';
  }

  if (runtimeProvider === 'ollama') {
    return 'none';
  }

  if (runtimeProvider === 'vllm' || runtimeProvider === 'openai_compatible') {
    return authMode === 'none' ? 'none' : 'api_key';
  }

  return 'none';
}

export function normalizeRuntimeConfig(payload = {}, options = {}) {
  const defaultWorkspaceRoot = options.defaultWorkspaceRoot || '';
  const environment = options.environment || process.env;
  const runtimeProvider = normalizeRuntimeProvider(payload.runtime_provider);
  const derivedAuthMode = payload.auth_mode
    ?? (runtimeProvider === 'openai' && String(environment.OPENAI_API_KEY || '').trim() !== '' ? 'api_key' : (runtimeProvider === 'openai' ? 'chatgpt' : 'none'));
  return {
    runtime_provider: runtimeProvider,
    auth_mode: normalizeAuthMode(derivedAuthMode, runtimeProvider),
    provider_api_base_url: String(payload.provider_api_base_url || payload.base_url || environment.CODEX_PROVIDER_API_BASE_URL || '').trim(),
    provider_api_key: String(payload.provider_api_key || environment.CODEX_PROVIDER_API_KEY || environment.OPENAI_API_KEY || '').trim(),
    default_model: String(payload.default_model || environment.CODEX_DEFAULT_MODEL || '').trim(),
    workspace_root: String(payload.workspace_root || environment.CODEX_WORKSPACE_ROOT || defaultWorkspaceRoot).trim() || defaultWorkspaceRoot,
  };
}

export function runtimeConfigHash(config = {}, defaultWorkspaceRoot = '') {
  return JSON.stringify({
    runtime_provider: config.runtime_provider || 'openai',
    auth_mode: config.auth_mode || 'chatgpt',
    provider_api_base_url: config.provider_api_base_url || '',
    provider_api_key: config.provider_api_key || '',
    default_model: config.default_model || '',
    workspace_root: config.workspace_root || defaultWorkspaceRoot,
  });
}

export function runtimeRequiresLogin(config = {}) {
  return config.runtime_provider === 'openai' && config.auth_mode === 'chatgpt';
}

export function runtimeHasDirectApiKey(config = {}) {
  return String(config.provider_api_key || '').trim() !== '';
}

export function getRuntimeAuthState(config = {}) {
  if (runtimeRequiresLogin(config)) {
    return 'chatgpt';
  }

  if (runtimeHasDirectApiKey(config)) {
    return 'api_key';
  }

  return 'none';
}

export function summarizeRuntimeConfig(config = {}, defaultWorkspaceRoot = '') {
  return {
    runtime_provider: config.runtime_provider,
    auth_mode: config.auth_mode,
    provider_api_base_url: config.provider_api_base_url || '',
    has_provider_api_key: runtimeHasDirectApiKey(config),
    default_model: config.default_model || '',
    workspace_root: config.workspace_root || defaultWorkspaceRoot,
  };
}

export function getDefaultUpstreamApiBaseUrl(config = {}) {
  if (config.runtime_provider === 'openai') {
    return 'https://api.openai.com/v1';
  }

  if (config.runtime_provider === 'ollama') {
    return 'http://127.0.0.1:11434/v1';
  }

  return '';
}

export function getUpstreamApiBaseUrl(config = {}) {
  const configuredBaseUrl = String(config.provider_api_base_url || '').trim();
  const baseUrl = configuredBaseUrl || getDefaultUpstreamApiBaseUrl(config);
  if (!baseUrl) {
    return '';
  }

  try {
    const parsed = new URL(baseUrl);
    const normalizedPath = String(parsed.pathname || '').replace(/\/+$/, '');
    if (!normalizedPath || normalizedPath === '') {
      parsed.pathname = '/v1';
    } else if (!/\/v\d+$/i.test(normalizedPath)) {
      parsed.pathname = `${normalizedPath}/v1`;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    return '';
  }
}

export function buildUpstreamApiUrl(requestUrl, config = {}) {
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

export function buildProxyRequestHeaders(request, config = {}) {
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

function toTomlString(value) {
  return `"${String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function buildCodexConfigToml(config = {}) {
  const lines = [];
  const model = String(config.default_model || '').trim();
  const baseUrl = getUpstreamApiBaseUrl(config) || String(config.provider_api_base_url || '').trim();

  if (config.runtime_provider === 'openai') {
    const providerId = config.auth_mode === 'api_key' ? 'cms_openai' : 'openai';
    lines.push(`model_provider = ${toTomlString(providerId)}`);
    if (model) {
      lines.push(`model = ${toTomlString(model)}`);
    }

    if (config.auth_mode === 'api_key') {
      lines.push('preferred_auth_method = "apikey"');
      lines.push('');
      lines.push(`[model_providers.${providerId}]`);
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
    : (config.runtime_provider === 'osirus_agent'
      ? 'cms_osirus_agent'
      : (config.runtime_provider === 'osirus' ? 'cms_osirus' : 'cms_local'));
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
        : (config.runtime_provider === 'osirus_agent'
          ? 'Osirus Agent'
          : (config.runtime_provider === 'osirus' ? 'Osirus.AI' : 'OpenAI Compatible')))
  )}`);
  lines.push(`base_url = ${toTomlString(baseUrl || defaultBaseUrl)}`);
  lines.push('wire_api = "responses"');
  if (config.auth_mode === 'api_key' && runtimeHasDirectApiKey(config)) {
    lines.push('env_key = "CODEX_PROVIDER_API_KEY"');
  }

  return `${lines.join('\n')}\n`;
}

export function buildCodexEnv(config = {}, defaultWorkspaceRoot = '', environment = process.env) {
  const env = { ...environment };
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
