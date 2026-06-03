import type {
  BridgeSessionRecord,
  LocalChatMessage,
  LocalChatThread,
  OsirusChatHistoryMessage,
  OsirusModelOption,
  RuntimeProvider,
  WebviewAttachment,
} from '../types';

function sanitizeWebviewAttachment(value: any): WebviewAttachment | null {
  const dataUrl = String(value?.dataUrl || value?.data_url || '').trim();
  const name = String(value?.name || 'Attachment').trim() || 'Attachment';
  if (!dataUrl) {
    return null;
  }

  const mimeType = String(value?.mimeType || value?.mime_type || 'application/octet-stream').trim() || 'application/octet-stream';
  const sizeBytes = Number(value?.sizeBytes || value?.size || value?.size_bytes || 0) || 0;
  return {
    id: String(value?.id || name).trim() || name,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
    kind: value?.kind === 'file' ? 'file' : (mimeType.startsWith('image/') ? 'image' : 'file'),
  };
}

export function sanitizeLocalChatMessage(
  value: any,
  options: {
    createLocalId: (prefix: string) => string;
    normalizeRole: (value: unknown) => 'user' | 'assistant' | 'system' | null;
  }
): LocalChatMessage | null {
  const role = options.normalizeRole(value?.role);
  const content = String(value?.content || '').trim();
  const thinking = String(value?.thinking || '').trim();
  const attachments = Array.isArray(value?.attachments)
    ? value.attachments
      .map((attachment: any) => sanitizeWebviewAttachment(attachment))
      .filter((attachment: WebviewAttachment | null): attachment is WebviewAttachment => Boolean(attachment))
    : [];
  if (!role || (!content && !thinking && !attachments.length)) {
    return null;
  }

  return {
    id: String(value?.id || options.createLocalId('msg')).trim(),
    role,
    content,
    attachments: attachments.length ? attachments : undefined,
    thinking: thinking || undefined,
    createdAt: Number(value?.createdAt || value?.created_at || Date.now()) || Date.now(),
  };
}

export function sanitizeLocalChatThread(
  value: any,
  options: {
    createLocalId: (prefix: string) => string;
    getWorkspaceFingerprint: () => string;
    normalizeRole: (value: unknown) => 'user' | 'assistant' | 'system' | null;
  }
): LocalChatThread | null {
  const provider = String(value?.provider || '').trim() as RuntimeProvider;
  const validProvider = ['openai', 'ollama', 'vllm', 'osirus', 'osirus_agent', 'openai_compatible'].includes(provider)
    ? provider
    : null;
  if (!validProvider) {
    return null;
  }

  const messages = Array.isArray(value?.messages)
    ? value.messages
      .map((message: any) => sanitizeLocalChatMessage(message, options))
      .filter((message: LocalChatMessage | null): message is LocalChatMessage => Boolean(message))
    : [];

  return {
    id: String(value?.id || options.createLocalId('thread')).trim(),
    provider: validProvider,
    title: String(value?.title || 'New chat').trim() || 'New chat',
    summary: String(value?.summary || '').trim(),
    workspaceFingerprint: String(value?.workspaceFingerprint || value?.workspace_fingerprint || '').trim() || options.getWorkspaceFingerprint(),
    createdAt: Number(value?.createdAt || value?.created_at || Date.now()) || Date.now(),
    updatedAt: Number(value?.updatedAt || value?.updated_at || Date.now()) || Date.now(),
    sessionId: String(value?.sessionId || '').trim() || undefined,
    osirusChatId: String(value?.osirusChatId || '').trim() || undefined,
    selectedModelId: String(value?.selectedModelId || '').trim() || undefined,
    messages,
  };
}

export function deriveThreadTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return 'New chat';
  }
  return collapsed.length > 48 ? `${collapsed.slice(0, 48).trimEnd()}...` : collapsed;
}

export function summarizeThreadFromMessages(messages: LocalChatMessage[]): string {
  const lastMeaningful = [...messages].reverse().find((message) => message.content.trim() !== '');
  if (!lastMeaningful) {
    return '';
  }
  const collapsed = lastMeaningful.content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 90 ? `${collapsed.slice(0, 90).trimEnd()}...` : collapsed;
}

export function mapBridgeSessionMessagesToLocal(
  messages: BridgeSessionRecord['messages'],
  options: {
    createLocalId: (prefix: string) => string;
    normalizeRole: (value: unknown) => 'user' | 'assistant' | 'system' | null;
  }
): LocalChatMessage[] {
  return (Array.isArray(messages) ? messages : []).reduce<LocalChatMessage[]>((acc, message) => {
    const role = options.normalizeRole(message?.role);
    const content = String(message?.text || '').trim();
    const thinking = String(message?.thinking || '').trim();
    if (!role || (!content && !thinking)) {
      return acc;
    }
    acc.push({
      id: options.createLocalId('msg'),
      role,
      content,
      thinking: thinking || undefined,
      createdAt: Date.now(),
    });
    return acc;
  }, []);
}

export function mapOsirusHistoryToLocal(
  messages: OsirusChatHistoryMessage[],
  createLocalId: (prefix: string) => string
): LocalChatMessage[] {
  return messages.map((message) => ({
    id: message.id || createLocalId('msg'),
    role: message.role,
    content: message.content,
    thinking: undefined,
    createdAt: Date.now(),
  }));
}

export function resolveSelectedOsirusModelIdFromHistory(
  history: OsirusChatHistoryMessage[],
  options: OsirusModelOption[],
  preferOsirusProductOption: (selected: OsirusModelOption, options: OsirusModelOption[]) => OsirusModelOption
): string {
  for (const message of [...history].reverse()) {
    const productId = String(message.productId || '').trim();
    if (productId) {
      const productMatch = options.find((option) => option.kind === 'product' && option.productId === productId);
      if (productMatch) {
        return productMatch.id;
      }
    }

    const providerSettingId = String(message.providerSettingId || '').trim();
    const modelSlug = String(message.modelSlug || message.modelId || '').trim();
    if (providerSettingId && modelSlug) {
      const providerMatch = options.find((option) =>
        option.kind === 'provider' &&
        option.providerSettingId === providerSettingId &&
        String(option.modelSlug || option.modelId || '').trim() === modelSlug
      );
      if (providerMatch) {
        return preferOsirusProductOption(providerMatch, options).id;
      }
    }
  }

  return '';
}

export function shouldKeepLocalOsirusMessages(localMessages: LocalChatMessage[], fetchedMessages: LocalChatMessage[]): boolean {
  if (!localMessages.length) {
    return false;
  }
  if (!fetchedMessages.length) {
    return true;
  }
  if (fetchedMessages.length < localMessages.length) {
    return true;
  }

  const localTail = [...localMessages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim() !== '');
  if (!localTail) {
    return false;
  }

  return !fetchedMessages.some((message) =>
    message.role === 'assistant' &&
    message.content.trim() === localTail.content.trim()
  );
}

export function reconcileOsirusMessages(localMessages: LocalChatMessage[], fetchedMessages: LocalChatMessage[]): LocalChatMessage[] {
  if (shouldKeepLocalOsirusMessages(localMessages, fetchedMessages)) {
    return localMessages;
  }
  return fetchedMessages;
}
