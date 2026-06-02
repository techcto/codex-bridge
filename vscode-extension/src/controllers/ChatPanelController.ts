import * as vscode from 'vscode';
import {
  resolveCompletedLocalMessagesFromStream,
} from '../chat/completedTurn';
import type {
  BridgeSessionRecord,
  BridgeSessionResponse,
  LocalChatMessage,
  LocalChatThread,
  OsirusChatSnapshot,
  OsirusModelOption,
  RequestJsonOptions,
  RuntimeProvider,
  SessionCreateResponse,
  WebviewAttachment,
} from '../types';

type BridgeSeedMessage = { id: string; role: 'user' | 'assistant' | 'system'; text: string; created_at: number };
type BridgeSeedResolution = { messages: BridgeSeedMessage[]; osirusChatIdStale: boolean };

export type ChatPanelControllerDeps = {
  buildChatContext: (options?: { chatId?: string; selectedModel?: Record<string, unknown>; includeContent?: boolean }) => Record<string, unknown>;
  createLocalChatThread: (provider: RuntimeProvider, seed?: Partial<LocalChatThread>) => Promise<LocalChatThread>;
  createLocalId: (prefix: string) => string;
  extractSessionId: (payload: unknown) => string;
  fetchOsirusChatSnapshot: (chatId: string) => Promise<OsirusChatSnapshot>;
  fetchOsirusModelOptions: () => Promise<OsirusModelOption[]>;
  getCurrentRuntimeProvider: () => RuntimeProvider;
  getErrorMessage: (error: unknown) => string;
  getOrCreateActiveThread: (provider: RuntimeProvider) => Promise<LocalChatThread>;
  getOsirusModelContext: (option: OsirusModelOption | null | undefined) => Record<string, unknown> | undefined;
  getStoredChatThread: (threadId: string) => Promise<LocalChatThread | undefined>;
  getStoredOpenOsirusChatId: () => Promise<string>;
  getValidOsirusAccessToken: () => Promise<string>;
  normalizeRole: (value: unknown) => 'user' | 'assistant' | 'system' | null;
  outputChannel?: vscode.OutputChannel;
  panelStateService: { buildState(): Promise<Record<string, unknown>> };
  pushRuntimeConfig: (options?: { suppressErrors?: boolean; modelOverride?: string }) => Promise<boolean>;
  requestJson: <T>(method: string, path: string, body?: unknown, options?: RequestJsonOptions) => Promise<T>;
  setActiveThreadIdForProvider: (provider: RuntimeProvider, threadId?: string) => Promise<void>;
  setStoredOpenOsirusChatId: (chatId?: string) => Promise<void>;
  streamBridgeSession: (
    sessionId: string,
    options?: {
      onAssistantStart?: () => void;
      onAssistantDelta?: (delta: string) => void;
      onApprovalChange?: (approval: BridgeSessionRecord['pending_approval']) => void;
      onSessionEvent?: (event: Record<string, unknown>) => void;
    }
  ) => Promise<{ session: BridgeSessionRecord; assistantText: string }>;
  updateStoredThreadMessages: (
    threadId: string,
    messages: LocalChatMessage[],
    patch?: Partial<LocalChatThread>
  ) => Promise<LocalChatThread>;
  appendStoredThreadMessage: (
    threadId: string,
    message: LocalChatMessage,
    patch?: Partial<LocalChatThread>
  ) => Promise<LocalChatThread>;
};

export class ChatPanelController {
  private readonly deps: ChatPanelControllerDeps;
  private static readonly FILE_EDIT_EVENT_TYPES = new Set([
    'write_file',
    'append_file',
    'replace_in_file',
    'insert_in_file',
    'delete_file',
    'move_file',
    'copy_file',
    'apply_patch',
  ]);

  public constructor(deps: ChatPanelControllerDeps) {
    this.deps = deps;
  }

