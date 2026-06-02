import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChatSession as createChatSessionValue, extractAssistantText as extractAssistantTextValue, serializeSession as serializeSessionValue } from './chat-sessions.mjs';
import { cleanupTempFiles, materializeImageAttachments } from './attachments.mjs';
import { writeSse } from './http.mjs';
import { normalizeAgentRuntimeContext } from './agent-capabilities.mjs';
import { LocalToolExecutor, summarizeLocalToolProtocol } from './local-tools.mjs';
import { summarizeContext } from './prompt.mjs';

export class ChatSessionService {
  constructor(deps) {
    this.deps = deps;
    this.chatSessions = new Map();
    this.threadSessionIndex = new Map();
    this.activeTurnCount = 0;
    this.pendingTurnQueue = [];
  }

  static MAX_INLINE_EXEC_PROMPT_CHARS = 12000;
  static MUTATING_TOOL_NAMES = new Set([
    'write_file',
    'append_file',
    'replace_in_file',
    'insert_in_file',
    'delete_file',
    'create_directory',
    'move_file',
    'copy_file',
    'apply_patch',
    'run_command',
    'git_add',
    'git_commit',
    'git_checkout',
  ]);

  logPlanner(session, message) {
    if (typeof this.deps.logBridge !== 'function') {
      return;
    }

    const sessionId = String(session?.id || '').trim();
    const prefix = sessionId ? `planner[${sessionId.slice(0, 8)}]` : 'planner';
    this.deps.logBridge(`${prefix} ${String(message || '').trim()}`);
  }

