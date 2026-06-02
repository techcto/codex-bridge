import * as vscode from 'vscode';
import {
  deriveThreadTitle,
  sanitizeLocalChatMessage,
  sanitizeLocalChatThread,
  summarizeThreadFromMessages,
} from '../chat/localThreads';
import type { LocalChatMessage, LocalChatThread, RuntimeProvider } from '../types';

const CHAT_THREADS_GLOBAL_STATE_KEY = 'codexBridge.chatThreads';
const ACTIVE_THREAD_STATE_KEY_PREFIX = 'codexBridge.activeThread';
const OSIRUS_OPEN_CHAT_ID_STATE_KEY = 'codexBridge.osirusChatId';
const MAX_STORED_THREADS = 60;

export type LocalThreadStoreDeps = {
  context: vscode.ExtensionContext;
  getStoredOsirusActiveOrgId: () => Promise<string>;
  normalizeRole: (value: unknown) => 'user' | 'assistant' | 'system' | null;
};

export class LocalThreadStore {
  private readonly context: vscode.ExtensionContext;
  private readonly getStoredOsirusActiveOrgId: () => Promise<string>;
  private readonly normalizeRole: (value: unknown) => 'user' | 'assistant' | 'system' | null;

  public constructor(deps: LocalThreadStoreDeps) {
    this.context = deps.context;
    this.getStoredOsirusActiveOrgId = deps.getStoredOsirusActiveOrgId;
    this.normalizeRole = deps.normalizeRole;
  }

  public createLocalId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  public getWorkspaceFingerprint(): string {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
      return 'global';
    }

