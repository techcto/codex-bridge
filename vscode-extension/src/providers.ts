import type { AuthMode, RuntimeProvider } from './types';

export function getSupportedAuthModes(provider: RuntimeProvider): AuthMode[] {
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

export function getAuthModeDisplayLabel(authMode: AuthMode): string {
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

export function providerNeedsSavedApiKey(provider: RuntimeProvider, authMode: AuthMode): boolean {
  return authMode === 'api_key' && provider !== 'ollama' && provider !== 'osirus';
}

export function getProviderDisplayName(provider: RuntimeProvider): string {
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

export function getProviderIcon(provider: RuntimeProvider): string {
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

export function getProviderSetupSummary(provider: RuntimeProvider, authMode: AuthMode): string {
  switch (provider) {
    case 'openai':
      return authMode === 'chatgpt'
        ? 'Use your ChatGPT sign-in or switch to an API key for direct OpenAI Codex agent access.'
        : 'Use your OpenAI API key to connect to the remote OpenAI Codex agent runtime.';
    case 'osirus':
      return 'Connect to the regular Osirus.AI model catalog. This runtime is intended for Codex agent work, but bridge-side tool augmentation for regular Osirus models is still planned.';
    case 'osirus_agent':
      return 'Connect your Osirus agent-scoped OpenAI-compatible `/v1` endpoint with an API key for native Codex-style tool execution.';
    case 'ollama':
      return 'Connect to a local Ollama runtime. Workspace tool execution depends on the selected model actually supporting tool calls.';
    case 'vllm':
      return 'Connect to your vLLM OpenAI-compatible `/v1` endpoint. Workspace tool execution depends on the selected model actually supporting tool calls.';
    case 'openai_compatible':
      return 'Connect any OpenAI-compatible `/v1` endpoint with the right base URL and credentials. Workspace tool execution depends on the selected model actually supporting tool calls.';
    default:
      return 'Configure your Codex agent runtime and credentials.';
  }
}

export function getProviderBaseUrlHint(provider: RuntimeProvider): string {
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

export function getSuggestedProviderApiBaseUrl(provider: RuntimeProvider): string {
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

export function normalizeOsirusCompatBaseUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);
    const normalizedPath = String(parsed.pathname || '').replace(/\/+$/, '');
    if (!normalizedPath) {
      parsed.pathname = '/api/v1';
    } else if (/\/v\d+$/i.test(normalizedPath)) {
      parsed.pathname = normalizedPath;
    } else if (/\/api$/i.test(normalizedPath)) {
      parsed.pathname = `${normalizedPath}/v1`;
    } else {
      parsed.pathname = normalizedPath;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    return raw.replace(/\/+$/, '');
  }
}

export function getSuggestedDefaultModel(provider: RuntimeProvider, authMode: AuthMode): string {
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

export function providerRequiresBaseUrl(provider: RuntimeProvider): boolean {
  return ['osirus', 'osirus_agent', 'vllm', 'openai_compatible'].includes(provider);
}
