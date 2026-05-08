import type {
  OsirusChatHistoryMessage,
  OsirusChatSnapshot,
  OsirusModelOption,
  WebviewAttachment,
} from '../types';

export type OsirusChatServiceDeps = {
  getAccountApiBaseUrl: () => string;
  getErrorMessage: (error: unknown) => string;
  getStoredActiveOrgId: () => Promise<string>;
  getValidAccessToken: () => Promise<string>;
  getSavedSelectedModelId: () => Promise<string>;
  outputChannel?: { appendLine(value: string): void };
  requestOsirusJson: <T>(
    method: string,
    path: string,
    body?: BodyInit | Record<string, unknown>,
    init?: { headers?: Record<string, string> }
  ) => Promise<T>;
  setSavedSelectedModelId: (value: string) => Promise<void>;
};

export class OsirusChatService {
  private readonly deps: OsirusChatServiceDeps;
  private modelOptionsCache: OsirusModelOption[] | null = null;
  private modelOptionsCacheOrgId = '';
  private modelOptionsFetchedAt = 0;
  private modelOptionsPromise: Promise<OsirusModelOption[]> | null = null;
  private modelOptionsPromiseOrgId = '';

  public constructor(deps: OsirusChatServiceDeps) {
    this.deps = deps;
  }

  public async fetchModelOptions(): Promise<OsirusModelOption[]> {
    const activeOrgId = String(await this.deps.getStoredActiveOrgId()).trim();
    const now = Date.now();
    if (
      this.modelOptionsCache &&
      this.modelOptionsCacheOrgId === activeOrgId &&
      now - this.modelOptionsFetchedAt < 30000
    ) {
      return this.modelOptionsCache;
    }

    if (this.modelOptionsPromise && this.modelOptionsPromiseOrgId === activeOrgId) {
      return this.modelOptionsPromise;
    }

    const requestPromise = this.fetchModelOptionsUncached(activeOrgId);
    this.modelOptionsPromise = requestPromise;
    this.modelOptionsPromiseOrgId = activeOrgId;

    try {
      const options = await requestPromise;
      this.modelOptionsCache = options;
      this.modelOptionsCacheOrgId = activeOrgId;
      this.modelOptionsFetchedAt = Date.now();
      return options;
    } finally {
      if (this.modelOptionsPromise === requestPromise) {
        this.modelOptionsPromise = null;
        this.modelOptionsPromiseOrgId = '';
      }
    }
  }

