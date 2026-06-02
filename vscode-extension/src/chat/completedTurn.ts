import type { LocalChatMessage } from '../types';

export function hasTrailingAssistantMessage(messages: LocalChatMessage[], assistantText: string): boolean {
  const expected = String(assistantText || '').trim();
  if (!expected) {
    return false;
  }

  const lastMessage = messages[messages.length - 1];
  return Boolean(
    lastMessage &&
    lastMessage.role === 'assistant' &&
    lastMessage.content.trim() === expected
  );
}

export function appendAssistantMessage(messages: LocalChatMessage[], assistantText: string): LocalChatMessage[] {
  const content = String(assistantText || '').trim();
  if (!content || hasTrailingAssistantMessage(messages, content)) {
    return messages;
  }

  return [
    ...messages,
    {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      role: 'assistant',
      content,
      createdAt: Date.now(),
    },
  ];
}

export function resolveCompletedLocalMessages(
  existingMessages: LocalChatMessage[],
  _mappedSessionMessages: LocalChatMessage[],
  assistantText: string
): LocalChatMessage[] {
  return appendAssistantMessage(existingMessages, assistantText);
}

export function resolveCompletedLocalMessagesFromStream(
  existingMessages: LocalChatMessage[],
  assistantText: string
): LocalChatMessage[] {
  return appendAssistantMessage(existingMessages, assistantText);
}
