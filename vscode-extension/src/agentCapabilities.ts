import type { AgentRuntimeCapability, OsirusModelOption, RuntimeProvider } from './types';

function buildSummary(capability: AgentRuntimeCapability): string {
  if (capability.executionClass === 'native_tools' && capability.readiness === 'ready') {
    return 'Native Codex-style tools are available for workspace edits, commands, and git inspection.';
  }

  if (capability.executionClass === 'model_tools') {
    return 'This runtime uses the bridge-local tool executor, but depends on the selected model to emit trustworthy structured tool intent.';
  }

  return 'This runtime uses the bridge-local tool executor and bridge-mediated tool intent for workspace edits, commands, and git inspection.';
}

export function resolveAgentRuntimeCapability(
  runtimeProvider: RuntimeProvider,
  selectedModel?: Pick<OsirusModelOption, 'id' | 'label' | 'conversationMode'> | Record<string, unknown> | null
): AgentRuntimeCapability {
  const selectedModelLabel = String((selectedModel as Record<string, unknown> | null)?.label || '').trim();
  const selectedModelId = String((selectedModel as Record<string, unknown> | null)?.id || '').trim();
  const conversationMode = String(
    (selectedModel as Record<string, unknown> | null)?.conversationMode
      || (selectedModel as Record<string, unknown> | null)?.conversation_mode
      || ''
  ).trim().toLowerCase();

  let capability: AgentRuntimeCapability;

  switch (runtimeProvider) {
    case 'openai':
      capability = {
        contract: 'codex_agent',
        executionClass: 'native_tools',
        readiness: 'ready',
        supportsWorkspaceActions: true,
        supportsDirectFileEdits: true,
        supportsCommandExecution: true,
        supportsGitInspection: true,
        requiresVerifiedToolResults: true,
        provider: runtimeProvider,
        selectedModelLabel,
        selectedModelId,
        conversationMode,
        summary: '',
      };
      break;
    case 'osirus_agent':
      capability = {
        contract: 'codex_agent',
        executionClass: 'native_tools',
        readiness: 'ready',
        supportsWorkspaceActions: true,
        supportsDirectFileEdits: true,
        supportsCommandExecution: true,
        supportsGitInspection: true,
        requiresVerifiedToolResults: true,
        provider: runtimeProvider,
        selectedModelLabel,
        selectedModelId,
        conversationMode,
        summary: '',
      };
      break;
    case 'osirus':
      capability = {
        contract: 'codex_agent',
        executionClass: 'bridge_tools',
        readiness: 'experimental',
        supportsWorkspaceActions: true,
        supportsDirectFileEdits: true,
        supportsCommandExecution: true,
        supportsGitInspection: true,
        requiresVerifiedToolResults: true,
        provider: runtimeProvider,
        selectedModelLabel,
        selectedModelId,
        conversationMode,
        summary: '',
      };
      break;
    case 'ollama':
    case 'vllm':
    case 'openai_compatible':
    default:
      capability = {
        contract: 'codex_agent',
        executionClass: 'model_tools',
        readiness: 'experimental',
        supportsWorkspaceActions: true,
        supportsDirectFileEdits: true,
        supportsCommandExecution: true,
        supportsGitInspection: true,
        requiresVerifiedToolResults: true,
        provider: runtimeProvider,
        selectedModelLabel,
        selectedModelId,
        conversationMode,
        summary: '',
      };
      break;
  }

  capability.summary = buildSummary(capability);
  return capability;
}

export function formatAgentExecutionLabel(capability: AgentRuntimeCapability): string {
  if (capability.executionClass === 'native_tools') {
    return 'Native Tools';
  }

  if (capability.executionClass === 'model_tools') {
    return 'Model Tools';
  }

  return 'Bridge Tools';
}