  private async fetchModelOptionsUncached(activeOrgId: string): Promise<OsirusModelOption[]> {
    this.deps.outputChannel?.appendLine(`[bridge] loading Osirus model options for org=${activeOrgId || '(none)'}`);
    let productsPayload: any = {};
    try {
      productsPayload = this.normalizeApiData(await this.deps.requestOsirusJson<any>(
        'GET',
        '/products?supports_chat=true&isPublic=true&limit=50&page=1'
      ));
    } catch (error) {
      this.deps.outputChannel?.appendLine(`[bridge] failed to load Osirus product models: ${this.deps.getErrorMessage(error)}`);
    }

    let providersPayload: any = {};
    try {
      providersPayload = this.normalizeApiData(await this.deps.requestOsirusJson<any>(
        'GET',
        '/provider?include=my_settings&is_connected=true&has_chat=true&limit=1000&page=1'
      ));
    } catch (error) {
      this.deps.outputChannel?.appendLine(`[bridge] failed to load Osirus provider settings: ${this.deps.getErrorMessage(error)}`);
    }

    const options: OsirusModelOption[] = [];
    const results = Array.isArray(productsPayload?.results) ? productsPayload.results : [];
    for (const product of results) {
      const productId = String(product?.id || '').trim();
      if (!productId) {
        continue;
      }

      const modelSlug = String(product?.modelSetting?.modelSlug || product?.slug || '').trim();
      options.push({
        id: `product:${productId}`,
        label: String(product?.name || productId),
        kind: 'product',
        productId,
        modelSlug,
        providerKey: String(product?.modelSetting?.provider || '').trim() || undefined,
        hasStream: Boolean(product?.modelSetting?.hasStream),
        conversationMode: this.normalizeConversationMode(product?.conversation_mode) || 'chat',
        llmContent: typeof product?.llm_content === 'string' ? product.llm_content : undefined,
        generationMode: typeof product?.generation_mode === 'string' ? product.generation_mode : undefined,
        searchId: typeof product?.search_id === 'string' ? product.search_id : undefined,
        recipients: Array.isArray(product?.recipients) ? product.recipients : undefined,
      });
    }

    const providers = Array.isArray(providersPayload?.results) ? providersPayload.results : [];
    for (const provider of providers) {
      const providerKey = String(provider?.key || '').trim();
      if (!providerKey) {
        continue;
      }

      const providerLabel = String(provider?.label || provider?.name || providerKey).trim();
      const settings = Array.isArray(provider?.mySettings)
        ? provider.mySettings
        : Array.isArray(provider?.my_settings)
          ? provider.my_settings
          : [];

      for (const setting of settings) {
        const providerSettingId = String(setting?.id || '').trim();
        if (!providerSettingId) {
          continue;
        }

        let modelsPayload: any = {};
        try {
          modelsPayload = this.normalizeApiData(await this.deps.requestOsirusJson<any>(
            'GET',
            `/provider/${encodeURIComponent(providerKey)}/settings/${encodeURIComponent(providerSettingId)}/models?limit=200`
          ));
        } catch (error) {
          this.deps.outputChannel?.appendLine(
            `[bridge] failed to load Osirus provider models provider=${providerKey} setting=${providerSettingId}: ${this.deps.getErrorMessage(error)}`
          );
          continue;
        }
        const models = Array.isArray(modelsPayload?.models)
          ? modelsPayload.models
          : Array.isArray(modelsPayload?.results)
            ? modelsPayload.results
            : Array.isArray(modelsPayload?.data?.models)
              ? modelsPayload.data.models
              : [];

        for (const model of models) {
          const modelId = String(model?.id || model?.modelId || model?.model_id || '').trim();
          if (!modelId) {
            continue;
          }

          options.push({
            id: `provider:${providerSettingId}:${modelId}`,
            label: `${String(model?.name || modelId)} (${providerLabel})`,
            kind: 'provider',
            providerSettingId,
            modelId,
            modelSlug: String(model?.modelSlug || model?.slug || modelId).trim(),
            providerKey,
            hasStream: Boolean(model?.hasStream),
            conversationMode: this.normalizeConversationMode(model?.conversation_mode) || 'chat',
            llmContent: typeof model?.llm_content === 'string' ? model.llm_content : undefined,
            generationMode: typeof model?.generation_mode === 'string' ? model.generation_mode : undefined,
            searchId: typeof model?.search_id === 'string' ? model.search_id : undefined,
            recipients: Array.isArray(model?.recipients) ? model.recipients : undefined,
          });
        }
      }
    }

    const deduped = new Map<string, OsirusModelOption>();
    for (const option of options) {
      if (!deduped.has(option.id)) {
        deduped.set(option.id, option);
      }
    }

    return Array.from(deduped.values());
  }

  public async fetchChatSnapshot(chatId: string): Promise<OsirusChatSnapshot> {
    const resolvedChatId = String(chatId || '').trim();
    if (!resolvedChatId || resolvedChatId === 'new') {
      return {
        chatId: resolvedChatId,
        title: '',
        messages: [],
      };
    }

    const payload = this.normalizeApiData(await this.deps.requestOsirusJson<any>(
      'GET',
      `/chat/${encodeURIComponent(resolvedChatId)}?context_scope=chat`,
      undefined,
      {
        headers: {
          'x-osirus-chat-scope': 'chat',
        },
      }
    ));
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const normalizedMessages = messages
      .map((message: any) => {
        const role = this.normalizeHistoryRole(message?.role);
        const content = this.extractMessageText(message);
        const id = String(message?.id || '').trim() || `msg-${Math.random().toString(36).slice(2)}`;
        if (!role || !content) {
          return null;
        }
        return {
          id,
          role,
          content,
          productId: String(message?.productId || message?.product_id || '').trim() || undefined,
          providerSettingId: String(message?.providerSettingId || message?.provider_setting_id || '').trim() || undefined,
          modelId: String(message?.modelId || message?.model_id || '').trim() || undefined,
          modelSlug: String(message?.modelSlug || message?.model_slug || '').trim() || undefined,
        };
      })
      .filter((message: OsirusChatHistoryMessage | null): message is OsirusChatHistoryMessage => Boolean(message));

    return {
      chatId: String(payload?.id || payload?.chat?.id || resolvedChatId).trim() || resolvedChatId,
      title: String(payload?.name || payload?.chat?.name || '').trim(),
      messages: normalizedMessages,
    };
  }

  public async fetchChatHistory(chatId: string): Promise<OsirusChatHistoryMessage[]> {
    return (await this.fetchChatSnapshot(chatId)).messages;
  }

