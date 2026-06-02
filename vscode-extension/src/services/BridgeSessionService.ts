import type {
  BridgeSessionRecord,
  BridgeSessionResponse,
  RequestJsonOptions,
  SessionCreateResponse,
} from '../types';

export type BridgeSessionServiceDeps = {
  getBaseUrl: () => string;
  getErrorMessage: (error: unknown) => string;
  outputChannel?: { appendLine(value: string): void };
  requestJson: <T>(method: string, path: string, body?: unknown, options?: RequestJsonOptions) => Promise<T>;
  delay: (ms: number) => Promise<void>;
};

export class BridgeSessionService {
  private readonly deps: BridgeSessionServiceDeps;

  public constructor(deps: BridgeSessionServiceDeps) {
    this.deps = deps;
  }

  public async waitForSessionCompletion(sessionId: string, timeoutMs = 180000): Promise<BridgeSessionRecord> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const payload = await this.deps.requestJson<BridgeSessionResponse>('GET', `/chat/sessions/${encodeURIComponent(sessionId)}`, undefined, {
        timeoutMs: 5000,
        suppressLog: true,
      });
      const session = payload.session;
      if (!session) {
        throw new Error('Bridge did not return a session while waiting for completion.');
      }

      const status = String(session.status || '').toLowerCase();
      if (status === 'idle') {
        if (this.getAssistantText(session)) {
          return session;
        }
        await this.deps.delay(350);
        continue;
      }

      if (status === 'error') {
        throw new Error(session.last_error || 'Codex session failed.');
      }

