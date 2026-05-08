import { randomUUID } from 'node:crypto';

export function createChatSession(payload = {}) {
  const now = Date.now();
  const sessionId = randomUUID();
  return {
    id: sessionId,
    threadId: '',
    status: 'idle',
    mode: payload.mode === 'entity' ? 'entity' : 'workspace',
    context: payload.context && typeof payload.context === 'object' ? payload.context : {},
    messages: [],
    events: [],
    pendingAttachments: [],
    pendingApproval: null,
    running: false,
    lastError: null,
    subscribers: new Set(),
    createdAt: now,
    updatedAt: now,
  };
}

export function serializeSession(session) {
  return {
    id: session.id,
    thread_id: session.threadId || null,
    status: session.status,
    mode: session.mode,
    context: session.context,
    messages: session.messages,
    events: session.events,
    running: session.running,
    pending_approval: session.pendingApproval || null,
    last_error: session.lastError,
    assistant_draft: session.assistantDraft || '',
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export function extractAssistantText(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const assistant = [...messages].reverse().find((message) => message?.role === 'assistant' && String(message?.text || '').trim());
  if (assistant) {
    return String(assistant.text || '').trim();
  }

  const events = Array.isArray(session?.events) ? session.events : [];
  const agentMessage = [...events].reverse().find((event) =>
    String(event?.item?.type || '').trim().toLowerCase() === 'agent_message' &&
    String(event?.item?.text || '').trim()
  );
  if (agentMessage) {
    return String(agentMessage.item.text || '').trim();
  }

  return String(session?.assistantDraft || '').trim();
}