  public async sendChatMessage(
    prompt: string,
    modelSelectionId: string,
    existingChatId?: string
  ): Promise<{ chatId: string; assistantText: string; options: OsirusModelOption[]; selectedModelId: string }> {
    const options = await this.fetchModelOptions();
    const matched = options.find((option) => option.id === modelSelectionId) || options[0];
    if (!matched) {
      throw new Error('No Osirus chat models are available for this account.');
    }
    const selected = this.preferProductOption(matched, options);

    await this.deps.setSavedSelectedModelId(selected.id);

    const resolvedChatId = String(existingChatId || '').trim() || 'new';
    const formData = this.buildChatFormData(prompt, resolvedChatId, selected);
    this.deps.outputChannel?.appendLine(`[bridge] osirus send chatId=${resolvedChatId} model=${selected.id}`);

    const payload = this.normalizeApiData(await this.deps.requestOsirusJson<any>(
      'POST',
      `/chat/${encodeURIComponent(resolvedChatId)}/messages?context_scope=chat`,
      formData,
      {
        headers: {
          'x-osirus-chat-scope': 'chat',
        },
      }
    ));

    const responseChatId = String(payload?.chat?.id || payload?.chatId || '').trim();
    const assistantContent = payload?.message?.content;
    const assistantText =
      typeof assistantContent === 'string'
        ? assistantContent.trim()
        : typeof payload?.message?.text === 'string'
          ? String(payload.message.text).trim()
          : '';

    if (!responseChatId) {
      throw new Error('Osirus did not return a chat id.');
    }

    if (!assistantText) {
      throw new Error('Osirus returned a chat response without assistant text.');
    }

    return {
      chatId: responseChatId,
      assistantText,
      options,
      selectedModelId: selected.id,
    };
  }

