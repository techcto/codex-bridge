import { buildAgentRuntimePromptNotes, summarizeAgentRuntime } from './agent-capabilities.mjs';

const MAX_CONTEXT_BLOCK_CHARS = 4000;
const MAX_MODEL_GUIDANCE_CHARS = 1500;

function truncateBlock(value, maxChars = MAX_CONTEXT_BLOCK_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n...[truncated ${text.length - maxChars} chars]`;
}

export function summarizeContext(context = {}) {
  const current = context.current_entity || {};
  const activeEditor = context.active_editor || {};
  const agentRuntime = context.agent_runtime || {};
  const selectedModel = context.selected_model || {};
  const selectedRegion = context.selected_region || {};
  const pageMetadata = context.page_metadata || {};
  const visualContext = context.visual_context || {};
  const openTabs = Array.isArray(context.open_tabs) ? context.open_tabs : [];
  const lines = [];

  if (context.workspace_name || context.workspace_root) {
    lines.push('Workspace:');
    if (context.workspace_name) lines.push(`- name: ${context.workspace_name}`);
    if (context.workspace_root) lines.push(`- root: ${context.workspace_root}`);
  }

  if (context.scope) {
    lines.push(`Scope: ${context.scope}`);
  }

  lines.push(...summarizeAgentRuntime(agentRuntime));

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
    lines.push(truncateBlock(current.content));
  }

  if (activeEditor.route || activeEditor.title || activeEditor.content) {
    lines.push('Active editor:');
    if (activeEditor.title) lines.push(`- title: ${activeEditor.title}`);
    if (activeEditor.path) lines.push(`- path: ${activeEditor.path}`);
    if (activeEditor.route && activeEditor.route !== activeEditor.path) lines.push(`- route: ${activeEditor.route}`);
    if (activeEditor.content && activeEditor.content !== current.content) {
      lines.push('Active editor content:');
      lines.push(truncateBlock(activeEditor.content));
    }
  }

  if (selectedModel && typeof selectedModel === 'object') {
    const label = String(selectedModel.label || '').trim();
    const modelSlug = String(selectedModel.model_slug || '').trim();
    const conversationMode = String(selectedModel.conversation_mode || '').trim();
    const generationMode = String(selectedModel.generation_mode || '').trim();
    const providerKey = String(selectedModel.provider_key || '').trim();
    const llmContent = String(selectedModel.llm_content || '').trim();
    if (label || modelSlug || conversationMode || generationMode || providerKey || llmContent) {
      lines.push('Selected model:');
      if (label) lines.push(`- label: ${label}`);
      if (modelSlug) lines.push(`- model slug: ${modelSlug}`);
      if (providerKey) lines.push(`- provider: ${providerKey}`);
      if (conversationMode) lines.push(`- conversation mode: ${conversationMode}`);
      if (generationMode) lines.push(`- generation mode: ${generationMode}`);
      if (llmContent) {
        lines.push('Selected model guidance:');
        lines.push(truncateBlock(llmContent, MAX_MODEL_GUIDANCE_CHARS));
      }
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
      const location = tab.path || tab.route || tab.url || '';
      lines.push(`- ${title}${location ? ` (${location})` : ''}`);
    });
  }

  return lines.join('\n');
}

export function buildCodexPrompt({ session, message, attachments = [] }) {
  const contextSummary = summarizeContext(session.context);
  const agentRuntimeNotes = buildAgentRuntimePromptNotes(session.context?.agent_runtime || {});
  const attachmentNotes = attachments.length
    ? [
        'The user attached supplemental assets to this prompt.',
        ...attachments.map((attachment, index) => `Attachment ${index + 1}: ${attachment.name || `image-${index + 1}`}${attachment.mime_type ? ` (${attachment.mime_type})` : ''}`),
        'If an attached image is present, inspect it carefully and treat it as part of the user request.',
      ].join('\n')
    : '';

  return [
    'You are Codex, a coding assistant working inside the user workspace.',
    'You can inspect files, edit files in the workspace, run shell commands in the workspace, inspect git history, and help with code, configuration, and debugging tasks directly.',
    'Treat the actual workspace on disk as the source of truth. Do not invent file names, open tabs, edits, or command results.',
    'If the provided UI context is incomplete or stale, inspect the workspace before answering.',
    'Never claim that you edited, created, deleted, or inspected a file unless you actually performed that action in the workspace tools available to you.',
    'When useful, use workspace shell commands such as listing files, searching text, checking git status, and reviewing git history before answering.',
    'You may inspect repository history with commands like git log, git show, and git diff when that helps answer the user request.',
    'When the user asks about files or asks for a code change, inspect the relevant files first and verify the target paths from the workspace before responding.',
    'If you cannot access or modify the requested file, say that clearly instead of pretending it was changed.',
    'Do not say that you changed a file unless the workspace tools reported a successful write or edit result.',
    'Continue the current conversation without re-introducing yourself or giving generic workspace tutorials unless the user explicitly asks for them.',
    'When the user asks for a concrete change, make the change directly in the workspace when possible instead of only proposing it.',
    'Default to taking action. If the user asks to fix, edit, patch, refactor, scan, or update something, inspect the workspace, choose the relevant files, and do the work.',
    'Do not ask the user for confirmation before making requested workspace edits.',
    'Do not ask the user to specify a file if the active context, workspace, or request is already enough to identify the likely target. Inspect the repository and choose the best matching files yourself.',
    'If the user message is brief but actionable, infer the likely target from the workspace and proceed.',
    'After making changes, briefly report what you changed instead of asking what to do next.',
    'After editing files, explain what you changed and why in 1-3 concise bullets.',
    'Use the provided context as grounding, but prioritize the actual repository contents and ongoing conversation.',
    'If there is no active editor or no open tabs in context, do not imply that specific files are currently open.',
    'Keep responses direct, practical, and oriented toward completing the task.',
    agentRuntimeNotes,
    attachmentNotes,
    contextSummary ? `Workspace context:\n${contextSummary}` : '',
    `User request:\n${message}`,
  ].filter(Boolean).join('\n\n');
}
