import {
  mapOsirusHistoryToLocal,
  reconcileOsirusMessages,
  resolveSelectedOsirusModelIdFromHistory,
} from '../chat/localThreads';
import { resolveAgentRuntimeCapability } from '../agentCapabilities';
import type {
  ChatPanelThreadSummary,
  LocalChatMessage,
  LocalChatThread,
  OsirusChatSnapshot,
  OsirusModelOption,
  RuntimeProvider,
} from '../types';

export type ChatPanelStateServiceDeps = {
  buildChatContext: (options?: { chatId?: string; selectedModel?: Record<string, unknown>; includeContent?: boolean }) => Record<string, unknown>;
  createLocalChatThread: (provider: RuntimeProvider, seed?: Partial<LocalChatThread>) => Promise<LocalChatThread>;
  createLocalId: (prefix: string) => string;
  fetchOsirusChatSnapshot: (chatId: string) => Promise<OsirusChatSnapshot>;
  fetchOsirusModelOptions: () => Promise<OsirusModelOption[]>;
  getBaseUrl: () => string;
  getCurrentProviderWorkspaceThreads: (threads: LocalChatThread[], provider: RuntimeProvider) => LocalChatThread[];
  getErrorMessage: (error: unknown) => string;
  getOrCreateActiveThread: (provider: RuntimeProvider) => Promise<LocalChatThread>;
  getSavedOsirusSelectedModelId: () => Promise<string>;
  getStoredChatThreads: () => Promise<LocalChatThread[]>;
  getStoredOpenOsirusChatId: () => Promise<string>;
  getStoredOsirusActiveOrgId: () => Promise<string>;
  getStoredOsirusActiveOrgName: () => Promise<string>;
  getThreadScopeKey: (provider: RuntimeProvider) => Promise<string>;
  hasOsirusAccountSession: () => Promise<boolean>;
  hasSavedApiKey: () => Promise<boolean>;
  mapBridgeSessionMessagesToLocal?: never;
  normalizeRole: (value: unknown) => 'user' | 'assistant' | 'system' | null;
  outputChannel?: { appendLine(value: string): void };
  preferOsirusProductOption: (selected: OsirusModelOption, options: OsirusModelOption[]) => OsirusModelOption;
  runtimeProvider: () => RuntimeProvider;
  setActiveThreadIdForProvider: (provider: RuntimeProvider, threadId?: string) => Promise<void>;
  setStoredOpenOsirusChatId: (chatId?: string) => Promise<void>;
  updateStoredThreadMessages: (
    threadId: string,
    messages: LocalChatMessage[],
    patch?: Partial<LocalChatThread>
  ) => Promise<LocalChatThread>;
};

export class ChatPanelStateService {
  private readonly deps: ChatPanelStateServiceDeps;
  private inFlightBuildState: Promise<Record<string, unknown>> | null = null;
  private cachedOsirusModels:
    | {
      orgId: string;
      options: OsirusModelOption[];
    }
    | null = null;

  public constructor(deps: ChatPanelStateServiceDeps) {
    this.deps = deps;
  }

  public async buildState(): Promise<Record<string, unknown>> {
    if (this.inFlightBuildState) {
      return this.inFlightBuildState;
    }

    const buildPromise = this.buildStateInternal();
    this.inFlightBuildState = buildPromise;

    try {
      return await buildPromise;
    } finally {
      if (this.inFlightBuildState === buildPromise) {
        this.inFlightBuildState = null;
      }
    }
  }