  private mapBridgeSeedMessages(messages: Array<{ id?: string; role?: string; content?: string; text?: string; createdAt?: number; created_at?: number }>): BridgeSeedMessage[] {
    return messages
      .map((message, index) => {
        const role = this.deps.normalizeRole(message?.role);
        const text = String(message?.text || message?.content || '').trim();
        if (!role || !text) {
          return null;
        }
        return {
          id: String(message?.id || '').trim() || this.deps.createLocalId(`seed-${index + 1}`),
          role,
          text,
          created_at: Number(message?.created_at || message?.createdAt || Date.now()) || Date.now(),
        };
      })
      .filter((message): message is BridgeSeedMessage => Boolean(message));
  }

  private async resolveBridgeSeedMessages(
    runtimeProvider: RuntimeProvider,
    osirusChatId: string,
    localMessages: LocalChatMessage[] = []
  ): Promise<BridgeSeedResolution> {
    const localSeedMessages = this.mapBridgeSeedMessages(localMessages);
    const resolvedChatId = String(osirusChatId || '').trim();
    if (runtimeProvider !== 'osirus' || !resolvedChatId) {
      return { messages: localSeedMessages, osirusChatIdStale: false };
    }

    try {
      const snapshot = await this.deps.fetchOsirusChatSnapshot(resolvedChatId);
      const remoteSeedMessages = this.mapBridgeSeedMessages(snapshot.messages || []);
      return {
        messages: remoteSeedMessages.length ? remoteSeedMessages : localSeedMessages,
        osirusChatIdStale: false,
      };
    } catch (error) {
      const errorMessage = this.deps.getErrorMessage(error);
      this.deps.outputChannel?.appendLine(`[bridge] failed to hydrate bridge session from Osirus chat ${resolvedChatId}: ${errorMessage}`);
      if (/404/.test(errorMessage)) {
        await this.deps.setStoredOpenOsirusChatId(undefined);
        return { messages: localSeedMessages, osirusChatIdStale: true };
      }
      return { messages: localSeedMessages, osirusChatIdStale: false };
    }
  }