  summarizePlannerText(value, maxChars = 220) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}...`;
  }

  getBridgeLoad() {
    return {
      active_turns: this.activeTurnCount,
      pending_turns: this.pendingTurnQueue.length,
      max_concurrent_turns: this.deps.maxConcurrentTurns,
      max_queued_turns: this.deps.maxQueuedTurns,
    };
  }

  createSession(payload = {}) {
    const session = createChatSessionValue(payload);
    this.chatSessions.set(session.id, session);
    return session;
  }

  getSession(sessionId) {
    return this.chatSessions.get(sessionId);
  }

  clearSessions() {
    this.chatSessions.clear();
    this.threadSessionIndex.clear();
  }

  buildPendingApproval(requestPayload = {}) {
    const method = String(requestPayload.method || '').trim();
    const params = requestPayload.params && typeof requestPayload.params === 'object' ? requestPayload.params : {};
    const item = params.item && typeof params.item === 'object' ? params.item : {};
    const command = String(item.command || params.command || params.reason || params.message || '').trim();
    const title = /command/i.test(method)
      ? 'Allow command execution?'
      : /edit|patch|write|file/i.test(method)
        ? 'Allow workspace edit?'
        : 'Allow tool action?';
    const description = command
      ? `Codex requested approval for ${command}.`
      : `Codex requested approval for ${method || 'a tool action'}.`;

    return {
      request_id: requestPayload.id,
      method,
      title,
      description,
      preview: command,
      payload: requestPayload,
      created_at: Date.now(),
    };
  }

  serializeSession(session) {
    return {
      ...serializeSessionValue(session),
      events: session.events.slice(-40),
      assistant_draft: this.getAssistantDraft(session),
    };
  }

  extractAssistantText(session) {
    return extractAssistantTextValue(session);
  }

  getAgentRuntime(session) {
    return normalizeAgentRuntimeContext(session?.context?.agent_runtime || {});
  }

  shouldUseBridgeToolLoop(session) {
    const agentRuntime = this.getAgentRuntime(session);
    return ['model_tools', 'bridge_tools'].includes(agentRuntime.execution_class);
  }

  getWorkspaceRoot() {
    return resolve(this.deps.getConfiguredWorkspaceRoot());
  }

  normalizeWorkspaceCandidatePath(candidatePath = '') {
    const raw = String(candidatePath || '').trim();
    if (!raw) {
      return '';
    }

    let normalizedPath = raw;
    if (/^file:\/\//i.test(raw)) {
      try {
        normalizedPath = fileURLToPath(raw);
      } catch (_error) {
        return '';
      }
    }

    if (/^\/[a-zA-Z]:\//.test(normalizedPath)) {
      normalizedPath = `${normalizedPath[1]}:${normalizedPath.slice(3)}`;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (/^[a-zA-Z]:[\\/]/.test(normalizedPath) && workspaceRoot.startsWith('/mnt/')) {
      const driveLetter = normalizedPath[0].toLowerCase();
      const remainder = normalizedPath.slice(2).replaceAll('\\', '/');
      normalizedPath = `/mnt/${driveLetter}${remainder.startsWith('/') ? remainder : `/${remainder}`}`;
    }

    return normalizedPath;
  }

  toWorkspaceRelativePath(candidatePath = '') {
    const normalizedPath = this.normalizeWorkspaceCandidatePath(candidatePath);
    if (!normalizedPath) {
      return '';
    }

    const workspaceRoot = this.getWorkspaceRoot();
    const absolutePath = resolve(normalizedPath);
    if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}/`) && !absolutePath.startsWith(`${workspaceRoot}\\`)) {
      return '';
    }

    return relative(workspaceRoot, absolutePath).replaceAll('\\', '/');
  }

  getContextActiveFile(session) {
    const context = session?.context && typeof session.context === 'object' ? session.context : {};
    const activeEditor = context.active_editor && typeof context.active_editor === 'object' ? context.active_editor : {};
    const openTabs = Array.isArray(context.open_tabs) ? context.open_tabs : [];
    const activePath = this.toWorkspaceRelativePath(activeEditor.path || activeEditor.route || '');
    if (activePath) {
      return {
        title: String(activeEditor.title || activeEditor.name || activePath).trim() || activePath,
        path: activePath,
      };
    }

    for (const tab of openTabs) {
      const record = tab && typeof tab === 'object' ? tab : {};
      const tabPath = this.toWorkspaceRelativePath(record.path || record.route || '');
      if (tabPath) {
        return {
          title: String(record.title || record.name || tabPath).trim() || tabPath,
          path: tabPath,
        };
      }
    }

    return null;
  }

  buildWorkspaceContextAnswer(session, message) {
    const text = String(message || '').trim().toLowerCase();
    if (!text) {
      return '';
    }

    const asksAboutOpenTab = /(what|which).*(tab|file).*(open|active)|what tab do i have open|what file do i have open|which file is open|which tab is open|current file|active file|active editor|open tabs?/i.test(text);
    if (!asksAboutOpenTab) {
      return '';
    }

    const context = session?.context && typeof session.context === 'object' ? session.context : {};
    const activeEditor = context.active_editor && typeof context.active_editor === 'object' ? context.active_editor : {};
    const openTabs = Array.isArray(context.open_tabs) ? context.open_tabs : [];
    const activeFile = this.getContextActiveFile(session);
    const describedTabs = openTabs
      .map((tab) => {
        const record = tab && typeof tab === 'object' ? tab : {};
        const title = String(record.title || record.name || '').trim();
        const route = this.toWorkspaceRelativePath(record.path || record.route || '') || String(record.name || '').trim();
        if (!title && !route) {
          return '';
        }
        return route ? `- ${title || route} at ${route}` : `- ${title}`;
      })
      .filter(Boolean);

    if (activeFile?.path) {
      const lines = [`Your active file is ${activeFile.title || activeFile.path} at ${activeFile.path}.`];
      if (describedTabs.length > 1) {
        lines.push('Open tabs:');
        lines.push(...describedTabs);
      } else if (describedTabs.length === 1 && !describedTabs[0].includes(activeFile.path)) {
        lines.push('Open tabs:');
        lines.push(describedTabs[0]);
      }
      return lines.join('\n');
    }

    if (describedTabs.length === 1) {
      return `You currently have one open tab:\n${describedTabs[0]}`;
    }

    if (describedTabs.length > 1) {
      return ['You currently have these open tabs:', ...describedTabs].join('\n');
    }

    return 'I do not currently have an active editor or open-tab record in the VS Code context.';
  }

  async buildDirectWorkspaceToolAnswer(session, message, toolExecutor) {
    const text = String(message || '').trim();
    const lower = text.toLowerCase();
    if (!lower) {
      return '';
    }

    const activeFile = this.getContextActiveFile(session);
    const asksToReadActiveFile = /(read|show|open|display|print).*(current|active|open).*(file|tab)|what(?:'s| is) in (?:my |the )?(?:current|active|open) file|show me (?:my |the )?(?:current|active|open) file/i.test(lower);
    if (asksToReadActiveFile && activeFile?.path) {
      const result = await toolExecutor.execute('read_file', { path: activeFile.path });
      return `Contents of ${activeFile.path}:\n\n${result.content}`;
    }

    const asksToListFiles = /(list|show).*(workspace|repo|repository|project).*(files)|list files|show files|what files (?:are|do i have)|list my files/i.test(lower);
    if (asksToListFiles) {
      const result = await toolExecutor.execute('list_files', { path: '.' });
      const lines = String(result.output || '').split(/\r?\n/).filter(Boolean).slice(0, 200);
      return lines.length
        ? `Workspace files:\n${lines.map((line) => `- ${line}`).join('\n')}`
        : 'No files were found in the workspace.';
    }

    const isExplicitSearchCommand = /^(?:search|find|grep)\b/i.test(text);
    const searchMatch = text.match(/(?:search|find|grep)\s+(?:for\s+)?["“](.+?)["”](?:\s+(?:in|inside)\s+(.+))?/i)
      || text.match(/(?:search|find|grep)\s+(?:for\s+)?'(.+?)'(?:\s+(?:in|inside)\s+(.+))?/i)
      || (isExplicitSearchCommand
        ? text.match(/^(?:search|find|grep)\s+(?:for\s+)?([^\n]+?)(?:\s+(?:in|inside)\s+(.+))?$/i)
        : null);
    if (searchMatch) {
      const query = String(searchMatch[1] || '').trim();
      const pathHint = String(searchMatch[2] || '.').trim() || '.';
      if (query) {
        const result = await toolExecutor.execute('search_text', { query, path: pathHint });
        return result.output
          ? `Search results for "${query}":\n${result.output}`
          : `No matches found for "${query}".`;
      }
    }

    const asksForGitStatus = /\bgit status\b|show (?:me )?(?:the )?git status|what(?:'s| is) changed|what changed|working tree status/i.test(lower);
    if (asksForGitStatus) {
      const result = await toolExecutor.execute('git_status', {});
      return result.output
        ? `Git status:\n${result.output}`
        : 'Git status is clean.';
    }

    const gitLogMatch = text.match(/\bgit log\b(?:\s+(\d+))?|show (?:me )?(?:the )?(?:recent )?(?:git )?(?:history|commits?)(?:\s+(\d+))?/i);
    if (gitLogMatch) {
      const limit = Number.parseInt(gitLogMatch[1] || gitLogMatch[2] || '10', 10);
      const result = await toolExecutor.execute('git_log', { limit: Number.isFinite(limit) ? limit : 10 });
      return result.output
        ? `Git log:\n${result.output}`
        : 'No git history was returned.';
    }

    const gitDiffMatch = text.match(/\bgit diff\b(?:\s+([^\n]+))?|show (?:me )?(?:the )?diff(?:\s+(?:for|against)\s+([^\n]+))?/i);
    if (gitDiffMatch) {
      const revspec = String(gitDiffMatch[1] || gitDiffMatch[2] || '').trim();
      const result = await toolExecutor.execute('git_diff', revspec ? { revspec } : {});
      return result.output
        ? `Git diff${revspec ? ` (${revspec})` : ''}:\n${result.output}`
        : `No git diff${revspec ? ` for ${revspec}` : ''}.`;
    }

    return '';
  }

  async generateCmsPageHtml({ prompt, instruction, context = {} }) {
    const trimmedPrompt = String(prompt || '').trim();
    if (!trimmedPrompt) {
      throw new Error('Prompt is required.');
    }
    const session = this.createSession({ mode: 'workspace', context });
    const message = `${instruction}\n\nWebsite/page idea: ${trimmedPrompt}`;
    await this.runChatTurn(session, message);
    const assistantText = this.extractAssistantText(session);
    const html = this.deps.normalizeGeneratedHtml(assistantText);
    if (!html || html === 'No response returned.') {
      throw new Error(session.lastError || 'Codex finished without returning HTML.');
    }
    return {
      session_id: session.id,
      html,
    };
  }

  publishSession(session, eventName = 'session.updated') {
    const payload = {
      session: this.serializeSession(session),
    };

    session.subscribers.forEach((subscriber) => {
      try {
        writeSse(subscriber, eventName, payload);
      } catch (_error) {}
    });
  }

  scheduleChatTurn(session, message) {
    if (session.running || session.status === 'queued') {
      throw new Error('Codex is already working on this conversation.');
    }

    if (this.activeTurnCount >= this.deps.maxConcurrentTurns) {
      if (this.pendingTurnQueue.length >= this.deps.maxQueuedTurns) {
        const error = new Error(`Codex Bridge is busy. Queue is full (${this.deps.maxQueuedTurns} pending turns).`);
        error.statusCode = 503;
        throw error;
      }

      session.status = 'queued';
      session.updatedAt = Date.now();
      session.lastError = null;
      this.pendingTurnQueue.push({ session, message });
      this.publishSession(session, 'session.queued');
      return {
        queued: true,
        load: this.getBridgeLoad(),
      };
    }

    void this.startScheduledTurn(session, message);
    return {
      queued: false,
      load: this.getBridgeLoad(),
    };
  }

  dispatchQueuedTurns() {
    while (this.activeTurnCount < this.deps.maxConcurrentTurns && this.pendingTurnQueue.length > 0) {
      const next = this.pendingTurnQueue.shift();
      if (!next || !next.session) {
        continue;
      }

      void this.startScheduledTurn(next.session, next.message);
    }
  }

  async startScheduledTurn(session, message) {
    this.activeTurnCount += 1;
    session.status = 'running';
    session.updatedAt = Date.now();
    this.publishSession(session, 'session.running');

    try {
      await this.runChatTurn(session, message);
    } catch (error) {
      session.lastError = error instanceof Error ? error.message : 'Unable to run chat turn.';
    } finally {
      this.activeTurnCount = Math.max(0, this.activeTurnCount - 1);
      this.dispatchQueuedTurns();
    }
  }

  buildExecInvocation({ session, prompt, imagePaths = [], useResume = true }) {
    const workspaceRoot = this.deps.getConfiguredWorkspaceRoot();
    const baseArgs = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      this.deps.codexCliSandboxMode,
      '-C',
      workspaceRoot,
    ];
    const promptText = String(prompt || '');
    const usePromptStdin = promptText.length > ChatSessionService.MAX_INLINE_EXEC_PROMPT_CHARS;

    if (useResume && session.threadId) {
      const resumeArgs = [...baseArgs, 'resume'];
      imagePaths.forEach((imagePath) => {
        resumeArgs.push('-i', imagePath);
      });
      return {
        args: usePromptStdin ? [...resumeArgs, session.threadId] : [...resumeArgs, session.threadId, promptText],
        stdinText: usePromptStdin ? promptText : '',
      };
    }

    imagePaths.forEach((imagePath) => {
      baseArgs.push('-i', imagePath);
    });

    return {
      args: usePromptStdin ? baseArgs : [...baseArgs, promptText],
      stdinText: usePromptStdin ? promptText : '',
    };
  }

  feedChildStdin(child, stdinText = '') {
    if (!child?.stdin) {
      return;
    }

    const text = String(stdinText || '');
    if (text) {
      child.stdin.write(text);
    }
    child.stdin.end();
  }

  async runChatTurn(session, message) {
    if (this.shouldUseBridgeToolLoop(session)) {
      return this.runChatTurnViaBridgeLocalTools(session, message);
    }

    if (this.deps.runtimeKind === 'app_server_adapter') {
      return this.runChatTurnViaAppServer(session, message);
    }

    if (session.running) {
      throw new Error('Codex is already working on this conversation.');
    }

    session.running = true;
    session.status = 'running';
    session.updatedAt = Date.now();
    session.lastError = null;
    const attachments = Array.isArray(session.pendingAttachments) ? session.pendingAttachments : [];
    session.messages.push({
      id: randomUUID(),
      role: 'user',
      text: message,
      attachments,
      created_at: Date.now(),
    });
    this.publishSession(session);

    const prompt = this.deps.buildCodexPrompt({ session, message, attachments });
    const tempImagePaths = await materializeImageAttachments(attachments, this.deps.bridgeTempRoot);
    const invocation = this.buildExecInvocation({ session, prompt, imagePaths: tempImagePaths });
    const child = await this.deps.spawnCodex(invocation.args, {
      allowStdin: Boolean(invocation.stdinText),
    });
    this.feedChildStdin(child, invocation.stdinText);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let assistantText = '';
      let finished = false;
      const timeoutHandle = setTimeout(() => {
        if (finished) {
          return;
        }

        try {
          child.kill('SIGTERM');
        } catch (_error) {}
      }, this.deps.chatTurnTimeoutMs);

      const finish = async (error = null) => {
        if (finished) {
          return;
        }

        finished = true;
        clearTimeout(timeoutHandle);
        session.running = false;
        session.updatedAt = Date.now();
        session.pendingAttachments = [];
        session.pendingApproval = null;
        await cleanupTempFiles(tempImagePaths);
        if (error) {
          session.status = 'error';
          session.lastError = error.message;
          this.publishSession(session, 'session.error');
          reject(error);
          return;
        }

        session.status = 'idle';
        this.publishSession(session, 'session.completed');
        resolve(session);
      };

      const handleEvent = (event) => {
        session.events.push({
          ...event,
          received_at: Date.now(),
        });
        this.publishSession(session, 'session.event');

        if (event.type === 'thread.started' && event.thread_id) {
          session.threadId = event.thread_id;
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          assistantText += event.item.text || '';
        }
      };

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n');
        stdout = lines.pop() || '';

        lines
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            try {
              handleEvent(JSON.parse(line));
            } catch (_error) {
              session.events.push({
                type: 'bridge.output',
                text: line,
                received_at: Date.now(),
              });
            }
          });
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        finish(error);
      });

      child.on('exit', (code) => {
        if (stdout.trim() !== '') {
          try {
            handleEvent(JSON.parse(stdout.trim()));
          } catch (_error) {
            session.events.push({
              type: 'bridge.output',
              text: stdout.trim(),
              received_at: Date.now(),
            });
          }
        }

        if (code !== 0) {
          const trimmedStderr = String(stderr || '').trim();
          const timeoutError = trimmedStderr === '' && code === null
            ? `Codex timed out after ${Math.round(this.deps.chatTurnTimeoutMs / 1000)} seconds.`
            : '';
          finish(new Error((trimmedStderr || timeoutError || `Codex exited with code ${code ?? 1}`).trim()));
          return;
        }

        const assistantMessage = this.splitReasoningContent(assistantText || 'No response returned.');
        session.messages.push({
          id: randomUUID(),
          role: 'assistant',
          text: assistantMessage.text || 'No response returned.',
          thinking: assistantMessage.thinking || undefined,
          created_at: Date.now(),
        });
        this.publishSession(session, 'session.message');
        finish();
      });
    });
  }

  async runExecPrompt(session, prompt, imagePaths = []) {
    const invocation = this.buildExecInvocation({ session, prompt, imagePaths, useResume: false });
    const child = await this.deps.spawnCodex(invocation.args, {
      allowStdin: Boolean(invocation.stdinText),
    });
    this.feedChildStdin(child, invocation.stdinText);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let assistantText = '';

      const handleEvent = (event) => {
        this.appendSessionEvent(session, event);

        if (event.type === 'thread.started' && event.thread_id) {
          this.registerSessionThread(session, event.thread_id);
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          assistantText += event.item.text || '';
        }
      };

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n');
        stdout = lines.pop() || '';

        lines
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach((line) => {
            try {
              handleEvent(JSON.parse(line));
            } catch (_error) {
              this.appendSessionEvent(session, {
                type: 'bridge.output',
                text: line,
              });
            }
          });
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('exit', (code) => {
        if (stdout.trim() !== '') {
          try {
            handleEvent(JSON.parse(stdout.trim()));
          } catch (_error) {
            this.appendSessionEvent(session, {
              type: 'bridge.output',
              text: stdout.trim(),
            });
          }
        }

        if (code !== 0) {
          reject(new Error((String(stderr || '').trim() || `Codex exited with code ${code ?? 1}`).trim()));
          return;
        }

        resolve(assistantText.trim());
      });
    });
  }

  stripCodeFences(value) {
    const text = String(value || '').trim();
    const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    return fencedMatch ? String(fencedMatch[1] || '').trim() : text;
  }

  splitReasoningContent(value) {
    const rawText = String(value || '');
    if (!rawText) {
      return { text: '', thinking: '' };
    }

    const thinkingParts = [];
    const textWithoutReasoning = rawText.replace(/<reasoning>([\s\S]*?)<\/reasoning>/gi, (_match, inner) => {
      const thinking = String(inner || '').trim();
      if (thinking) {
        thinkingParts.push(thinking);
      }
      return '\n';
    });

    return {
      text: textWithoutReasoning
        .replace(/<\/?reasoning>/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
      thinking: thinkingParts
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    };
  }

  extractJsonObjectCandidate(value) {
    const text = String(value || '').trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return '';
    }

    return text.slice(firstBrace, lastBrace + 1).trim();
  }

  normalizePlannerDecision(parsed = {}, rawText = '') {
    const rawType = String(parsed?.type || parsed?.kind || parsed?.action || '').trim().toLowerCase();
    const tool = String(
      parsed?.tool
      || parsed?.tool_name
      || parsed?.name
      || (rawType === 'tool_call' ? '' : rawType)
      || '',
    ).trim();

    let type = rawType;
    if (!['tool_call', 'final'].includes(type)) {
      if (tool) {
        type = 'tool_call';
      } else if (parsed?.response || parsed?.final || parsed?.message || parsed?.answer) {
        type = 'final';
      }
    }

    if (!['tool_call', 'final'].includes(type)) {
      return null;
    }

    return {
      type,
      tool,
      input: parsed?.input && typeof parsed.input === 'object'
        ? parsed.input
        : (parsed?.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {}),
      response: String(parsed?.response || parsed?.final || parsed?.message || parsed?.answer || rawText || '').trim(),
      explanation: String(parsed?.explanation || parsed?.reason || '').trim(),
    };
  }

  parseBridgePlannerResponse(raw) {
    const text = this.stripCodeFences(raw);
    const candidates = [text, this.extractJsonObjectCandidate(text)].filter(Boolean);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const normalized = this.normalizePlannerDecision(parsed, text);
        if (normalized) {
          return normalized;
        }
      } catch (_error) {}
    }

    return null;
  }

  buildBridgePlannerRepairPrompt(rawOutput) {
    return [
      'Rewrite the previous planner response into valid JSON only.',
      'Do not add markdown fences or any commentary.',
      'Use exactly one of these JSON shapes:',
      '{"type":"tool_call","tool":"read_file","input":{"path":"relative/path"},"explanation":"short reason"}',
      '{"type":"final","response":"final user-facing answer"}',
      'If the previous response was proposing an edit, inspection, command, or git action, convert it into a tool_call.',
      'If the previous response was already the final answer to the user, convert it into a final response.',
      `Previous response:\n${String(rawOutput || '').trim()}`,
    ].join('\n\n');
  }

  buildBridgeToolPlannerPrompt({ session, message, toolExecutor, toolHistory = [] }) {
    const toolList = summarizeLocalToolProtocol();
    const activeFile = this.getContextActiveFile(session);
    const contextSummary = summarizeContext(session?.context || {});
    const conversation = (Array.isArray(session.messages) ? session.messages : [])
      .slice(-8)
      .map((entry) => `${String(entry.role || 'assistant').toUpperCase()}:\n${String(entry.text || '').trim()}`)
      .join('\n\n');
    const toolTranscript = toolHistory.length
      ? toolHistory.map((step, index) => [
          `Tool step ${index + 1}:`,
          `- tool: ${step.tool}`,
          `- input: ${JSON.stringify(step.input)}`,
          `- result: ${JSON.stringify(step.result)}`,
        ].join('\n')).join('\n\n')
      : 'No tools have been executed yet in this turn.';

    return [
      'You are operating as a Codex planner for a local VS Code workspace tool executor.',
      'You must choose the next single tool action or provide the final user-facing answer.',
      'Never claim a file was edited, a command was run, or git was inspected unless that result is present in the tool transcript.',
      'Return JSON only, with no markdown fences and no extra commentary.',
      'Use exactly one of these JSON shapes:',
      '{"type":"tool_call","tool":"read_file","input":{"path":"relative/path"},"explanation":"short reason"}',
      '{"type":"final","response":"final user-facing answer"}',
      'Available local tools:',
      toolList,
      'Tool usage guidance:',
      '- Prefer read/search/list tools before editing.',
      '- Use read_directory, find_files, stat_file, and path_exists to understand the workspace before making structural changes.',
      '- Use write_file to replace full file contents when needed.',
      '- Use append_file to add content to the end of a file.',
      '- Use replace_in_file for precise local edits, but only after you know the exact old_text currently in the file.',
      '- Use insert_in_file when you need to place new text around an existing anchor, at a specific line_number, or at position start/end, without rewriting the whole file.',
      '- If the user says after/before specific text on a specific line, pass both line_number and anchor_text with position before/after so the anchor is matched only on that line.',
      '- Use create_directory before writing into a new folder.',
      '- Use move_file, copy_file, and delete_file for actual filesystem operations instead of simulating them with edits.',
      '- Use apply_patch only when a unified diff is the clearest representation.',
      '- Use read_multiple_files or grep_structured when you need structured cross-file inspection.',
      '- If the user refers to a file informally or without a clear path, locate it first with find_files, read_directory, or path_exists before assuming it is at the workspace root.',
      '- Use git_show, git_add, git_commit, and git_checkout only when the user explicitly asked for git operations.',
      '- For commit history questions, prefer git_log first.',
      '- To inspect a specific commit or learn which files changed in a commit, prefer git_show or git_diff with a specific revspec/commit instead of a full workspace diff.',
      '- If the user asks which files a commit changed, prefer a name-only or summary-style git inspection before requesting a full patch.',
      '- If an edit tool fails because required input is missing or the target text is not found, inspect the file and try again with a better tool input.',
      activeFile?.path ? `Active editor target file: ${activeFile.path}` : '',
      contextSummary ? `Workspace/VS Code context:\n${contextSummary}` : '',
      '- If the user references the visible/current/editor file or pastes editor contents without naming a path, use the Active editor target file. Do not invent placeholder paths like file.md.',
      'Current conversation:',
      conversation || `USER:\n${message}`,
      'Current turn tool transcript:',
      toolTranscript,
      'Decide the next single step now.',
    ].join('\n\n');
  }

  requiresLocalApproval(toolName) {
    return ChatSessionService.MUTATING_TOOL_NAMES.has(String(toolName || '').trim());
  }

  getUnresolvedFailedMutatingTool(toolHistory = []) {
    for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
      const step = toolHistory[index] || {};
      const toolName = String(step.tool || '').trim();
      if (!ChatSessionService.MUTATING_TOOL_NAMES.has(toolName)) {
        continue;
      }

      if (step.result?.ok === true) {
        return null;
      }

      return step;
    }

    return null;
  }

  finalResponseAcknowledgesToolFailure(response = '') {
    return /\b(failed|could(?: not|n't)|unable|not able|did(?: not|n't)|was(?: not|n't)|error|denied|not applied|not changed|no changes|requires|missing)\b/i.test(
      String(response || ''),
    );
  }

  extractRequestedInsertLineTarget(session, message = '') {
    const userTexts = [
      String(message || ''),
      ...(Array.isArray(session?.messages) ? [...session.messages].reverse()
        .filter((entry) => String(entry?.role || '').toLowerCase() === 'user')
        .map((entry) => String(entry?.text || '')) : []),
    ];

    const ordinalWords = new Map([
      ['first', 1],
      ['second', 2],
      ['third', 3],
      ['fourth', 4],
      ['fifth', 5],
      ['sixth', 6],
      ['seventh', 7],
      ['eighth', 8],
      ['ninth', 9],
      ['tenth', 10],
    ]);

    for (const text of userTexts) {
      const value = String(text || '').trim();
      if (!value) {
        continue;
      }

      const numericMatch = value.match(/\b(?:line|line\s*number|line\s*#|#)\s*#?\s*(\d+)\b/i);
      const ordinalMatch = value.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+line\b/i);
      const lineNumber = numericMatch
        ? Number.parseInt(numericMatch[1], 10)
        : (ordinalMatch ? ordinalWords.get(String(ordinalMatch[1] || '').toLowerCase()) : 0);
      if (!lineNumber || lineNumber < 1) {
        continue;
      }

      const lowered = value.toLowerCase();
      const beforeLineNeedle = numericMatch ? numericMatch[0].toLowerCase() : String(ordinalMatch?.[0] || '').toLowerCase();
      const lineIndex = beforeLineNeedle ? lowered.indexOf(beforeLineNeedle) : -1;
      const prefix = lineIndex >= 0 ? lowered.slice(Math.max(0, lineIndex - 32), lineIndex) : lowered;
      const fullPrefix = lineIndex >= 0 ? lowered.slice(0, lineIndex) : lowered;
      const lastAfter = fullPrefix.lastIndexOf('after');
      const lastBefore = fullPrefix.lastIndexOf('before');
      const explicitAfter = lastAfter > lastBefore || /\bafter\s+(?:the\s+)?$/.test(prefix) || /\bafter\s+(?:line|line\s*number|line\s*#|#)\s*#?\s*\d+\b/i.test(value);
      return {
        lineNumber,
        position: explicitAfter ? 'after' : 'before',
      };
    }

    return null;
  }

  normalizeLineTargetedInsertInput(toolName, input = {}, lineTarget = null) {
    if (String(toolName || '').trim() !== 'insert_in_file' || !lineTarget?.lineNumber) {
      return input && typeof input === 'object' ? input : {};
    }

    return {
      ...(input && typeof input === 'object' ? input : {}),
      line_number: lineTarget.lineNumber,
      position: lineTarget.position,
    };
  }

  normalizeContextualPathInput(session, message = '', toolName = '', input = {}) {
    const normalizedToolName = String(toolName || '').trim();
    const pathTools = new Set([
      'read_file',
      'search_text',
      'insert_in_file',
      'replace_in_file',
      'append_file',
      'stat_file',
      'path_exists',
    ]);
    if (!pathTools.has(normalizedToolName)) {
      return input && typeof input === 'object' ? input : {};
    }

    const record = input && typeof input === 'object' ? input : {};
    const requestedPath = String(record.path || '').trim();
    const activeFile = this.getContextActiveFile(session);
    if (!activeFile?.path) {
      return record;
    }

    const userText = String(message || '').toLowerCase();
    const placeholderPath = /^(?:file|current-file|current_file|active-file|active_file|document|doc|untitled)(?:\.[a-z0-9_-]+)?$/i.test(requestedPath);
    const currentFileRequest = /\b(current|active|open|visible|editor|this)\b/.test(userText) || userText.includes('# ');
    if ((!requestedPath || placeholderPath) && currentFileRequest) {
      return {
        ...record,
        path: activeFile.path,
      };
    }

    return record;
  }

  getMismatchedLineTargetedInsert(toolHistory = [], lineTarget = null) {
    if (!lineTarget?.lineNumber) {
      return null;
    }

    for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
      const step = toolHistory[index] || {};
      if (String(step.tool || '').trim() !== 'insert_in_file' || step.result?.ok !== true) {
        continue;
      }

      const resultLine = Number.parseInt(String(step.result?.line_number || ''), 10) || 0;
      const resultPosition = String(step.result?.position || '').trim().toLowerCase();
      if (resultLine !== lineTarget.lineNumber || (resultPosition && resultPosition !== lineTarget.position)) {
        return step;
      }
      return null;
    }

    return null;
  }

  validateBridgeToolInput(toolName, input = {}) {
    const normalizedToolName = String(toolName || '').trim();
    const record = input && typeof input === 'object' ? input : {};

    if (normalizedToolName === 'replace_in_file') {
      if (!String(record.path || '').trim()) {
        return 'replace_in_file requires a path.';
      }
      if (!String(record.old_text || '')) {
        return 'replace_in_file requires old_text. Read the file first, then retry with exact old_text and new_text.';
      }
      if (!Object.prototype.hasOwnProperty.call(record, 'new_text')) {
        return 'replace_in_file requires new_text.';
      }
    }

    if (normalizedToolName === 'write_file') {
      if (!String(record.path || '').trim()) {
        return 'write_file requires a path.';
      }
      if (!Object.prototype.hasOwnProperty.call(record, 'content')) {
        return 'write_file requires content.';
      }
    }

    if (normalizedToolName === 'append_file') {
      if (!String(record.path || '').trim()) {
        return 'append_file requires a path.';
      }
      if (!Object.prototype.hasOwnProperty.call(record, 'content')) {
        return 'append_file requires content.';
      }
    }

    if (normalizedToolName === 'insert_in_file') {
      const hasExplicitPosition = Object.prototype.hasOwnProperty.call(record, 'position')
        || Object.prototype.hasOwnProperty.call(record, 'location');
      const rawAnchorHint = String(record.anchor || record.anchorText || record.search_text || '').trim().toLowerCase();
      const rawPosition = String(
        record.position
        || record.location
        || (!Object.prototype.hasOwnProperty.call(record, 'anchor_text') && ['start', 'beginning', 'top', 'end', 'bottom'].includes(rawAnchorHint) ? rawAnchorHint : '')
      ).trim().toLowerCase();
      const insertsAtBoundary = ['start', 'beginning', 'top', 'end', 'bottom'].includes(rawPosition);
      const lineNumber = Number.parseInt(String(record.line_number || record.lineNumber || record.line || ''), 10) || 0;
      const anchorText = String(
        record.anchor_text
        || (hasExplicitPosition ? (record.anchorText || record.anchor || record.search_text) : (!insertsAtBoundary ? (record.anchorText || record.anchor || record.search_text) : ''))
        || '',
      );
      if (!String(record.path || '').trim()) {
        return 'insert_in_file requires a path.';
      }
      if (!anchorText && !insertsAtBoundary && lineNumber <= 0) {
        return 'insert_in_file requires anchor_text (or anchorText, anchor, search_text), line_number, or position start/end.';
      }
      if (!Object.prototype.hasOwnProperty.call(record, 'text')) {
        return 'insert_in_file requires text.';
      }
    }

    if (normalizedToolName === 'delete_file' && !String(record.path || '').trim()) {
      return 'delete_file requires a path.';
    }

    if (normalizedToolName === 'create_directory' && !String(record.path || '').trim()) {
      return 'create_directory requires a path.';
    }

    if (normalizedToolName === 'move_file') {
      const sourcePath = String(record.source_path || record.source || '').trim();
      const destinationPath = String(record.destination_path || record.destination || '').trim();
      if (!sourcePath || !destinationPath) {
        return 'move_file requires source_path and destination_path.';
      }
    }

    if (normalizedToolName === 'copy_file') {
      const sourcePath = String(record.source_path || record.source || '').trim();
      const destinationPath = String(record.destination_path || record.destination || '').trim();
      if (!sourcePath || !destinationPath) {
        return 'copy_file requires source_path and destination_path.';
      }
    }

    if (normalizedToolName === 'path_exists' && !String(record.path || '').trim()) {
      return 'path_exists requires a path.';
    }

    if (normalizedToolName === 'stat_file' && !String(record.path || '').trim()) {
      return 'stat_file requires a path.';
    }

    if (normalizedToolName === 'read_multiple_files') {
      if (!Array.isArray(record.paths) || !record.paths.length) {
        return 'read_multiple_files requires at least one path.';
      }
    }

    if (normalizedToolName === 'grep_structured' && !String(record.query || '').trim()) {
      return 'grep_structured requires a query.';
    }

    if (normalizedToolName === 'read_file' && !String(record.path || '').trim()) {
      return 'read_file requires a path.';
    }

    if (normalizedToolName === 'search_text' && !String(record.query || '').trim()) {
      return 'search_text requires a query.';
    }

    if (normalizedToolName === 'run_command' && !String(record.command || '').trim()) {
      return 'run_command requires a command.';
    }

    if (normalizedToolName === 'apply_patch' && !String(record.patch || '').trim()) {
      return 'apply_patch requires a patch.';
    }

    if (normalizedToolName === 'git_show' && !String(record.revspec || '').trim()) {
      return 'git_show requires a revspec.';
    }

    if (normalizedToolName === 'git_add') {
      if (!Array.isArray(record.paths) || !record.paths.length) {
        return 'git_add requires at least one path.';
      }
    }

    if (normalizedToolName === 'git_commit' && !String(record.message || '').trim()) {
      return 'git_commit requires a message.';
    }

    if (normalizedToolName === 'git_checkout') {
      const hasRevspec = String(record.revspec || '').trim() !== '';
      const hasPaths = Array.isArray(record.paths) && record.paths.length > 0;
      if (!hasRevspec && !hasPaths) {
        return 'git_checkout requires a revspec or at least one path.';
      }
    }

    return '';
  }

  async requestLocalApproval(session, toolName, input = {}) {
    return new Promise((resolve) => {
      session.pendingApproval = {
        kind: 'local',
        request_id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        method: String(toolName || 'tool_action'),
        title: toolName === 'run_command' ? 'Allow command execution?' : 'Allow workspace change?',
        description: toolName === 'run_command'
          ? `Codex wants to run: ${String(input.command || '').trim()}`
          : `Codex wants to execute ${toolName} in your workspace.`,
        preview: JSON.stringify({ tool: toolName, input }, null, 2),
        payload: { tool: toolName, input },
        created_at: Date.now(),
      };
      session.pendingApprovalResolver = resolve;
      session.updatedAt = Date.now();
      this.publishSession(session, 'session.approval.required');
    });
  }

  async executeBridgeTool(session, toolExecutor, toolName, input = {}) {
    const validationError = this.validateBridgeToolInput(toolName, input);
    if (validationError) {
      return {
        ok: false,
        tool: toolName,
        error: validationError,
      };
    }

    if (this.requiresLocalApproval(toolName)) {
      const decision = await this.requestLocalApproval(session, toolName, input);
      session.pendingApproval = null;
      session.pendingApprovalResolver = null;
      if (decision !== 'allow') {
        return {
          ok: false,
          denied: true,
          tool: toolName,
          error: 'User denied approval.',
        };
      }
    }

    try {
      return await toolExecutor.execute(toolName, input);
    } catch (error) {
      return {
        ok: false,
        tool: toolName,
        error: error instanceof Error ? error.message : 'Tool execution failed.',
      };
    }
  }

  async runChatTurnViaBridgeLocalTools(session, message) {
    if (session.running) {
      throw new Error('Codex is already working on this conversation.');
    }

    session.running = true;
    session.status = 'running';
    session.updatedAt = Date.now();
    session.lastError = null;
    session.pendingApproval = null;

    const attachments = Array.isArray(session.pendingAttachments) ? session.pendingAttachments : [];
    session.messages.push({
      id: randomUUID(),
      role: 'user',
      text: message,
      attachments,
      created_at: Date.now(),
    });
    this.publishSession(session);

    const workspaceContextAnswer = this.buildWorkspaceContextAnswer(session, message);
    if (workspaceContextAnswer) {
      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        text: workspaceContextAnswer,
        created_at: Date.now(),
      });
      session.status = 'idle';
      session.running = false;
      session.pendingAttachments = [];
      session.updatedAt = Date.now();
      this.publishSession(session, 'session.message');
      this.publishSession(session, 'session.completed');
      return session;
    }

    const tempImagePaths = await materializeImageAttachments(attachments, this.deps.bridgeTempRoot);
    const toolExecutor = new LocalToolExecutor({
      workspaceRoot: this.deps.getConfiguredWorkspaceRoot(),
    });

    const directToolAnswer = await this.buildDirectWorkspaceToolAnswer(session, message, toolExecutor);
    if (directToolAnswer) {
      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        text: directToolAnswer,
        created_at: Date.now(),
      });
      session.status = 'idle';
      session.running = false;
      session.pendingAttachments = [];
      session.updatedAt = Date.now();
      this.publishSession(session, 'session.message');
      this.publishSession(session, 'session.completed');
      await cleanupTempFiles(tempImagePaths);
      return session;
    }

    const toolHistory = [];
    const maxSteps = 10;
    const requestedInsertLineTarget = this.extractRequestedInsertLineTarget(session, message);

    try {
      this.logPlanner(session, `start message=${JSON.stringify(this.summarizePlannerText(message, 160))}`);
      for (let step = 0; step < maxSteps; step += 1) {
        const plannerPrompt = this.buildBridgeToolPlannerPrompt({
          session,
          message,
          toolExecutor,
          toolHistory,
        });
        this.logPlanner(session, `step=${step + 1}/${maxSteps} prompt_chars=${plannerPrompt.length} tool_history=${toolHistory.length}`);
        const assistantText = await this.runExecPrompt(session, plannerPrompt, step === 0 ? tempImagePaths : []);
        this.logPlanner(session, `step=${step + 1} raw=${JSON.stringify(this.summarizePlannerText(assistantText))}`);
        let decision = this.parseBridgePlannerResponse(assistantText);

        if (!decision) {
          this.logPlanner(session, `step=${step + 1} parse=failed repair=starting`);
          const repairedText = await this.runExecPrompt(
            session,
            this.buildBridgePlannerRepairPrompt(assistantText),
            [],
          );
          this.logPlanner(session, `step=${step + 1} repair_raw=${JSON.stringify(this.summarizePlannerText(repairedText))}`);
          decision = this.parseBridgePlannerResponse(repairedText);
        }

        if (!decision) {
          this.logPlanner(session, `step=${step + 1} parse=failed_final_fallback`);
          const fallbackMessage = this.splitReasoningContent(assistantText.trim());
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            text: fallbackMessage.text || 'I could not normalize the model response into a tool action.',
            thinking: fallbackMessage.thinking || undefined,
            created_at: Date.now(),
          });
          session.status = 'idle';
          session.running = false;
          session.pendingAttachments = [];
          session.updatedAt = Date.now();
          this.publishSession(session, 'session.message');
          this.publishSession(session, 'session.completed');
          return session;
        }

        if (decision.type === 'final') {
          this.logPlanner(session, `step=${step + 1} decision=final response=${JSON.stringify(this.summarizePlannerText(decision.response))}`);
          const unresolvedFailedMutation = this.getUnresolvedFailedMutatingTool(toolHistory);
          if (unresolvedFailedMutation && !this.finalResponseAcknowledgesToolFailure(decision.response)) {
            const guardError = `Cannot claim success because ${unresolvedFailedMutation.tool} failed: ${unresolvedFailedMutation.result?.error || 'Tool execution failed.'}`;
            this.logPlanner(session, `step=${step + 1} final=rejected_after_failed_mutation error=${JSON.stringify(this.summarizePlannerText(guardError))}`);
            toolHistory.push({
              tool: 'planner_final_guard',
              input: {
                rejected_response: decision.response || '',
              },
              result: {
                ok: false,
                error: guardError,
              },
            });
            continue;
          }
          const mismatchedLineInsert = this.getMismatchedLineTargetedInsert(toolHistory, requestedInsertLineTarget);
          if (mismatchedLineInsert && !this.finalResponseAcknowledgesToolFailure(decision.response)) {
            const guardError = `Cannot claim success because insert_in_file wrote line ${mismatchedLineInsert.result?.line_number || '(unknown)'} ${mismatchedLineInsert.result?.position || ''}, but the user requested line ${requestedInsertLineTarget.lineNumber} ${requestedInsertLineTarget.position}.`;
            this.logPlanner(session, `step=${step + 1} final=rejected_after_line_mismatch error=${JSON.stringify(this.summarizePlannerText(guardError))}`);
            toolHistory.push({
              tool: 'planner_final_guard',
              input: {
                rejected_response: decision.response || '',
              },
              result: {
                ok: false,
                error: guardError,
              },
            });
            continue;
          }
          const finalMessage = this.splitReasoningContent(decision.response || 'No response returned.');
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            text: finalMessage.text || 'No response returned.',
            thinking: finalMessage.thinking || undefined,
            created_at: Date.now(),
          });
          session.status = 'idle';
          session.running = false;
          session.pendingAttachments = [];
          session.updatedAt = Date.now();
          this.publishSession(session, 'session.message');
          this.publishSession(session, 'session.completed');
          return session;
        }

        if (!decision.tool) {
          throw new Error('Planner requested a tool step without naming a tool.');
        }

        decision.input = this.normalizeContextualPathInput(session, message, decision.tool, decision.input || {});
        decision.input = this.normalizeLineTargetedInsertInput(decision.tool, decision.input || {}, requestedInsertLineTarget);

        this.logPlanner(
          session,
          `step=${step + 1} decision=tool_call tool=${decision.tool} input=${JSON.stringify(decision.input || {})}`,
        );
        this.appendSessionEvent(session, {
          type: 'bridge.planner.step',
          preview: decision.explanation || `Running ${decision.tool}`,
          tool: {
            name: decision.tool,
            input: decision.input || {},
          },
        });
        const toolResult = await this.executeBridgeTool(session, toolExecutor, decision.tool, decision.input || {});
        this.logPlanner(
          session,
          `step=${step + 1} tool_result tool=${decision.tool} ok=${toolResult?.ok === true} error=${JSON.stringify(toolResult?.error || '')}`,
        );
        toolHistory.push({
          tool: decision.tool,
          input: decision.input || {},
          result: toolResult,
        });
        this.appendSessionEvent(session, {
          type: 'bridge.tool.result',
          preview: `${decision.tool}: ${toolResult.ok ? 'ok' : (toolResult.error || 'failed')}`,
          tool: {
            name: decision.tool,
            input: decision.input || {},
            result: toolResult,
          },
        });
      }

      this.logPlanner(session, `error=max_steps_exceeded steps=${maxSteps}`);
      throw new Error(`Bridge tool planner exceeded ${maxSteps} steps without returning a final answer.`);
    } catch (error) {
      this.logPlanner(session, `error=${JSON.stringify(error instanceof Error ? error.message : 'Bridge tool execution failed.')}`);
      session.status = 'error';
      session.running = false;
      session.pendingApproval = null;
      session.pendingApprovalResolver = null;
      session.pendingAttachments = [];
      session.updatedAt = Date.now();
      session.lastError = error instanceof Error ? error.message : 'Bridge tool execution failed.';
      this.publishSession(session, 'session.error');
      throw error;
    } finally {
      await cleanupTempFiles(tempImagePaths);
    }
  }

  async runChatTurnViaAppServer(session, message) {
    if (session.running) {
      throw new Error('Codex is already working on this conversation.');
    }

    session.running = true;
    session.status = 'running';
    session.updatedAt = Date.now();
    session.lastError = null;
    const attachments = Array.isArray(session.pendingAttachments) ? session.pendingAttachments : [];
    session.messages.push({
      id: randomUUID(),
      role: 'user',
      text: message,
      attachments,
      created_at: Date.now(),
    });
    this.publishSession(session);

    const prompt = this.deps.buildCodexPrompt({ session, message, attachments });
    const tempImagePaths = await materializeImageAttachments(attachments, this.deps.bridgeTempRoot);
    session.pendingTempImagePaths = tempImagePaths;
    session.assistantItems = new Map();
    session.pendingApproval = null;

    return new Promise((resolve, reject) => {
      let finished = false;
      let timeoutHandle = null;
      session.pendingResolve = resolve;
      session.pendingReject = reject;

      const finishWithError = async (error) => {
        if (finished) {
          return;
        }

        finished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        await this.completeAppServerSession(session, error);
      };

      timeoutHandle = setTimeout(async () => {
        if (finished) {
          return;
        }

        finished = true;

        if (session.threadId && session.activeTurnId) {
          try {
            const client = await this.deps.getAppServerClient();
            await client.request('turn/interrupt', {
              threadId: session.threadId,
              turnId: session.activeTurnId,
            });
          } catch (_error) {}
        }

        await this.completeAppServerSession(
          session,
          new Error(`Codex timed out after ${Math.round(this.deps.chatTurnTimeoutMs / 1000)} seconds.`)
        );
      }, this.deps.chatTurnTimeoutMs);

      (async () => {
        try {
          const client = await this.deps.getAppServerClient();
          const input = [
            {
              type: 'text',
              text: prompt,
              text_elements: [],
            },
            ...tempImagePaths.map((path) => ({
              type: 'localImage',
              path,
            })),
          ];

          if (!session.threadId) {
            const threadResponse = await client.request('thread/start', {
              cwd: this.deps.getConfiguredWorkspaceRoot(),
              sandbox: this.deps.codexCliSandboxMode,
              serviceName: 'codex-bridge',
              ephemeral: false,
              experimentalRawEvents: false,
              persistExtendedHistory: true,
            });

            this.registerSessionThread(session, threadResponse?.thread?.id || '');
          }

          const turnResponse = await client.request('turn/start', {
            threadId: session.threadId,
            input,
            cwd: this.deps.getConfiguredWorkspaceRoot(),
            approvalPolicy: 'on-request',
            sandboxPolicy: {
              type: this.deps.codexAppSandboxType,
              access: {
                type: 'fullAccess',
              },
              networkAccess: false,
            },
          });

          session.activeTurnId = turnResponse?.turn?.id || session.activeTurnId || null;
        } catch (error) {
          await finishWithError(error instanceof Error ? error : new Error('Codex App Server turn failed.'));
        }
      })();
    });
  }

  registerSessionThread(session, threadId) {
    if (!threadId) {
      return;
    }

    session.threadId = threadId;
    this.threadSessionIndex.set(threadId, session);
  }

  appendSessionEvent(session, event) {
    session.events.push({
      ...event,
      received_at: Date.now(),
    });
    session.events = session.events.slice(-120);
    this.publishSession(session, 'session.event');
  }

  getAssistantDraft(session) {
    if (!(session.assistantItems instanceof Map)) {
      return '';
    }

    return Array.from(session.assistantItems.values()).join('');
  }

  async completeAppServerSession(session, error = null) {
    if (!session) {
      return;
    }

    if (!session.running && !session.pendingResolve && !session.pendingReject) {
      return;
    }

    const tempImagePaths = Array.isArray(session.pendingTempImagePaths) ? session.pendingTempImagePaths : [];
    session.pendingTempImagePaths = [];
    await cleanupTempFiles(tempImagePaths);

    session.running = false;
    session.updatedAt = Date.now();
    session.pendingAttachments = [];
    session.pendingApproval = null;
    session.activeTurnId = null;

    if (error) {
      session.status = 'error';
      const stderrHint = String(this.deps.getRecentAppServerStderr() || '').trim();
      session.lastError = stderrHint && !String(error.message || '').includes(stderrHint)
        ? `${error.message}\n${stderrHint}`
        : error.message;
      session.assistantItems = new Map();
      this.publishSession(session, 'session.error');
      if (typeof session.pendingReject === 'function') {
        session.pendingReject(new Error(session.lastError));
      }
      session.pendingResolve = null;
      session.pendingReject = null;
      return;
    }

    const assistantMessage = this.splitReasoningContent(this.getAssistantDraft(session).trim() || 'No response returned.');
    session.assistantItems = new Map();
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      text: assistantMessage.text || 'No response returned.',
      thinking: assistantMessage.thinking || undefined,
      created_at: Date.now(),
    });
    session.status = 'idle';
    this.publishSession(session, 'session.message');
    this.publishSession(session, 'session.completed');
    if (typeof session.pendingResolve === 'function') {
      session.pendingResolve(session);
    }
    session.pendingResolve = null;
    session.pendingReject = null;
  }

  handleAppServerNotification(method, params = {}) {
    const threadId = params.threadId || params.thread?.id || null;
    if (!threadId) {
      return;
    }

    const session = this.threadSessionIndex.get(threadId);
    if (!session) {
      return;
    }

    if (method === 'thread/started') {
      this.registerSessionThread(session, params.thread?.id || '');
      this.appendSessionEvent(session, {
        type: 'thread.started',
        thread_id: params.thread?.id || '',
        preview: params.thread?.preview || '',
      });
      return;
    }

    if (method === 'thread/status/changed') {
      const statusType = params.status?.type || '';
      session.status = statusType === 'systemError' ? 'error' : (statusType === 'active' ? 'running' : 'idle');
      session.running = statusType === 'active';
      session.updatedAt = Date.now();
      this.appendSessionEvent(session, {
        type: 'thread.status.changed',
        preview: statusType,
      });
      return;
    }

    if (method === 'turn/started') {
      session.running = true;
      session.status = 'running';
      session.activeTurnId = params.turn?.id || null;
      this.appendSessionEvent(session, {
        type: 'turn.started',
        turn_id: params.turn?.id || '',
      });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      if (!(session.assistantItems instanceof Map)) {
        session.assistantItems = new Map();
      }

      const existing = session.assistantItems.get(params.itemId) || '';
      session.assistantItems.set(params.itemId, existing + (params.delta || ''));
      this.appendSessionEvent(session, {
        type: 'item.agent_message.delta',
        preview: String(params.delta || '').trim().slice(0, 180),
      });
      return;
    }

    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage') {
        if (!(session.assistantItems instanceof Map)) {
          session.assistantItems = new Map();
        }

        session.assistantItems.set(item.id, item.text || session.assistantItems.get(item.id) || '');
        this.appendSessionEvent(session, {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: item.text || '',
          },
        });
        return;
      }

      const itemPath =
        String(
          item.path
          || item.filePath
          || item.source_path
          || item.destination_path
          || item?.input?.path
          || item?.input?.filePath
          || item?.input?.source_path
          || item?.input?.destination_path
          || ''
        ).trim();
      this.appendSessionEvent(session, {
        type: 'item.completed',
        preview: item.type || 'item',
        item: {
          type: item.type || 'item',
          text: item.command || item.text || item.query || '',
          path: itemPath,
        },
      });
      return;
    }

    if (method === 'turn/plan/updated') {
      this.appendSessionEvent(session, {
        type: 'turn.plan.updated',
        preview: params.explanation || '',
        plan: params.plan || [],
      });
      return;
    }

    if (method === 'turn/completed') {
      if (params.turn?.status === 'failed') {
        this.completeAppServerSession(session, new Error(params.turn?.error?.message || 'Codex turn failed.'));
        return;
      }

      this.appendSessionEvent(session, {
        type: 'turn.completed',
        turn_id: params.turn?.id || '',
      });
      this.completeAppServerSession(session);
      return;
    }

    if (method === 'item/commandExecution/outputDelta') {
      this.appendSessionEvent(session, {
        type: 'command.execution.output',
        text: String(params.delta || '').trim().slice(0, 400),
      });
    }
  }

  async handleAppServerServerRequest(payload = {}) {
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    const threadId = params.threadId || params.thread?.id || null;
    if (!threadId) {
      return false;
    }

    const session = this.threadSessionIndex.get(threadId);
    if (!session) {
      return false;
    }

    session.pendingApproval = this.buildPendingApproval(payload);
    session.updatedAt = Date.now();
    this.appendSessionEvent(session, {
      type: 'approval.requested',
      preview: session.pendingApproval.preview || session.pendingApproval.description,
      approval: session.pendingApproval,
    });
    this.publishSession(session, 'session.approval.required');
    return true;
  }

  async respondToPendingApproval(sessionId, decision) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const pendingApproval = session.pendingApproval;
    if (!pendingApproval?.request_id) {
      throw new Error('No pending approval for this session.');
    }

    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['allow', 'deny'].includes(normalizedDecision)) {
      throw new Error('Approval decision must be allow or deny.');
    }

    if (pendingApproval.kind === 'local') {
      if (typeof session.pendingApprovalResolver === 'function') {
        session.pendingApprovalResolver(normalizedDecision);
      }
    } else {
      const client = await this.deps.getAppServerClient();
      await client.respondToServerRequest(pendingApproval.request_id, normalizedDecision);
    }

    this.appendSessionEvent(session, {
      type: 'approval.responded',
      preview: normalizedDecision,
    });
    session.pendingApproval = null;
    session.pendingApprovalResolver = null;
    session.updatedAt = Date.now();
    this.publishSession(session, 'session.updated');
    return session;
  }
}