      await this.deps.delay(700);
    }

    throw new Error(`Timed out waiting for Codex reply for session ${sessionId}.`);
  }

  public getAssistantText(session: BridgeSessionRecord | null | undefined): string {
    if (!session || typeof session !== 'object') {
      return '';
    }

    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'assistant') {
        continue;
      }

      const text = String(message?.text || '').trim();
      if (text !== '') {
        return text;
      }
    }

    const events = Array.isArray(session.events) ? session.events : [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      const itemType = String(event?.item?.type || '').trim().toLowerCase();
      if (itemType !== 'agent_message') {
        continue;
      }

      const text = String(event?.item?.text || '').trim();
      if (text !== '') {
        return text;
      }
    }

    return this.getAssistantDraft(session).trim();
  }

  public getAssistantDraft(session: BridgeSessionRecord | null | undefined): string {
    if (!session || typeof session !== 'object') {
      return '';
    }

    return String(session.assistant_draft || session.assistantDraft || '');
  }

  public resolveCompletedAssistantText(session: BridgeSessionRecord | null | undefined, streamedAssistantText = ''): string {
    const resolved = this.getAssistantText(session);
    const streamed = String(streamedAssistantText || '').trim();
    if (resolved === 'No response returned.' && streamed) {
      return streamed;
    }
    return resolved || streamed;
  }

  public async streamSession(
    sessionId: string,
    options?: {
      onAssistantStart?: () => void;
      onAssistantDelta?: (delta: string) => void;
      onApprovalChange?: (approval: BridgeSessionRecord['pending_approval']) => void;
      onSessionEvent?: (event: Record<string, unknown>) => void;
    }
  ): Promise<{ session: BridgeSessionRecord; assistantText: string }> {
    const url = `${this.deps.getBaseUrl()}/chat/sessions/${encodeURIComponent(sessionId)}/stream`;
    this.deps.outputChannel?.appendLine(`[bridge] -> GET ${url} [sse]`);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, 190000);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
        },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutHandle);
      const message = error instanceof Error ? error.message : 'Unknown fetch failure.';
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Timed out contacting Codex Bridge at ${url}.`);
      }
      throw new Error(`Unable to reach Codex Bridge at ${url}: ${message}`);
    }

    if (!response.ok || !response.body) {
      clearTimeout(timeoutHandle);
      const raw = await response.text();
      throw new Error(raw || `Codex Bridge streaming failed with status ${response.status}.`);
    }

    let latestSession: BridgeSessionRecord | null = null;
    let lastDraft = '';
    let streamedAssistantText = '';
    let didStart = false;
    let streamError = '';
    let closedOnTerminalEvent = false;
    let terminalAbortHandle: ReturnType<typeof setTimeout> | null = null;
    let lastApprovalKey = '';
    let lastSessionEventKey = '';

    const closeStream = (delayMs = 0) => {
      if (closedOnTerminalEvent) {
        return;
      }
      closedOnTerminalEvent = true;
      if (terminalAbortHandle) {
        clearTimeout(terminalAbortHandle);
        terminalAbortHandle = null;
      }
      if (delayMs <= 0) {
        controller.abort();
        return;
      }
      terminalAbortHandle = setTimeout(() => {
        terminalAbortHandle = null;
        controller.abort();
      }, delayMs);
    };

    try {
      await this.consumeSseStream(response.body, (eventName, payload) => {
        const data = (payload && typeof payload === 'object') ? payload as BridgeSessionResponse : null;
        const session = data?.session;
        if (session) {
          latestSession = session;
          const latestEvent = Array.isArray(session.events) ? session.events[session.events.length - 1] : null;
          const latestEventKey = latestEvent && typeof latestEvent === 'object'
            ? `${String((latestEvent as Record<string, unknown>).type || '')}:${String((latestEvent as Record<string, unknown>).received_at || '')}`
            : '';
          if (latestEvent && latestEventKey && latestEventKey !== lastSessionEventKey) {
            lastSessionEventKey = latestEventKey;
            options?.onSessionEvent?.(latestEvent as Record<string, unknown>);
          }
          const approval = session.pending_approval || null;
          const approvalKey = approval?.request_id ? String(approval.request_id) : '';
          if (approvalKey !== lastApprovalKey || (!approval && lastApprovalKey !== '')) {
            lastApprovalKey = approvalKey;
            options?.onApprovalChange?.(approval);
          }
          const draft = this.getAssistantDraft(session);
          if (draft && !didStart) {
            didStart = true;
            options?.onAssistantStart?.();
          }
          if (draft.startsWith(lastDraft)) {
            const delta = draft.slice(lastDraft.length);
            if (delta) {
              streamedAssistantText += delta;
              options?.onAssistantDelta?.(delta);
            }
          } else if (draft && draft !== lastDraft) {
            if (!didStart) {
              didStart = true;
              options?.onAssistantStart?.();
            }
            streamedAssistantText = draft;
            options?.onAssistantDelta?.(draft);
          }
          lastDraft = draft;
        }

        if (eventName === 'session.error') {
          streamError = session?.last_error || 'Codex session failed.';
        }

        const status = String(session?.status || '').toLowerCase();
        if (eventName === 'session.completed' || eventName === 'session.error' || status === 'idle' || status === 'error') {
          const hasFinalAssistantText = Boolean(this.getAssistantText(session));
          if (eventName === 'session.error' || status === 'error' || hasFinalAssistantText) {
            closeStream(0);
          } else {
            closeStream(250);
          }
        }
      });
    } catch (error) {
      if (!(closedOnTerminalEvent && error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
    } finally {
      if (terminalAbortHandle) {
        clearTimeout(terminalAbortHandle);
        terminalAbortHandle = null;
      }
      clearTimeout(timeoutHandle);
    }

    const elapsedMs = Date.now() - startedAt;
    this.deps.outputChannel?.appendLine(`[bridge] <- stream ${url} (${elapsedMs}ms)`);

    if (streamError) {
      throw new Error(streamError);
    }

    let finalSession: BridgeSessionRecord | null = latestSession;
    try {
      const payload = await this.deps.requestJson<BridgeSessionResponse>('GET', `/chat/sessions/${encodeURIComponent(sessionId)}`, undefined, {
        timeoutMs: 5000,
        suppressLog: true,
      });
      if (payload.session) {
        finalSession = payload.session;
      }
    } catch (error) {
      this.deps.outputChannel?.appendLine(`[bridge] final session read failed for ${sessionId}: ${this.deps.getErrorMessage(error)}`);
    }

    if (!finalSession) {
      this.deps.outputChannel?.appendLine(`[bridge] stream returned no session payload for ${sessionId}; falling back to polling`);
      const session = await this.waitForSessionCompletion(sessionId);
      const assistantText = this.resolveCompletedAssistantText(session, streamedAssistantText);
      if (!assistantText) {
        throw new Error('Codex finished without returning an assistant message.');
      }
      return { session, assistantText };
    }

    const finalStatus = String(finalSession.status || '').toLowerCase();
    if (finalStatus === 'error') {
      throw new Error(finalSession.last_error || 'Codex session failed.');
    }

    if (finalStatus !== 'idle') {
      this.deps.outputChannel?.appendLine(`[bridge] stream ended before idle for ${sessionId}; falling back to polling`);
      const session = await this.waitForSessionCompletion(sessionId);
      const assistantText = this.resolveCompletedAssistantText(session, streamedAssistantText);
      if (!assistantText) {
        throw new Error('Codex finished without returning an assistant message.');
      }
      return { session, assistantText };
    }

    const assistantText = this.resolveCompletedAssistantText(finalSession, streamedAssistantText);
    if (!assistantText) {
      this.deps.outputChannel?.appendLine(`[bridge] stream ended idle without final assistant text for ${sessionId}; polling once more`);
      const session = await this.waitForSessionCompletion(sessionId);
      const polledAssistantText = this.resolveCompletedAssistantText(session, streamedAssistantText);
      if (!polledAssistantText) {
        throw new Error('Codex finished without returning an assistant message.');
      }
      return { session, assistantText: polledAssistantText };
    }

    return { session: finalSession, assistantText };
  }

  public async ensureSessionId(
    sessionId: string | undefined,
    createPayload: { context: Record<string, unknown> },
    onReset: () => Promise<void>
  ): Promise<string> {
    if (sessionId) {
      try {
        const check = await this.deps.requestJson<{ ok?: boolean }>('GET', `/chat/sessions/${encodeURIComponent(sessionId)}`);
        if (check.ok === true) {
          return sessionId;
        }
      } catch (_error) {
      }
      await onReset();
    }

    const response = await this.deps.requestJson<SessionCreateResponse>('POST', '/chat/sessions', createPayload);
    const nextSessionId = this.extractSessionId(response);
    if (!nextSessionId) {
      this.deps.outputChannel?.appendLine(`[bridge] create session response missing id: ${this.safeJsonStringify(response)}`);
      throw new Error(response.error || 'Bridge did not return a session id.');
    }
    return nextSessionId;
  }

  public extractSessionId(payload: unknown): string {
    const queue: unknown[] = [payload];
    const seen = new Set<unknown>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || seen.has(current)) {
        continue;
      }

      seen.add(current);
      const record = current as Record<string, unknown>;
      const candidates = [record.session_id, record.id, record.sessionId, record.thread_id];

      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') {
          return candidate.trim();
        }
      }

      for (const value of Object.values(record)) {
        if (value && typeof value === 'object') {
          queue.push(value);
        }
      }
    }

    return '';
  }

  private safeJsonStringify(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return '[unserializable response payload]';
    }
  }

  private pullCompleteSseFrames(buffer: string): { frames: string[]; rest: string } {
    const frames: string[] = [];
    let rest = buffer;
    while (true) {
      const unix = rest.indexOf('\n\n');
      const windows = rest.indexOf('\r\n\r\n');
      const hasUnix = unix !== -1;
      const hasWindows = windows !== -1;
      if (!hasUnix && !hasWindows) {
        break;
      }
      const useWindows = hasWindows && (!hasUnix || windows < unix);
      const idx = useWindows ? windows : unix;
      const sepLen = useWindows ? 4 : 2;
      frames.push(rest.slice(0, idx));
      rest = rest.slice(idx + sepLen);
    }
    return { frames, rest };
  }

  private parseSseFrame(frame: string): { event: string; data: unknown } | null {
    const lines = frame.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message';
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!dataLines.length) {
      return null;
    }

    const raw = dataLines.join('\n');
    try {
      return { event: eventName, data: JSON.parse(raw) };
    } catch (_error) {
      return { event: eventName, data: raw };
    }
  }

  private async consumeSseStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: string, data: unknown) => void
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let carry = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      carry += decoder.decode(value, { stream: true });
      const drained = this.pullCompleteSseFrames(carry);
      carry = drained.rest;
      for (const frame of drained.frames) {
        const parsed = this.parseSseFrame(frame);
        if (parsed) {
          onEvent(parsed.event, parsed.data);
        }
      }
    }

    carry += decoder.decode();
    if (carry.trim()) {
      const parsed = this.parseSseFrame(carry);
      if (parsed) {
        onEvent(parsed.event, parsed.data);
      }
    }
  }
}