  public async streamChatMessage(
    prompt: string,
    modelSelectionId: string,
    onDelta: (delta: string) => void,
    existingChatId?: string,
    attachments: WebviewAttachment[] = []
  ): Promise<{ chatId: string; assistantText: string; options: OsirusModelOption[]; selectedModelId: string }> {
    const options = await this.fetchModelOptions();
    const matched = options.find((option) => option.id === modelSelectionId) || options[0];
    if (!matched) {
      throw new Error('No Osirus chat models are available for this account.');
    }
    const selected = this.preferProductOption(matched, options);

    await this.deps.setSavedSelectedModelId(selected.id);

    const resolvedChatId = String(existingChatId || '').trim() || 'new';
    const formData = this.buildChatFormData(prompt, resolvedChatId, selected, attachments, {
      stream: true,
    });
    this.deps.outputChannel?.appendLine(`[bridge] osirus stream chatId=${resolvedChatId} model=${selected.id}`);

    const token = await this.deps.getValidAccessToken();
    const url = `${this.deps.getAccountApiBaseUrl()}/chat/${encodeURIComponent(resolvedChatId)}/messages?context_scope=chat`;
    this.deps.outputChannel?.appendLine(`[bridge] -> POST ${url} body="[form-data stream]"`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${token}`,
        'x-osirus-chat-scope': 'chat',
      },
      body: formData,
    });

    if (!response.ok || !response.body) {
      const raw = await response.text();
      throw new Error(raw || `Osirus streaming chat failed with status ${response.status}.`);
    }

    let responseChatId = resolvedChatId === 'new' ? '' : resolvedChatId;
    let assistantText = '';
    await this.consumeSseStream(response.body, (eventName, payload) => {
      const data = this.normalizeApiData(payload);
      if (eventName === 'chat_created' || (eventName === 'message' && typeof data === 'object' && data && 'type' in (data as Record<string, unknown>) && (data as Record<string, unknown>).type === 'chat_created')) {
        const nextChatId = String((data as any)?.chatId || '').trim();
        if (nextChatId) {
          responseChatId = nextChatId;
        }
        return;
      }
      if (eventName === 'delta') {
        const delta = String((data as any)?.delta || '');
        if (delta) {
          assistantText += delta;
          onDelta(delta);
        }
      }
    });

    if (!responseChatId) {
      throw new Error('Osirus did not return a chat id while streaming.');
    }

    if (!assistantText.trim()) {
      throw new Error('Osirus stream ended before any assistant text was received.');
    }

    return {
      chatId: responseChatId,
      assistantText,
      options,
      selectedModelId: selected.id,
    };
  }

  public getModelContext(option: OsirusModelOption | null | undefined): Record<string, unknown> | undefined {
    if (!option) {
      return undefined;
    }

    return {
      id: option.id,
      kind: option.kind,
      label: option.label,
      product_id: option.productId || '',
      provider_setting_id: option.providerSettingId || '',
      model_id: option.modelId || '',
      model_slug: option.modelSlug || '',
      provider_key: option.providerKey || '',
      conversation_mode: option.conversationMode || '',
      llm_content: option.llmContent || '',
      generation_mode: option.generationMode || '',
      search_id: option.searchId || '',
      recipients: Array.isArray(option.recipients) ? option.recipients : [],
    };
  }

  private preferProductOption(selected: OsirusModelOption, options: OsirusModelOption[]): OsirusModelOption {
    if (selected.kind === 'product') {
      return selected;
    }

    const selectedSlug = String(selected.modelSlug || selected.modelId || '').trim().toLowerCase();
    const selectedProvider = String(selected.providerKey || '').trim().toLowerCase();
    if (!selectedSlug) {
      return selected;
    }

    const productMatch = options.find((option) =>
      option.kind === 'product' &&
      String(option.modelSlug || '').trim().toLowerCase() === selectedSlug &&
      (!selectedProvider || String(option.providerKey || '').trim().toLowerCase() === selectedProvider)
    );

    return productMatch || selected;
  }

  private buildChatFormData(
    prompt: string,
    chatId: string,
    selected: OsirusModelOption,
    attachments: WebviewAttachment[] = [],
    options?: { stream?: boolean }
  ): FormData {
    const formData = new FormData();
    formData.append('chatId', chatId);
    formData.append('content', prompt);
    formData.append('role', 'user');
    formData.append('generate', 'true');
    formData.append('mode', 'chat');
    formData.append('is_stream', options?.stream ? 'true' : 'false');
    this.appendModelSelection(formData, selected);
    if (attachments.length) {
      this.appendAttachments(formData, attachments);
    }
    return formData;
  }

  private appendAttachments(formData: FormData, attachments: WebviewAttachment[]): void {
    for (const attachment of attachments) {
      const name = String(attachment.name || 'attachment').trim() || 'attachment';
      const decoded = this.decodeDataUrlAttachment(attachment.dataUrl);
      const bytes = new Uint8Array(decoded.buffer);
      const blob = new Blob([bytes], {
        type: String(attachment.mimeType || decoded.mimeType || 'application/octet-stream'),
      });
      formData.append('attachments', blob, name);
    }
  }

  private appendModelSelection(formData: FormData, selected: OsirusModelOption): void {
    if (selected.kind === 'product' && selected.productId) {
      formData.append('productId', selected.productId);
      return;
    }

    if (selected.providerSettingId) {
      formData.append('providerSettingId', selected.providerSettingId);
    }
    if (selected.modelId) {
      formData.append('modelId', selected.modelId);
    }
  }

  private decodeDataUrlAttachment(dataUrl: string): { mimeType: string; buffer: Buffer } {
    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error('Attachment data was not a valid base64 data URL.');
    }

    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  private normalizeConversationMode(value: unknown): 'voice' | 'chat' | 'search' | 'copilot' | 'agent' | undefined {
    const normalized = String(value || '').trim().toLowerCase();
    if (
      normalized === 'voice' ||
      normalized === 'chat' ||
      normalized === 'search' ||
      normalized === 'copilot' ||
      normalized === 'agent'
    ) {
      return normalized;
    }
    return undefined;
  }

  private normalizeHistoryRole(value: unknown): 'user' | 'assistant' | 'system' | null {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'user' || normalized === 'assistant' || normalized === 'system') {
      return normalized;
    }
    return null;
  }

  private extractMessageText(message: any): string {
    const content = message?.content;
    if (typeof content === 'string') {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const parts = content
        .map((entry: any) => {
          if (typeof entry === 'string') {
            return entry;
          }
          if (typeof entry?.text === 'string') {
            return entry.text;
          }
          if (typeof entry?.content === 'string') {
            return entry.content;
          }
          return '';
        })
        .filter(Boolean);
      return parts.join('\n').trim();
    }

    if (typeof message?.text === 'string') {
      return String(message.text).trim();
    }

    return '';
  }

  private normalizeApiData(payload: any): any {
    if (Array.isArray(payload)) {
      return payload.map((item) => this.normalizeApiData(item));
    }

    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      out[camelKey] = this.normalizeApiData(value);
    }
    return out;
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
