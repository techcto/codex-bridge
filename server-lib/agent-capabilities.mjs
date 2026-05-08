export function normalizeAgentRuntimeContext(value = {}) {
  const record = value && typeof value === 'object' ? value : {};
  return {
    contract: String(record.contract || 'codex_agent').trim() || 'codex_agent',
    execution_class: String(record.execution_class || '').trim(),
    readiness: String(record.readiness || '').trim(),
    supports_workspace_actions: record.supports_workspace_actions === true,
    supports_direct_file_edits: record.supports_direct_file_edits === true,
    supports_command_execution: record.supports_command_execution === true,
    supports_git_inspection: record.supports_git_inspection === true,
    requires_verified_tool_results: record.requires_verified_tool_results !== false,
    provider: String(record.provider || '').trim(),
    selected_model_label: String(record.selected_model_label || '').trim(),
    selected_model_id: String(record.selected_model_id || '').trim(),
    conversation_mode: String(record.conversation_mode || '').trim(),
    summary: String(record.summary || '').trim(),
  };
}

export function summarizeAgentRuntime(agentRuntime = {}) {
  const normalized = normalizeAgentRuntimeContext(agentRuntime);
  const lines = [];

  if (normalized.contract || normalized.execution_class || normalized.readiness) {
    lines.push('Agent runtime:');
    if (normalized.contract) lines.push(`- contract: ${normalized.contract}`);
    if (normalized.execution_class) lines.push(`- execution class: ${normalized.execution_class}`);
    if (normalized.readiness) lines.push(`- readiness: ${normalized.readiness}`);
    if (normalized.provider) lines.push(`- provider: ${normalized.provider}`);
    if (normalized.selected_model_label) lines.push(`- selected model: ${normalized.selected_model_label}`);
    if (normalized.conversation_mode) lines.push(`- conversation mode: ${normalized.conversation_mode}`);
    lines.push(`- workspace actions available: ${normalized.supports_workspace_actions ? 'yes' : 'no'}`);
    if (normalized.summary) {
      lines.push('Agent runtime summary:');
      lines.push(normalized.summary);
    }
  }

  return lines;
}

export function buildAgentRuntimePromptNotes(agentRuntime = {}) {
  const normalized = normalizeAgentRuntimeContext(agentRuntime);

  if (normalized.supports_workspace_actions) {
    if (normalized.execution_class === 'bridge_tools') {
      return [
        'This runtime uses the bridge-local tool protocol for workspace edits, commands, and git inspection.',
        'Only report workspace changes that are confirmed by bridge tool results.',
      ].join('\n');
    }

    if (normalized.execution_class === 'model_tools') {
      return [
        'This runtime uses the bridge-local tool protocol, but relies on the model to emit trustworthy structured tool intent.',
        'Only report workspace changes that are confirmed by bridge tool results.',
      ].join('\n');
    }

    return '';
  }

  return '';
}
