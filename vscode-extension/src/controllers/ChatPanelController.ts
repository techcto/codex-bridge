import * as vscode from 'vscode';
import {
  resolveCompletedLocalMessages,
  resolveCompletedLocalMessagesFromStream,
} from '../chat/completedTurn';
import { mapBridgeSessionMessagesToLocal } from '../chat/localThreads';
import type {
  BridgeSessionRecord,
  BridgeSessionResponse,
  LocalChatMessage,
  LocalChatThread,
  OsirusModelOption,
  RequestJsonOptions,
  RuntimeProvider,
  SessionCreateResponse,
  WebviewAttachment,
} from '../types';

export type ChatPanelControllerDeps = {
  buildChatContext: (options?: { chatId?: string; selectedModel?: Record<string, unknown>; includeContent?: boolean }) => Record<string, unknown>;
  createLocalChatThread: (provider: RuntimeProvider, seed?: Partial<LocalChatThread>) => Promise<LocalChatThread>;
  createLocalId: (prefix: string) => string;
  extractSessionId: (payload: unknown) => string;
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

  public constructor(deps: ChatPanelControllerDeps) {
    this.deps = deps;
  }

  public async handleMessage(
    panel: vscode.WebviewPanel,
    message: any,
    pushPanelState: () => Promise<void>
  ): Promise<void> {
    if (message?.type === 'ready') {
      await pushPanelState();
      return;
    }

    if (message?.type === 'newThread') {
      const thread = await this.deps.createLocalChatThread(this.deps.getCurrentRuntimeProvider());
      panel.webview.postMessage({ type: 'status', value: `Started ${thread.title.toLowerCase()}.` });
      await pushPanelState();
      return;
    }

    if (message?.type === 'openThread') {
      const threadId = String(message.threadId || '').trim();
      if (!threadId) {
        return;
      }
      const thread = await this.deps.getStoredChatThread(threadId);
      if (!thread || thread.provider !== this.deps.getCurrentRuntimeProvider()) {
        return;
      }
      await this.deps.setActiveThreadIdForProvider(thread.provider, thread.id);
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
    let activeThread = await this.deps.getOrCreateActiveThread(runtimeProvider);
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

    const chatContext = this.deps.buildChatContext({
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
      const createResponse = await this.deps.requestJson<SessionCreateResponse>('POST', '/chat/sessions', {
        context: chatContext,
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

      const createResponse = await this.deps.requestJson<SessionCreateResponse>('POST', '/chat/sessions', {
        context: chatContext,
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
    let completedTurn: { session: BridgeSessionRecord; assistantText: string };
    try {
      completedTurn = await this.deps.streamBridgeSession(activeSessionId, {
        onAssistantStart: () => {
          panel.webview.postMessage({ type: 'assistantStart' });
        },
        onAssistantDelta: (delta) => {
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

    activeThread = await this.deps.updateStoredThreadMessages(
      activeThread.id,
      Array.isArray(completedTurn.session.messages) && completedTurn.session.messages.length
        ? resolveCompletedLocalMessages(
          activeThread.messages,
          mapBridgeSessionMessagesToLocal(completedTurn.session.messages, {
            createLocalId: this.deps.createLocalId,
            normalizeRole: this.deps.normalizeRole,
          }),
          completedTurn.assistantText
        )
        : resolveCompletedLocalMessagesFromStream(activeThread.messages, completedTurn.assistantText),
      {
        sessionId: activeSessionId,
      }
    );

    if (runtimeProvider === 'osirus' && activeThread.osirusChatId) {
      await this.deps.setStoredOpenOsirusChatId(activeThread.osirusChatId);
    }

    panel.webview.postMessage({ type: 'assistantDone', value: completedTurn.assistantText });
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
}