  public async handleMessage(
    panel: { webview: vscode.Webview },
    message: any,
    pushPanelState: () => Promise<void>
  ): Promise<void> {
    if (message?.type === 'ready') {
      await pushPanelState();
      return;
    }

    if (message?.type === 'newThread') {
      const thread = await this.deps.createLocalChatThread(this.deps.getCurrentRuntimeProvider());
      if (thread.provider === 'osirus') {
        await this.deps.setStoredOpenOsirusChatId(undefined);
      }
      panel.webview.postMessage({ type: 'status', value: `Started ${thread.title.toLowerCase()}.` });
      await pushPanelState();
      return;
    }

    if (message?.type === 'openThread') {
      const threadId = String(message.threadId || '').trim();
      if (!threadId) {
        return;
      }
      let thread = await this.deps.getStoredChatThread(threadId);
      if (!thread || thread.provider !== this.deps.getCurrentRuntimeProvider()) {
        return;
      }
      if (thread.provider === 'osirus' && thread.sessionId) {
        thread = await this.deps.updateStoredThreadMessages(thread.id, thread.messages, {
          sessionId: undefined,
        });
      }
      await this.deps.setActiveThreadIdForProvider(thread.provider, thread.id);
      if (thread.provider === 'osirus') {
        await this.deps.setStoredOpenOsirusChatId(thread.osirusChatId || undefined);
      }
      await pushPanelState();
      return;
    }

    if (message?.type === 'approvalDecision') {
      const sessionId = String(message.sessionId || '').trim();
      const decision = String(message.decision || '').trim().toLowerCase();
      if (!sessionId || !['allow', 'deny'].includes(decision)) {
        return;
      }

      await this.deps.requestJson<Record<string, unknown>>(
        'POST',
        `/chat/sessions/${encodeURIComponent(sessionId)}/approvals`,
        { decision }
      );
      panel.webview.postMessage({ type: 'approvalCleared' });
      panel.webview.postMessage({ type: 'status', value: decision === 'allow' ? 'Approval granted. Continuing...' : 'Approval denied.' });
      return;
    }

    if (message?.type !== 'sendMessage') {
      return;
    }

    const attachments = Array.isArray(message.attachments)
      ? message.attachments.filter((attachment: any) => Boolean(attachment?.dataUrl))
      : [];
    const prompt = String(message.prompt || '').trim();
    if (!prompt && attachments.length === 0) {
      return;
    }

    const runtimeProvider = this.deps.getCurrentRuntimeProvider();
    const forceNewThread = Boolean(message.forceNewThread);
    let activeThread = forceNewThread
      ? await this.deps.createLocalChatThread(runtimeProvider)
      : await this.deps.getOrCreateActiveThread(runtimeProvider);
    const bridgeSeedLocalMessages = activeThread.messages.slice();
    const userMessage: LocalChatMessage = {
      id: this.deps.createLocalId('msg'),
      role: 'user',
      content: prompt || this.describeAttachments(attachments),
      createdAt: Date.now(),
    };
    activeThread = await this.deps.appendStoredThreadMessage(activeThread.id, userMessage);

    const modelSelectionId = runtimeProvider === 'osirus'
      ? String(message.modelSelectionId || activeThread.selectedModelId || '').trim()
      : '';
    let submittedOsirusChatId = runtimeProvider === 'osirus'
      ? String(message.osirusChatId || activeThread.osirusChatId || await this.deps.getStoredOpenOsirusChatId() || '').trim()
      : '';
    let selectedOsirusModelOption: OsirusModelOption | null = null;

    if (runtimeProvider === 'osirus') {
      await this.deps.getValidOsirusAccessToken();
      const modelChanged = Boolean(modelSelectionId) && modelSelectionId !== String(activeThread.selectedModelId || '');
      if (modelChanged) {
        submittedOsirusChatId = '';
        activeThread = await this.deps.updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          selectedModelId: modelSelectionId || activeThread.selectedModelId,
          osirusChatId: undefined,
          sessionId: undefined,
        });
        await this.deps.setStoredOpenOsirusChatId(undefined);
      } else if (submittedOsirusChatId !== String(activeThread.osirusChatId || '')) {
        activeThread = await this.deps.updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          selectedModelId: modelSelectionId || activeThread.selectedModelId,
          osirusChatId: submittedOsirusChatId || undefined,
        });
      }
      if (submittedOsirusChatId) {
        await this.deps.setStoredOpenOsirusChatId(submittedOsirusChatId);
      }
      const osirusOptions = await this.deps.fetchOsirusModelOptions();
      selectedOsirusModelOption = osirusOptions.find((option) => option.id === (modelSelectionId || activeThread.selectedModelId || '')) || null;
    }

    let chatContext = this.deps.buildChatContext({
      chatId: runtimeProvider === 'osirus' ? submittedOsirusChatId || activeThread.osirusChatId || '' : '',
      selectedModel: runtimeProvider === 'osirus' ? this.deps.getOsirusModelContext(selectedOsirusModelOption) : undefined,
    });

    panel.webview.postMessage({ type: 'status', value: 'Syncing runtime config...' });
    await this.deps.pushRuntimeConfig({
      modelOverride: runtimeProvider === 'osirus' ? modelSelectionId : undefined,
    });

    let activeSessionId = activeThread.sessionId || '';
    if (activeSessionId) {
      try {
        await this.deps.requestJson<BridgeSessionResponse>('GET', `/chat/sessions/${encodeURIComponent(activeSessionId)}`, undefined, {
          suppressLog: true,
          timeoutMs: 4000,
        });
      } catch (_error) {
        activeSessionId = '';
      }
    }
    if (!activeSessionId) {
      const seed = await this.resolveBridgeSeedMessages(
        runtimeProvider,
        submittedOsirusChatId || activeThread.osirusChatId || '',
        bridgeSeedLocalMessages,
      );
      if (seed.osirusChatIdStale) {
        submittedOsirusChatId = '';
        activeThread = await this.deps.updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          osirusChatId: undefined,
          sessionId: undefined,
        });
        chatContext = this.deps.buildChatContext({
          chatId: '',
          selectedModel: runtimeProvider === 'osirus' ? this.deps.getOsirusModelContext(selectedOsirusModelOption) : undefined,
        });
      }
      const createResponse = await this.deps.requestJson<SessionCreateResponse>('POST', '/chat/sessions', {
        context: chatContext,
        messages: seed.messages,
      });
      activeSessionId = this.deps.extractSessionId(createResponse);
      if (!activeSessionId) {
        throw new Error('Bridge did not return a session id.');
      }
      activeThread = await this.deps.updateStoredThreadMessages(activeThread.id, activeThread.messages, {
        sessionId: activeSessionId,
      });
    }

    panel.webview.postMessage({ type: 'status', value: 'Sending message...' });
    try {
      await this.sendMessage(
        activeSessionId,
        prompt,
        attachments,
        runtimeProvider,
        submittedOsirusChatId || activeThread.osirusChatId || '',
        chatContext
      );
    } catch (sendError) {
      const msg = this.deps.getErrorMessage(sendError).toLowerCase();
      const shouldResetOsirusChat = runtimeProvider === 'osirus' && (msg.includes('thread not found') || msg.includes('chat not found'));
      if (shouldResetOsirusChat) {
        submittedOsirusChatId = '';
        await this.deps.setStoredOpenOsirusChatId(undefined);
        activeThread = await this.deps.updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          osirusChatId: undefined,
          sessionId: undefined,
        });
      }
      if (!msg.includes('session') && !msg.includes('not found')) {
        throw sendError;
      }

      const seed = await this.resolveBridgeSeedMessages(
        runtimeProvider,
        submittedOsirusChatId || activeThread.osirusChatId || '',
        bridgeSeedLocalMessages,
      );
      if (seed.osirusChatIdStale) {
        submittedOsirusChatId = '';
        activeThread = await this.deps.updateStoredThreadMessages(activeThread.id, activeThread.messages, {
          osirusChatId: undefined,
          sessionId: undefined,
        });
        chatContext = this.deps.buildChatContext({
          chatId: '',
          selectedModel: runtimeProvider === 'osirus' ? this.deps.getOsirusModelContext(selectedOsirusModelOption) : undefined,
        });
      }
      const createResponse = await this.deps.requestJson<SessionCreateResponse>('POST', '/chat/sessions', {
        context: chatContext,
        messages: seed.messages,
      });
      activeSessionId = this.deps.extractSessionId(createResponse);
      if (!activeSessionId) {
        throw new Error('Bridge did not return a replacement session id.');
      }
      activeThread = await this.deps.updateStoredThreadMessages(activeThread.id, activeThread.messages, {
        sessionId: activeSessionId,
      });
      await this.sendMessage(
        activeSessionId,
        prompt,
        attachments,
        runtimeProvider,
        submittedOsirusChatId || activeThread.osirusChatId || '',
        chatContext
      );
    }

    panel.webview.postMessage({ type: 'status', value: 'Waiting for Codex reply...' });
    let streamedAssistantText = '';
    let startedAssistantRender = false;
    const ensureAssistantRenderStarted = (): void => {
      if (startedAssistantRender) {
        return;
      }
      startedAssistantRender = true;
      panel.webview.postMessage({ type: 'assistantStart' });
    };
    ensureAssistantRenderStarted();
    const progressMessages: string[] = [];
    let completedTurn: { session: BridgeSessionRecord; assistantText: string };
    try {
      completedTurn = await this.deps.streamBridgeSession(activeSessionId, {
        onAssistantStart: () => {
          ensureAssistantRenderStarted();
        },
        onAssistantDelta: (delta) => {
          ensureAssistantRenderStarted();
          streamedAssistantText += String(delta || '');
          panel.webview.postMessage({ type: 'assistantDelta', value: delta });
        },
        onApprovalChange: (approval) => {
          if (approval) {
            panel.webview.postMessage({
              type: 'approvalRequest',
              value: {
                sessionId: activeSessionId,
                approval,
              },
            });
            panel.webview.postMessage({ type: 'status', value: 'Waiting for approval...' });
            return;
          }

          panel.webview.postMessage({ type: 'approvalCleared' });
        },
        onSessionEvent: (event) => {
          const progressMessage = this.resolveProgressMessage(event);
          if (progressMessage) {
            if (!progressMessages.length || progressMessages[progressMessages.length - 1] !== progressMessage) {
              progressMessages.push(progressMessage);
            }
            panel.webview.postMessage({
              type: 'assistantProgress',
              value: progressMessage,
            });
          }
          const editActivity = this.resolveEditActivity(event);
          if (editActivity) {
            panel.webview.postMessage({
              type: 'assistantActivity',
              value: editActivity,
            });
          }
        },
      });
    } catch (error) {
      const streamedAssistant = String(streamedAssistantText || '').trim();
      const errorMessage = this.deps.getErrorMessage(error);
      if (!streamedAssistant || !/without returning an assistant message/i.test(errorMessage)) {
        throw error;
      }

      const payload = await this.deps.requestJson<BridgeSessionResponse>('GET', `/chat/sessions/${encodeURIComponent(activeSessionId)}`, undefined, {
        suppressLog: true,
        timeoutMs: 5000,
      });
      completedTurn = {
        session: payload.session || { id: activeSessionId, messages: [] },
        assistantText: streamedAssistant,
      };
    }

    const resolvedOsirusChatId = runtimeProvider === 'osirus'
      ? this.extractOsirusChatId(completedTurn.session) || submittedOsirusChatId || activeThread.osirusChatId || ''
      : '';
    const nextLocalMessages = progressMessages.reduce<LocalChatMessage[]>((messages, progressMessage) => {
      const content = String(progressMessage || '').trim();
      if (!content) {
        return messages;
      }
      const lastMessage = messages[messages.length - 1];
      if (lastMessage?.role === 'assistant' && String(lastMessage.content || '').trim() === content) {
        return messages;
      }
      return [
        ...messages,
        {
          id: this.deps.createLocalId('msg'),
          role: 'assistant',
          content,
          createdAt: Date.now(),
        },
      ];
    }, activeThread.messages.slice());
    activeThread = await this.deps.updateStoredThreadMessages(
      activeThread.id,
      resolveCompletedLocalMessagesFromStream(nextLocalMessages, completedTurn.assistantText),
      {
        sessionId: activeSessionId,
        osirusChatId: runtimeProvider === 'osirus' ? (resolvedOsirusChatId || undefined) : activeThread.osirusChatId,
      }
    );

    if (runtimeProvider === 'osirus') {
      await this.deps.setStoredOpenOsirusChatId(resolvedOsirusChatId || undefined);
    }

    panel.webview.postMessage({ type: 'assistantDone', value: completedTurn.assistantText });
    panel.webview.postMessage({ type: 'assistantActivity', value: null });
    panel.webview.postMessage({
      type: 'statePatch',
      payload: await this.deps.panelStateService.buildState(),
      preserveRenderedMessages: true,
    });
    panel.webview.postMessage({ type: 'status', value: '' });
  }

  private async sendMessage(
    sessionId: string,
    prompt: string,
    attachments: WebviewAttachment[],
    runtimeProvider: RuntimeProvider,
    chatId: string,
    chatContext: Record<string, unknown>
  ): Promise<void> {
    await this.deps.requestJson<Record<string, unknown>>(
      'POST',
      `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        message: prompt,
        attachments,
        chatId: runtimeProvider === 'osirus' ? chatId : '',
        osirusChatId: runtimeProvider === 'osirus' ? chatId : '',
        context: chatContext,
      }
    );
  }

  private describeAttachments(attachments: WebviewAttachment[]): string {
    if (!attachments.length) {
      return '';
    }

    if (attachments.length === 1) {
      return `[Attachment] ${attachments[0].name}`;
    }

    return `[Attachments] ${attachments.map((attachment) => attachment.name).join(', ')}`;
  }

  private extractOsirusChatId(session: BridgeSessionRecord | null | undefined): string {
    if (!session || typeof session !== 'object') {
      return '';
    }

    const record = session as Record<string, unknown>;
    const candidates = [
      record.thread_id,
      record.threadId,
      (record.context && typeof record.context === 'object') ? (record.context as Record<string, unknown>).chat_id : '',
      (record.context && typeof record.context === 'object') ? (record.context as Record<string, unknown>).osirus_chat_id : '',
    ];

    for (const candidate of candidates) {
      const value = String(candidate || '').trim();
      if (value) {
        return value;
      }
    }

    return '';
  }

  private resolveEditActivity(event: Record<string, unknown> | null | undefined): { label: string; path?: string } | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const type = String(event.type || '').trim().toLowerCase();
    let rawPath = '';
    let lineNumber = 0;
    let itemType = '';

    if (type === 'item.completed') {
      const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : {};
      itemType = String(item.type || event.preview || '').trim().toLowerCase();
      rawPath = String(item.path || '').trim() || this.extractPathFromText(String(item.text || ''));
      lineNumber = Number(item.line_number || 0) || 0;
    } else if (type === 'bridge.tool.result') {
      const tool = event.tool && typeof event.tool === 'object' ? event.tool as Record<string, unknown> : {};
      const result = tool.result && typeof tool.result === 'object' ? tool.result as Record<string, unknown> : {};
      itemType = String(tool.name || result.tool || '').trim().toLowerCase();
      rawPath = String(result.path || result.destination_path || result.source_path || '').trim();
      lineNumber = Number(result.line_number || 0) || 0;
    } else {
      return null;
    }

    if (!ChatPanelController.FILE_EDIT_EVENT_TYPES.has(itemType)) {
      return null;
    }

    const filename = rawPath
      ? rawPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rawPath
      : 'workspace files';

    return {
      label: lineNumber > 0 ? `Editing ${filename} (line ${lineNumber})` : `Editing ${filename}`,
      path: rawPath || undefined,
    };
  }

  private resolveProgressMessage(event: Record<string, unknown> | null | undefined): string {
    if (!event || typeof event !== 'object') {
      return '';
    }

    const type = String(event.type || '').trim().toLowerCase();
    if (type === 'bridge.planner.step') {
      return String(event.preview || '').trim();
    }

    if (type !== 'bridge.tool.result') {
      return '';
    }

    const tool = event.tool && typeof event.tool === 'object' ? event.tool as Record<string, unknown> : {};
    const result = tool.result && typeof tool.result === 'object' ? tool.result as Record<string, unknown> : {};
    const toolName = String(tool.name || result.tool || '').trim();
    const lineNumber = Number(result.line_number || 0) || 0;
    const path = String(
      result.path
      || result.destination_path
      || result.source_path
      || ''
    ).trim();
    const linkedTarget = path
      ? `[${path}${lineNumber > 0 ? ` (line ${lineNumber})` : ''}](${path}${lineNumber > 0 ? `:${lineNumber}` : ''})`
      : '';

    if (ChatPanelController.FILE_EDIT_EVENT_TYPES.has(toolName)) {
      if (linkedTarget) {
        return `Updated ${linkedTarget}.`;
      }
      return String(event.preview || `Ran ${toolName}`).trim();
    }

    if (toolName === 'read_file' && linkedTarget) {
      return `Reviewed ${linkedTarget}.`;
    }
    if (toolName === 'read_multiple_files') {
      const files = Array.isArray(result.files) ? result.files.length : 0;
      return files > 0 ? `Explored ${files} files.` : 'Explored workspace files.';
    }
    if (toolName === 'find_files') {
      const files = Array.isArray(result.files) ? result.files.length : 0;
      return files > 0 ? `Found ${files} files.` : 'Searched the workspace files.';
    }
    if (toolName === 'search_text') {
      return 'Searched the workspace text.';
    }
    if (toolName === 'read_directory') {
      const entries = Array.isArray(result.entries) ? result.entries.length : 0;
      return entries > 0 ? `Explored ${entries} files and folders.` : 'Explored the workspace directory.';
    }

    return String(event.preview || '').trim();
  }

  private extractPathFromText(value: string): string {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }

    const match = text.match(/((?:\/|\.\/|\.\.\/|[A-Za-z]:[\\/])[^\s"'()]+(?:\.[A-Za-z0-9._-]+)?)/);
    return match ? String(match[1] || '').trim() : '';
  }
}