  private async buildStateInternal(): Promise<Record<string, unknown>> {
    const runtimeProvider = this.deps.runtimeProvider();
    this.deps.outputChannel?.appendLine(`[bridge] chat state build start provider=${runtimeProvider}`);
    const scopeKey = await this.deps.getThreadScopeKey(runtimeProvider);
    const storedThreads = await this.deps.getStoredChatThreads();
    const providerThreads = this.deps.getCurrentProviderWorkspaceThreads(storedThreads, runtimeProvider)
      .filter((thread) => thread.workspaceFingerprint === scopeKey);
    const activeThread = await this.deps.getOrCreateActiveThread(runtimeProvider);
    let refreshedThread = activeThread;
    let osirusModels: OsirusModelOption[] = [];
    let selectedOsirusModelId = '';
    const storedOpenOsirusChatId = runtimeProvider === 'osirus' ? await this.deps.getStoredOpenOsirusChatId() : '';
    let storedActiveOrgId = runtimeProvider === 'osirus' ? await this.deps.getStoredOsirusActiveOrgId() : '';
    let storedActiveOrgName = runtimeProvider === 'osirus' ? await this.deps.getStoredOsirusActiveOrgName() : '';

    if (runtimeProvider === 'osirus' && storedOpenOsirusChatId && storedOpenOsirusChatId !== String(refreshedThread.osirusChatId || '')) {
      const matchingThread = providerThreads.find((thread) => String(thread.osirusChatId || '') === storedOpenOsirusChatId);
      if (matchingThread) {
        refreshedThread = matchingThread;
        await this.deps.setActiveThreadIdForProvider(runtimeProvider, matchingThread.id);
      } else {
        this.deps.outputChannel?.appendLine(`[bridge] ignoring stale stored open Osirus chat id ${storedOpenOsirusChatId}; no local thread matched`);
        await this.deps.setStoredOpenOsirusChatId(undefined);
      }
    }

    const hasOsirusSession = runtimeProvider === 'osirus' && await this.deps.hasOsirusAccountSession();
    const hasOsirusApiKey = runtimeProvider === 'osirus' && await this.deps.hasSavedApiKey();
    const canLoadOsirusModels = runtimeProvider === 'osirus' && (hasOsirusSession || hasOsirusApiKey);
    if (!canLoadOsirusModels) {
      this.cachedOsirusModels = null;
    }

    if (canLoadOsirusModels) {
      try {
        osirusModels = await this.getCachedOsirusModels(storedActiveOrgId);
        this.deps.outputChannel?.appendLine(`[bridge] chat state resolved osirus models=${osirusModels.length}`);
        storedActiveOrgId = await this.deps.getStoredOsirusActiveOrgId();
        storedActiveOrgName = await this.deps.getStoredOsirusActiveOrgName();
        const savedSelectedModelId = String(await this.deps.getSavedOsirusSelectedModelId() || '').trim();
        const threadSelectedModelId = String(refreshedThread.selectedModelId || '').trim();
        selectedOsirusModelId =
          [savedSelectedModelId, threadSelectedModelId].find((candidateId) =>
            candidateId && osirusModels.some((option) => option.id === candidateId)
          )
          || osirusModels[0]?.id
          || '';
        if (selectedOsirusModelId && selectedOsirusModelId !== refreshedThread.selectedModelId) {
          refreshedThread = await this.deps.updateStoredThreadMessages(refreshedThread.id, refreshedThread.messages, {
            selectedModelId: selectedOsirusModelId,
          });
        }
        if (storedOpenOsirusChatId && storedOpenOsirusChatId !== refreshedThread.osirusChatId) {
          refreshedThread = await this.deps.updateStoredThreadMessages(refreshedThread.id, refreshedThread.messages, {
            osirusChatId: storedOpenOsirusChatId,
          });
        }
        if (hasOsirusSession && refreshedThread.osirusChatId) {
          let snapshot: OsirusChatSnapshot | null = null;
          try {
            snapshot = await this.deps.fetchOsirusChatSnapshot(refreshedThread.osirusChatId);
          } catch (error) {
            const errorMessage = this.deps.getErrorMessage(error);
            if (/404/.test(errorMessage)) {
              this.deps.outputChannel?.appendLine(`[bridge] clearing stale Osirus chat id ${refreshedThread.osirusChatId} after 404`);
              await this.deps.setStoredOpenOsirusChatId(undefined);
              refreshedThread = await this.deps.updateStoredThreadMessages(
                refreshedThread.id,
                refreshedThread.messages,
                {
                  osirusChatId: undefined,
                }
              );
            } else {
              throw error;
            }
          }
          if (snapshot) {
          const resolvedHistoryModelId = resolveSelectedOsirusModelIdFromHistory(
            snapshot.messages,
            osirusModels,
            this.deps.preferOsirusProductOption
          );
          const shouldReplaceMessagesFromSnapshot = !refreshedThread.sessionId && refreshedThread.messages.length === 0;
          refreshedThread = await this.deps.updateStoredThreadMessages(
            refreshedThread.id,
            shouldReplaceMessagesFromSnapshot
              ? reconcileOsirusMessages(
                refreshedThread.messages,
                mapOsirusHistoryToLocal(snapshot.messages, this.deps.createLocalId)
              )
              : refreshedThread.messages,
            {
              title: snapshot.title || refreshedThread.title,
              selectedModelId: resolvedHistoryModelId || selectedOsirusModelId || refreshedThread.selectedModelId,
            }
          );
          if (resolvedHistoryModelId) {
            selectedOsirusModelId = resolvedHistoryModelId;
          }
          }
        }
      } catch (error) {
        this.deps.outputChannel?.appendLine(`[bridge] failed to build Osirus chat panel state: ${this.deps.getErrorMessage(error)}`);
      }
    }

    const threads = this.deps.getCurrentProviderWorkspaceThreads(await this.deps.getStoredChatThreads(), runtimeProvider)
      .filter((thread) => thread.workspaceFingerprint === scopeKey)
      .map((thread) => ({
        id: thread.id,
        title: thread.title,
        summary: thread.summary,
        updatedAt: thread.updatedAt,
        provider: thread.provider,
        active: thread.id === refreshedThread.id,
      } as ChatPanelThreadSummary));

    const selectedOsirusModelOption = osirusModels.find((option) => option.id === (selectedOsirusModelId || refreshedThread.selectedModelId || '')) || null;
    const agentRuntime = resolveAgentRuntimeCapability(runtimeProvider, selectedOsirusModelOption);

    const state = {
      baseUrl: this.deps.getBaseUrl(),
      runtimeProvider,
      agentRuntime,
      activeThreadId: refreshedThread.id,
      activeThreadTitle: refreshedThread.title,
      activeSessionId: refreshedThread.sessionId || '',
      osirusChatId: refreshedThread.osirusChatId || '',
      osirusModels: osirusModels.map((option) => ({
        id: option.id,
        label: option.label,
      })),
      selectedOsirusModelId: selectedOsirusModelId || refreshedThread.selectedModelId || '',
      osirusMessages: runtimeProvider === 'osirus' ? refreshedThread.messages : [],
      threads: threads.map((thread) => ({
        ...thread,
        updatedLabel: this.formatThreadTime(thread.updatedAt),
      })),
      messages: refreshedThread.messages,
      context: this.buildUiContext(this.deps.buildChatContext({ includeContent: false })),
      activeOrgName: storedActiveOrgName,
      activeOrgId: storedActiveOrgId,
    };

    this.deps.outputChannel?.appendLine(`[bridge] chat state build done threads=${state.threads.length} models=${state.osirusModels.length} selected=${state.selectedOsirusModelId || '(none)'}`);
    return state;
  }