    return folders.map((folder) => folder.uri.fsPath).sort().join('|');
  }

  public async getThreadScopeKey(provider: RuntimeProvider): Promise<string> {
    if (provider === 'osirus') {
      const orgId = String(await this.getStoredOsirusActiveOrgId()).trim();
      return `osirus:${this.getWorkspaceFingerprint()}::org:${orgId || 'none'}`;
    }

    return this.getWorkspaceFingerprint();
  }

  public async getStoredChatThreads(): Promise<LocalChatThread[]> {
    const raw = this.context.globalState.get<unknown[]>(CHAT_THREADS_GLOBAL_STATE_KEY, []);
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .map((thread) => sanitizeLocalChatThread(thread, {
        createLocalId: (prefix) => this.createLocalId(prefix),
        getWorkspaceFingerprint: () => this.getWorkspaceFingerprint(),
        normalizeRole: this.normalizeRole,
      }))
      .filter((thread): thread is LocalChatThread => Boolean(thread));
  }

  public async saveStoredChatThreads(threads: LocalChatThread[]): Promise<void> {
    const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED_THREADS);
    await this.context.globalState.update(CHAT_THREADS_GLOBAL_STATE_KEY, sorted);
  }

  public async upsertStoredChatThread(thread: LocalChatThread): Promise<LocalChatThread> {
    const threads = await this.getStoredChatThreads();
    const nextThreads = threads.filter((entry) => entry.id !== thread.id);
    nextThreads.unshift(thread);
    await this.saveStoredChatThreads(nextThreads);
    return thread;
  }

  public async getStoredChatThread(threadId: string): Promise<LocalChatThread | undefined> {
    const threads = await this.getStoredChatThreads();
    return threads.find((thread) => thread.id === threadId);
  }

  public getCurrentProviderWorkspaceThreads(threads: LocalChatThread[], provider: RuntimeProvider): LocalChatThread[] {
    return threads.filter((thread) => thread.provider === provider);
  }

  public async getActiveThreadIdForProvider(provider: RuntimeProvider): Promise<string> {
    const key = await this.getActiveThreadStateKey(provider);
    return String(this.context.workspaceState.get<string>(key) || '').trim();
  }

  public async setActiveThreadIdForProvider(provider: RuntimeProvider, threadId?: string): Promise<void> {
    const key = await this.getActiveThreadStateKey(provider);
    await this.context.workspaceState.update(key, threadId || undefined);
  }

  public async getStoredOpenOsirusChatId(): Promise<string> {
    return String(this.context.workspaceState.get<string>(OSIRUS_OPEN_CHAT_ID_STATE_KEY) || '').trim();
  }

  public async setStoredOpenOsirusChatId(chatId?: string): Promise<void> {
    const normalizedChatId = String(chatId || '').trim();
    await this.context.workspaceState.update(OSIRUS_OPEN_CHAT_ID_STATE_KEY, normalizedChatId || undefined);
  }

  public async createLocalChatThread(provider: RuntimeProvider, seed?: Partial<LocalChatThread>): Promise<LocalChatThread> {
    const scopeKey = await this.getThreadScopeKey(provider);
    const now = Date.now();
    const thread: LocalChatThread = {
      id: seed?.id || this.createLocalId('thread'),
      provider,
      title: seed?.title || 'New chat',
      summary: seed?.summary || '',
      workspaceFingerprint: seed?.workspaceFingerprint || scopeKey,
      createdAt: seed?.createdAt || now,
      updatedAt: seed?.updatedAt || now,
      sessionId: seed?.sessionId,
      osirusChatId: seed?.osirusChatId,
      selectedModelId: seed?.selectedModelId,
      messages: Array.isArray(seed?.messages) ? seed!.messages! : [],
    };

    await this.upsertStoredChatThread(thread);
    await this.setActiveThreadIdForProvider(provider, thread.id);
    return thread;
  }

  public async getOrCreateActiveThread(provider: RuntimeProvider): Promise<LocalChatThread> {
    const threads = this.getCurrentProviderWorkspaceThreads(await this.getStoredChatThreads(), provider);
    const scopeKey = await this.getThreadScopeKey(provider);
    const activeThreadId = await this.getActiveThreadIdForProvider(provider);
    const activeThread = threads.find((thread) => thread.id === activeThreadId && thread.workspaceFingerprint === scopeKey);
    if (activeThread) {
      return activeThread;
    }

    const latestThread = threads.find((thread) => thread.workspaceFingerprint === scopeKey);
    if (latestThread) {
      await this.setActiveThreadIdForProvider(provider, latestThread.id);
      return latestThread;
    }

    return this.createLocalChatThread(provider);
  }

  public async updateStoredThreadMessages(
    threadId: string,
    messages: LocalChatMessage[],
    options?: Partial<Pick<LocalChatThread, 'title' | 'summary' | 'sessionId' | 'osirusChatId' | 'selectedModelId'>>
  ): Promise<LocalChatThread> {
    const thread = await this.getStoredChatThread(threadId);
    if (!thread) {
      throw new Error(`Unable to find local chat thread ${threadId}.`);
    }

    const lastMessageText = messages[messages.length - 1]?.content || '';
    const hasOption = (key: keyof Pick<LocalChatThread, 'title' | 'summary' | 'sessionId' | 'osirusChatId' | 'selectedModelId'>): boolean =>
      Boolean(options && Object.prototype.hasOwnProperty.call(options, key));
    const title = hasOption('title') && options?.title
      ? options.title
      : deriveThreadTitle(thread.messages[0]?.content || messages[0]?.content || thread.title);
    const summary = hasOption('summary') && options?.summary
      ? options.summary
      : summarizeThreadFromMessages(messages) || thread.summary || lastMessageText;
    const nextThread: LocalChatThread = {
      ...thread,
      title,
      summary,
      messages: messages
        .map((message) => sanitizeLocalChatMessage(message, {
          createLocalId: (prefix) => this.createLocalId(prefix),
          normalizeRole: this.normalizeRole,
        }))
        .filter((message): message is LocalChatMessage => Boolean(message)),
      updatedAt: Date.now(),
      sessionId: hasOption('sessionId') ? options?.sessionId : thread.sessionId,
      osirusChatId: hasOption('osirusChatId') ? options?.osirusChatId : thread.osirusChatId,
      selectedModelId: hasOption('selectedModelId') ? options?.selectedModelId : thread.selectedModelId,
    };

    return this.upsertStoredChatThread(nextThread);
  }

  public async appendStoredThreadMessage(
    threadId: string,
    message: LocalChatMessage,
    options?: Partial<Pick<LocalChatThread, 'sessionId' | 'osirusChatId' | 'selectedModelId'>>
  ): Promise<LocalChatThread> {
    const thread = await this.getStoredChatThread(threadId);
    if (!thread) {
      throw new Error(`Unable to find local chat thread ${threadId}.`);
    }

    const nextMessage = sanitizeLocalChatMessage(message, {
      createLocalId: (prefix) => this.createLocalId(prefix),
      normalizeRole: this.normalizeRole,
    });
    if (!nextMessage) {
      throw new Error('Chat message was not valid.');
    }
    return this.updateStoredThreadMessages(threadId, [...thread.messages, nextMessage], options);
  }

  private async getActiveThreadStateKey(provider: RuntimeProvider): Promise<string> {
    const scopeKey = await this.getThreadScopeKey(provider);
    return `${ACTIVE_THREAD_STATE_KEY_PREFIX}.${provider}.${scopeKey}`;
  }
}