  private buildUiContext(context: Record<string, unknown>): Record<string, unknown> {
    const currentEntity = context?.current_entity && typeof context.current_entity === 'object'
      ? context.current_entity as Record<string, unknown>
      : {};
    const activeEditor = context?.active_editor && typeof context.active_editor === 'object'
      ? context.active_editor as Record<string, unknown>
      : {};
    const openTabs = Array.isArray(context?.open_tabs)
      ? context.open_tabs
      : [];

    return {
      source: String(context?.source || 'vscode'),
      scope: String(context?.scope || 'editor'),
      current_entity: {
        type: String(currentEntity.type || 'workspace'),
        name: String(currentEntity.name || ''),
        path: String(currentEntity.path || ''),
        language: String(currentEntity.language || ''),
      },
      active_editor: {
        title: String(activeEditor.title || ''),
        route: String(activeEditor.route || ''),
      },
      open_tabs: openTabs.map((tab) => {
        const record = tab && typeof tab === 'object' ? tab as Record<string, unknown> : {};
        return {
          label: String(record.label || record.title || record.name || 'Tab'),
          title: String(record.title || record.name || record.label || 'Tab'),
          path: String(record.path || ''),
          route: String(record.route || record.url || ''),
        };
      }),
    };
  }

  private async getCachedOsirusModels(orgIdHint: string): Promise<OsirusModelOption[]> {
    const cacheKey = String(orgIdHint || '').trim();
    if (cacheKey && this.cachedOsirusModels?.orgId === cacheKey) {
      return this.cachedOsirusModels.options;
    }

    const options = await this.deps.fetchOsirusModelOptions();
    const resolvedOrgId = String(await this.deps.getStoredOsirusActiveOrgId() || cacheKey || 'default').trim();
    this.cachedOsirusModels = {
      orgId: resolvedOrgId,
      options,
    };
    return options;
  }

  private formatThreadTime(value: number): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value));
    } catch (_error) {
      return '';
    }
  }
}
