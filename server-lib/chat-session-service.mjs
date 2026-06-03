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

  static MAX_INLINE_EXEC_PROMPT_CHARS = 6000;
  static MAX_THINKING_CHARS = 12000;
  static MUTATING_TOOL_NAMES = new Set([
    'write_file',
    'append_file',
    'save_attachment',
    'replace_in_file',
    'replace_lines_in_file',
    'remove_lines_in_file',
    'insert_in_file',
    'move_text_in_file',
    'delete_file',
    'create_directory',
    'move_file',
    'copy_file',
    'apply_patch',
    'run_command',
    'shell',
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

  buildCodexExitErrorMessage(code, stderr = '', stdout = '', assistantText = '') {
    const stderrText = String(stderr || '').trim();
    if (stderrText) {
      return stderrText;
    }

    const assistant = String(assistantText || '').trim();
    if (assistant) {
      return `Codex exited with code ${code ?? 1}: ${this.summarizePlannerText(assistant, 800)}`;
    }

    const stdoutText = String(stdout || '').trim();
    if (stdoutText) {
      return `Codex exited with code ${code ?? 1}: ${this.summarizePlannerText(stdoutText, 1200)}`;
    }

    return `Codex exited with code ${code ?? 1}`;
  }

  stringifyPlannerToolValue(value, maxChars = 12000) {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, nestedValue) => {
      if (typeof nestedValue === 'string') {
        if (/^(dataUrl|data_url|content|output|stdout|stderr)$/i.test(key) && nestedValue.length > 6000) {
          return `${nestedValue.slice(0, 6000)}\n...[truncated ${nestedValue.length - 6000} chars]`;
        }
        if (nestedValue.length > 20000) {
          return `${nestedValue.slice(0, 20000)}\n...[truncated ${nestedValue.length - 20000} chars]`;
        }
      }
      if (nestedValue && typeof nestedValue === 'object') {
        if (seen.has(nestedValue)) {
          return '[Circular]';
        }
        seen.add(nestedValue);
      }
      return nestedValue;
    });
    const text = String(json || '');
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
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

  hasPendingImageAttachments(session) {
    return (Array.isArray(session?.pendingAttachments) ? session.pendingAttachments : [])
      .some((attachment) => /^image\//i.test(String(attachment?.mimeType || attachment?.mime_type || '')));
  }

  shouldUseDirectVisionAnswer(session, message = '') {
    if (!this.hasPendingImageAttachments(session)) {
      return false;
    }

    const text = String(message || '').trim();
    if (!text) {
      return false;
    }

    const wantsHtmlFromImage = /\b(convert|recreate|turn|generate|make|build|code)\b[\s\S]*\b(image|screenshot|mockup|design|hero)\b[\s\S]*\b(html|bootstrap|css|page|website)\b/i.test(text)
      || /\b(image|screenshot|mockup|design|hero)\b[\s\S]*\b(to|into|as)\b[\s\S]*\b(html|bootstrap|css|page|website)\b/i.test(text);
    if (!wantsHtmlFromImage) {
      return false;
    }

    return !/\b(update|edit|write|save|create|replace|insert|add|change|modify)\b[\s\S]*\b(file|index|html|workspace|project|repo|open file|current file)\b/i.test(text);
  }

  isWorkspaceToolRequest(message = '') {
    const text = String(message || '').trim();
    if (!text) {
      return false;
    }

    return this.isEditRequest(text)
      || /\b(read|show|open|display|print|summarize|explain|review|inspect|check|verify)\b[\s\S]*\b(file|current file|open file|active file|readme|index|route|api|code|function|class)\b/i.test(text)
      || /\b(list|show|find|search|grep)\b[\s\S]*\b(files?|workspace|repo|repository|project|routes?|api|text|for)\b/i.test(text)
      || /\b(git|commit|diff|status|log|branch|checkout|push|pull)\b/i.test(text)
      || /\b(run|execute|shell|terminal|command|npm|pnpm|yarn|node|python|pytest|test suite|build)\b/i.test(text)
      || /\b(current|active|open)\s+(file|tab|editor)\b/i.test(text);
  }

  shouldUseBridgeToolLoop(session, message = '') {
    if (this.shouldUseDirectVisionAnswer(session, message)) {
      return false;
    }
    if (!this.isWorkspaceToolRequest(message)) {
      return false;
    }
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

    const gitLogMatch = text.match(/\bgit log\b(?:\s+(\d+))?|show (?:me )?(?:the )?(?:recent )?(?:git )?(?:history|commits?)(?:\s+(\d+))?|(?:what(?:'s| is)|show(?: me)?|list|tell me)\s+(?:the\s+)?(?:last|latest|most recent)\s+(?:git\s+)?commit\b/i);
    if (gitLogMatch) {
      const limit = Number.parseInt(gitLogMatch[1] || gitLogMatch[2] || '10', 10);
      const singleCommitRequest = /(?:last|latest|most recent)\s+(?:git\s+)?commit\b/i.test(text);
      const result = await toolExecutor.execute('git_log', { limit: singleCommitRequest ? 1 : Number.isFinite(limit) ? limit : 10 });
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

  cancelSession(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }

    this.pendingTurnQueue = this.pendingTurnQueue.filter((entry) => entry.session?.id !== session.id);
    session.cancelRequested = true;
    session.lastError = 'Canceled by user.';
    session.pendingAttachments = [];
    session.pendingApproval = null;
    if (typeof session.pendingApprovalResolver === 'function') {
      session.pendingApprovalResolver({ decision: 'deny' });
    }
    session.pendingApprovalResolver = null;

    if (session.activeChild && typeof session.activeChild.kill === 'function') {
      try {
        session.activeChild.kill();
      } catch (_error) {}
    }

    if (!session.running) {
      session.status = 'idle';
      session.updatedAt = Date.now();
      this.publishSession(session, 'session.completed');
    } else {
      session.status = 'canceling';
      session.updatedAt = Date.now();
      this.publishSession(session, 'session.updated');
    }

    return session;
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

  buildExecInvocation({ session, prompt, imagePaths = [], useResume = true, forcePromptStdin = false }) {
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
    const usePromptStdin = forcePromptStdin || promptText.length > ChatSessionService.MAX_INLINE_EXEC_PROMPT_CHARS;
    const appendPromptArg = (args) => {
      if (usePromptStdin) {
        return imagePaths.length > 0 ? [...args, '--', '-'] : [...args, '-'];
      }
      if (imagePaths.length > 0) {
        return [...args, '--', promptText];
      }
      return [...args, promptText];
    };

    if (useResume && session.threadId) {
      const resumeArgs = [...baseArgs, 'resume'];
      imagePaths.forEach((imagePath) => {
        resumeArgs.push('-i', imagePath);
      });
      return {
        args: appendPromptArg([...resumeArgs, session.threadId]),
        stdinText: usePromptStdin ? promptText : '',
      };
    }

    imagePaths.forEach((imagePath) => {
      baseArgs.push('-i', imagePath);
    });

    return {
      args: appendPromptArg(baseArgs),
      stdinText: usePromptStdin ? promptText : '',
    };
  }

  feedChildStdin(child, stdinText = '') {
    if (!child?.stdin) {
      return;
    }

    const text = String(stdinText || '');
    if (text) {
      child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
    }
    child.stdin.end();
  }

  async runChatTurn(session, message) {
    if (this.shouldUseBridgeToolLoop(session, message)) {
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
          finish(new Error((timeoutError || this.buildCodexExitErrorMessage(code, stderr, stdout, assistantText)).trim()));
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
    if (session.cancelRequested) {
      throw new Error('Canceled by user.');
    }

    const invocation = this.buildExecInvocation({
      session,
      prompt,
      imagePaths,
      useResume: false,
      forcePromptStdin: true,
    });
    const child = await this.deps.spawnCodex(invocation.args, {
      allowStdin: Boolean(invocation.stdinText),
    });
    session.activeChild = child;
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
        if (session.activeChild === child) {
          session.activeChild = null;
        }
        if (session.cancelRequested) {
          reject(new Error('Canceled by user.'));
          return;
        }
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
          reject(new Error(this.buildCodexExitErrorMessage(code, stderr, stdout, assistantText)));
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

  capThinkingText(value = '', maxChars = ChatSessionService.MAX_THINKING_CHARS) {
    const text = String(value || '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text || text.length <= maxChars) {
      return text;
    }

    const prefix = '[Earlier thinking omitted]';
    const tailLength = Math.max(1000, maxChars - prefix.length - 2);
    return `${prefix}\n\n${text.slice(-tailLength)}`;
  }

  splitReasoningContent(value) {
    const rawText = String(value || '');
    if (!rawText) {
      return { text: '', thinking: '', hadReasoning: false };
    }

    const thinkingParts = [];
    let hadReasoning = /<reasoning>/i.test(rawText);
    let textWithoutReasoning = rawText.replace(/<reasoning>([\s\S]*?)<\/reasoning>/gi, (_match, inner) => {
      const thinking = String(inner || '').trim();
      if (thinking) {
        thinkingParts.push(thinking);
      }
      return '\n';
    });

    textWithoutReasoning = textWithoutReasoning.replace(/<reasoning>([\s\S]*)$/i, (_match, inner) => {
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
      thinking: this.capThinkingText(thinkingParts.join('\n\n')),
      hadReasoning,
    };
  }

  extractJsonObjectCandidates(value) {
    const text = String(value || '').trim();
    const candidates = [];

    for (let start = 0; start < text.length; start += 1) {
      if (text[start] !== '{') {
        continue;
      }

      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (inString) {
          continue;
        }
        if (char === '{') {
          depth += 1;
        } else if (char === '}') {
          depth -= 1;
          if (depth === 0) {
            candidates.push(text.slice(start, index + 1).trim());
            break;
          }
        }
      }
    }

    return candidates;
  }

  normalizePlannerDecision(parsed = {}, rawText = '') {
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const normalized = this.normalizePlannerDecision(item, rawText);
        if (normalized) {
          return normalized;
        }
      }
      return null;
    }

    const firstToolCall = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls[0] : null;
    if (firstToolCall) {
      const functionRecord = firstToolCall.function && typeof firstToolCall.function === 'object'
        ? firstToolCall.function
        : firstToolCall;
      return this.normalizePlannerDecision({
        type: 'tool_call',
        tool: functionRecord.name || firstToolCall.name || firstToolCall.tool,
        input: functionRecord.arguments || firstToolCall.arguments || firstToolCall.input,
      }, rawText);
    }

    if (parsed?.function_call && typeof parsed.function_call === 'object') {
      return this.normalizePlannerDecision({
        type: 'tool_call',
        tool: parsed.function_call.name,
        input: parsed.function_call.arguments || parsed.function_call.input,
      }, rawText);
    }

    if (Array.isArray(parsed?.output)) {
      for (const item of parsed.output) {
        const normalized = this.normalizePlannerDecision(item, rawText);
        if (normalized) {
          return normalized;
        }
      }
    }

    const rawType = String(parsed?.type || parsed?.kind || parsed?.action || '').trim().toLowerCase();
    if (['function_call', 'tool_use'].includes(rawType)) {
      return this.normalizePlannerDecision({
        type: 'tool_call',
        tool: parsed.name || parsed.tool || parsed.tool_name,
        input: parsed.arguments || parsed.input,
      }, rawText);
    }

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
      input: this.normalizePlannerInput(parsed?.input ?? parsed?.arguments),
      response: String(parsed?.response || parsed?.final || parsed?.message || parsed?.answer || rawText || '').trim(),
      explanation: String(parsed?.explanation || parsed?.reason || '').trim(),
    };
  }

  normalizePlannerInput(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch (_error) {}
    }

    return {};
  }

  parseBridgePlannerResponse(raw) {
    const split = this.splitReasoningContent(raw);
    const text = this.stripCodeFences(split.text || '');
    const rawText = this.stripCodeFences(raw);
    const candidates = split.hadReasoning
      ? [
          text,
          ...this.extractJsonObjectCandidates(text),
        ].filter(Boolean)
      : [
          text || rawText,
          ...this.extractJsonObjectCandidates(text || rawText),
        ].filter(Boolean);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const normalized = this.normalizePlannerDecision(parsed, text);
        if (normalized && !this.isReasoningOnlyPlannerDecision(normalized)) {
          return normalized;
        }
      } catch (_error) {}
    }

    return null;
  }

  isReasoningOnlyPlannerDecision(decision = {}) {
    if (String(decision?.type || '') !== 'final') {
      return false;
    }

    const response = String(decision?.response || '').trim();
    return /<reasoning>[\s\S]*<\/reasoning>|^<reasoning>[\s\S]*$/i.test(response);
  }

  buildBridgePlannerRepairPrompt(rawOutput) {
    return [
      'Rewrite the previous planner response into exactly one valid JSON object.',
      'The first character of your response must be { and the last character must be }.',
      'Do not include <reasoning>, markdown fences, prose, comments, or any other text.',
      'Use exactly one of these JSON shapes:',
      '{"type":"tool_call","tool":"read_file","input":{"path":"README.md"},"explanation":"short reason"}',
      '{"type":"final","response":"final user-facing answer"}',
      'If the previous response was proposing an edit, inspection, command, or git action, convert it into a tool_call with the closest available local tool name.',
      'If the previous response says it needs to search for text, use {"type":"tool_call","tool":"search_text","input":{"query":"the text"},"explanation":"Locate the text."}.',
      'If the previous response says it needs to read a file, use {"type":"tool_call","tool":"read_file","input":{"path":"README.md"},"explanation":"Read the file."}.',
      'Never use placeholder paths such as relative/path, path/to/file, or file.md unless that is the actual file name.',
      'If the previous response was already the final answer to the user, convert it into a final response.',
      `Previous response:\n${String(rawOutput || '').trim()}`,
    ].join('\n\n');
  }

  buildBridgePlannerJsonOnlyRetryPrompt(rawOutput) {
    return [
      'Output one JSON object now.',
      'No reasoning. No <reasoning>. No explanation. No markdown.',
      'Start with { and end with }.',
      'Allowed shapes:',
      '{"type":"tool_call","tool":"search_text","input":{"query":"hello red"},"explanation":"Locate text."}',
      '{"type":"tool_call","tool":"read_file","input":{"path":"README.md"},"explanation":"Read file."}',
      '{"type":"tool_call","tool":"move_text_in_file","input":{"path":"README.md","source_text":"hello red","text":" hello red","anchor_text":"sentence text","position":"after"},"explanation":"Move text."}',
      '{"type":"final","response":"answer"}',
      `Previous failed output:\n${String(rawOutput || '').trim()}`,
    ].join('\n\n');
  }

  buildBridgeToolPlannerPrompt({ session, message, toolExecutor, toolHistory = [] }) {
    const toolList = summarizeLocalToolProtocol();
    const activeFile = this.getContextActiveFile(session);
    const contextSummary = summarizeContext(session?.context || {});
    const attachments = Array.isArray(session?.pendingAttachments) ? session.pendingAttachments : [];
    const effectiveMessage = String(message || '').trim() || (attachments.length
      ? 'Please inspect the attached image or file and answer using what you see.'
      : '');
    const attachmentNotes = attachments.length
      ? [
          'Current turn attachments:',
          ...attachments.map((attachment, index) => {
            const name = String(attachment?.name || `attachment-${index + 1}`).trim();
            const mimeType = String(attachment?.mime_type || attachment?.mimeType || '').trim();
            return `- Attachment ${index + 1}: ${name}${mimeType ? ` (${mimeType})` : ''}`;
          }),
          'Attached images are supplied to this model invocation. Inspect them carefully and answer using what you see.',
          'If the user asks to add/use an attachment in project files, first call save_attachment with a workspace path such as assets/hero.png, then update the referencing file.',
          'For website/UI requests such as "add this hero", treat the attachment as a visual design reference and asset. Build a polished responsive section that reflects the image style, content, colors, hierarchy, and Bootstrap conventions; do not merely insert a bare <img> tag.',
          'Do not answer that you cannot view images merely because this is the bridge planner prompt.',
        ].join('\n')
      : '';
    const conversation = (Array.isArray(session.messages) ? session.messages : [])
      .slice(-8)
      .map((entry) => {
        const role = String(entry.role || 'assistant').toUpperCase();
        const text = String(entry.text || '').trim();
        if (role === 'USER' && !text && Array.isArray(entry.attachments) && entry.attachments.length) {
          return `${role}:\n${effectiveMessage}`;
        }
        return `${role}:\n${text}`;
      })
      .join('\n\n');
    const toolTranscript = toolHistory.length
      ? toolHistory.map((step, index) => [
          `Tool step ${index + 1}:`,
          `- tool: ${step.tool}`,
          `- input: ${this.stringifyPlannerToolValue(step.input, 4000)}`,
          `- result: ${this.stringifyPlannerToolValue(step.result)}`,
        ].join('\n')).join('\n\n')
      : 'No tools have been executed yet in this turn.';

    return [
      'You are operating as a Codex planner for a local VS Code workspace tool executor.',
      'You must choose the next single tool action or provide the final user-facing answer.',
      'Never claim a file was edited, a command was run, or git was inspected unless that result is present in the tool transcript.',
      'Return exactly one JSON object as the final visible content of your response.',
      'If your model emits hidden/internal reasoning, that reasoning must end before the JSON object.',
      'Do not put the JSON inside <reasoning> tags. Do not use markdown fences.',
      'The JSON object must use exactly one of these shapes:',
      '{"type":"tool_call","tool":"read_file","input":{"path":"relative/path"},"explanation":"short reason"}',
      '{"type":"final","response":"final user-facing answer"}',
      'Available local tools:',
      toolList,
      'Tool usage guidance:',
      '- Prefer read/search/list tools before editing.',
      '- Use read_directory, find_files, stat_file, and path_exists to understand the workspace before making structural changes.',
      '- Use write_file to replace full file contents when needed.',
      '- Use append_file to add content to the end of a file.',
      '- Use save_attachment when the user wants to add a pasted/uploaded attachment into the project. Do not use read_file on attachment names like image.png; attachments are not workspace files until saved.',
      '- For Bootstrap/HTML hero requests with an attachment, save the attachment, read the existing HTML, then use replace_in_file or write_file to create a complete responsive hero section with meaningful layout, copy, image treatment, and Bootstrap classes. A single bare <img> insert is not sufficient.',
      '- Use replace_in_file for precise local edits, but only after you know the exact old_text currently in the file.',
      '- Use remove_lines_in_file for requests like remove/delete line 3. Never use delete_file for line edits.',
      '- Use replace_lines_in_file for requests that replace a complete line or range of lines.',
      '- Use insert_in_file when you need to place new text around an existing anchor, at a specific line_number, or at position start/end, without rewriting the whole file.',
      '- For insert_in_file, put the inserted string in text. Include needed leading/trailing spaces or newlines so prose does not run together.',
      '- For requests like after/before the first sentence in Markdown, ignore headings such as # Title; use the first prose sentence as anchor_text.',
      '- Use move_text_in_file, not insert_in_file, when the user asks to move/reposition existing text or when an exact standalone snippet already exists and the request sounds like placing it somewhere else. If spacing needs to change, put the original text in source_text and the destination text, including spaces/newlines, in text.',
      '- If the user says after/before specific text on a specific line, pass both line_number and anchor_text with position before/after so the anchor is matched only on that line.',
      '- Use create_directory before writing into a new folder.',
      '- Use move_file, copy_file, and delete_file for actual filesystem operations instead of simulating them with edits.',
      '- Use apply_patch only when a unified diff is the clearest representation.',
      '- Use read_multiple_files or grep_structured when you need structured cross-file inspection.',
      '- If the user refers to a file informally or without a clear path, locate it first with find_files, read_directory, or path_exists before assuming it is at the workspace root.',
      '- Use git_show, git_add, git_commit, and git_checkout only when the user explicitly asked for git operations.',
      '- For commit history questions, prefer git_log first.',
      '- When answering about the last/latest commit, include the changed files from git_log output as workspace file links when they are present.',
      '- To inspect a specific commit or learn which files changed in a commit, prefer git_show or git_diff with a specific revspec/commit instead of a full workspace diff.',
      '- If the user asks which files a commit changed, prefer a name-only or summary-style git inspection before requesting a full patch.',
      '- If an edit tool fails because required input is missing or the target text is not found, inspect the file and try again with a better tool input.',
      activeFile?.path ? `Active editor target file: ${activeFile.path}` : '',
      contextSummary ? `Workspace/VS Code context:\n${contextSummary}` : '',
      attachmentNotes,
      '- If the user references the visible/current/editor file or pastes editor contents without naming a path, use the Active editor target file. Do not invent placeholder paths like file.md.',
      'Current conversation:',
      conversation || `USER:\n${effectiveMessage}`,
      'Current turn tool transcript:',
      toolTranscript,
      'Decide the next single step now.',
    ].join('\n\n');
  }

  requiresLocalApproval(toolName) {
    const normalizedToolName = String(toolName || '').trim();
    if (normalizedToolName === 'save_attachment') {
      return false;
    }
    return ChatSessionService.MUTATING_TOOL_NAMES.has(normalizedToolName);
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

  isEditRequest(message = '') {
    return /\b(add|insert|write|append|replace|remove|delete|move|relocate|reposition|put|place|change|edit|update)\b/i.test(String(message || ''));
  }

  finalResponseClaimsSuccess(response = '') {
    return /\b(successfully|has been|have been|done|updated|inserted|added|removed|deleted|replaced|moved|changed|edited|wrote|written)\b/i.test(String(response || ''))
      && !this.finalResponseAcknowledgesToolFailure(response);
  }

  hasSuccessfulMutatingTool(toolHistory = []) {
    return toolHistory.some((step) => ChatSessionService.MUTATING_TOOL_NAMES.has(String(step?.tool || '').trim()) && step?.result?.ok === true);
  }

  buildMaxStepFallbackMessage(toolHistory = []) {
    const successfulMutation = [...toolHistory]
      .reverse()
      .find((step) => ChatSessionService.MUTATING_TOOL_NAMES.has(String(step?.tool || '').trim()) && step?.result?.ok === true);
    if (successfulMutation) {
      const result = successfulMutation.result && typeof successfulMutation.result === 'object' ? successfulMutation.result : {};
      const path = String(result.path || successfulMutation.input?.path || '').trim();
      const lineNumber = Number.parseInt(String(result.line_number || ''), 10) || 0;
      const target = path
        ? `${path}${lineNumber > 0 ? ` (line ${lineNumber})` : ''}`
        : 'the requested file';
      return `I completed the ${successfulMutation.tool} change in ${target}, but the planner ran out of follow-up steps before producing a polished final response.`;
    }

    const latestStep = toolHistory.length ? toolHistory[toolHistory.length - 1] : null;
    if (latestStep?.result?.ok === false) {
      return `The planner ran out of steps after ${latestStep.tool} failed: ${latestStep.result?.error || 'Tool execution failed.'}`;
    }

    if (latestStep) {
      return `The planner ran out of steps after running ${latestStep.tool}. No additional changes were applied after that step.`;
    }

    return 'The planner ran out of steps before it could complete the request.';
  }

  shouldFinalizeAfterSuccessfulTool(message = '', step = {}, toolHistory = []) {
    const toolName = String(step?.tool || '').trim();
    if (step?.result?.ok !== true || !ChatSessionService.MUTATING_TOOL_NAMES.has(toolName)) {
      return false;
    }
    if (toolName === 'save_attachment') {
      return false;
    }

    const userText = String(message || '');
    if (this.isHeroDesignAttachmentRequest(userText, toolHistory) && this.isBareHeroImageInsert(step)) {
      return false;
    }
    const moveIntent = /\b(move|relocate|reposition)\b/i.test(userText);
    if (!moveIntent) {
      return this.isEditRequest(userText);
    }

    if (toolName === 'move_text_in_file') {
      return true;
    }

    if (toolName === 'insert_in_file') {
      return toolHistory
        .slice(0, -1)
        .some((previous) => ChatSessionService.MUTATING_TOOL_NAMES.has(String(previous?.tool || '').trim()) && previous?.result?.ok === true);
    }

    return false;
  }

  isHeroDesignAttachmentRequest(message = '', toolHistory = []) {
    const userText = String(message || '');
    const heroIntent = /\b(hero|landing|homepage|home page|website|web\s*page|bootstrap|design|mockup|screenshot)\b/i.test(userText);
    if (!heroIntent) {
      return false;
    }
    return toolHistory.some((step) => String(step?.tool || '').trim() === 'save_attachment' && step?.result?.ok === true);
  }

  isBareHeroImageInsert(step = {}) {
    const toolName = String(step?.tool || '').trim();
    if (toolName !== 'insert_in_file') {
      return false;
    }
    const input = step.input && typeof step.input === 'object' ? step.input : {};
    const text = String(input.text || input.content || input.insert_text || input.insertText || '').trim();
    return /^<img\b[^>]*>\s*$/i.test(text) || (text.length < 240 && /^<[^>]+>\s*$/i.test(text) && /\bhero\.(?:png|jpe?g|webp|gif)\b/i.test(text));
  }

  getAutoFinalMessageAfterSuccessfulTool(message = '', toolHistory = [], requestedInsertLineTarget = null, requestedSentenceTarget = null) {
    const latestStep = toolHistory.length ? toolHistory[toolHistory.length - 1] : null;
    if (!this.shouldFinalizeAfterSuccessfulTool(message, latestStep, toolHistory)) {
      return '';
    }

    if (this.getMismatchedLineTargetedInsert(toolHistory, requestedInsertLineTarget)) {
      return '';
    }

    if (this.getMismatchedSentenceTargetedInsert(toolHistory, requestedSentenceTarget)) {
      return '';
    }

    return this.buildSuccessfulToolFinalMessage(latestStep);
  }

  buildSuccessfulToolFinalMessage(step = {}) {
    const toolName = String(step?.tool || 'tool').trim();
    const result = step.result && typeof step.result === 'object' ? step.result : {};
    const path = String(result.path || step.input?.path || '').trim();
    const lineNumber = Number.parseInt(String(result.line_number || ''), 10) || 0;
    const target = path
      ? `${path}${lineNumber > 0 ? ` (line ${lineNumber})` : ''}`
      : 'the requested file';

    if (toolName === 'move_text_in_file') {
      return `Moved the text in ${target}.`;
    }
    if (toolName === 'insert_in_file' || toolName === 'append_file') {
      return `Added the text in ${target}.`;
    }
    if (toolName === 'remove_lines_in_file') {
      return `Removed the requested line in ${target}.`;
    }
    if (toolName === 'replace_in_file' || toolName === 'replace_lines_in_file') {
      return `Updated ${target}.`;
    }

    return `Completed ${toolName} in ${target}.`;
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
      const numericOrdinalMatch = value.match(/\b(\d+)(?:st|nd|rd|th)\s+line\b/i);
      const lineNumber = numericMatch
        ? Number.parseInt(numericMatch[1], 10)
        : (numericOrdinalMatch
          ? Number.parseInt(numericOrdinalMatch[1], 10)
          : (ordinalMatch ? ordinalWords.get(String(ordinalMatch[1] || '').toLowerCase()) : 0));
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

  extractRequestedRemoveLineTarget(session, message = '') {
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
      if (!/\b(remove|delete|drop|clear)\b/i.test(value) || !/\bline\b/i.test(value)) {
        continue;
      }

      const numericMatch = value.match(/\b(?:line|line\s*number|line\s*#|#)\s*#?\s*(\d+)\b/i);
      const ordinalMatch = value.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+line\b/i);
      const numericOrdinalMatch = value.match(/\b(\d+)(?:st|nd|rd|th)\s+line\b/i);
      const lineNumber = numericMatch
        ? Number.parseInt(numericMatch[1], 10)
        : (numericOrdinalMatch
          ? Number.parseInt(numericOrdinalMatch[1], 10)
          : (ordinalMatch ? ordinalWords.get(String(ordinalMatch[1] || '').toLowerCase()) : 0));
      if (!lineNumber || lineNumber < 1) {
        continue;
      }

      const countMatch = value.match(/\b(?:remove|delete|drop|clear)\s+(\d+)\s+lines?\b/i)
        || value.match(/\b(\d+)\s+lines?\s+(?:from|starting)\b/i);
      const count = countMatch ? Math.max(1, Number.parseInt(countMatch[1], 10) || 1) : 1;
      return {
        lineNumber,
        count,
      };
    }

    return null;
  }

  normalizeLineTargetedInsertInput(toolName, input = {}, lineTarget = null) {
    const normalizedToolName = String(toolName || '').trim();
    if (!['insert_in_file', 'move_text_in_file'].includes(normalizedToolName) || !lineTarget?.lineNumber) {
      return input && typeof input === 'object' ? input : {};
    }

    return {
      ...(input && typeof input === 'object' ? input : {}),
      line_number: lineTarget.lineNumber,
      position: lineTarget.position,
    };
  }

  normalizeLineRemovalDecision(session, message = '', decision = {}, lineTarget = null) {
    if (!lineTarget?.lineNumber || String(decision?.tool || '').trim() !== 'delete_file') {
      return decision;
    }

    const input = decision.input && typeof decision.input === 'object' ? decision.input : {};
    const activeFile = this.getContextActiveFile(session);
    return {
      ...decision,
      tool: 'remove_lines_in_file',
      input: {
        path: String(input.path || activeFile?.path || '').trim(),
        line_number: lineTarget.lineNumber,
        count: lineTarget.count || 1,
      },
      explanation: decision.explanation || 'Remove requested line(s) without deleting the file.',
    };
  }

  extractRequestedSentenceTarget(session, message = '') {
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
      const match = value.match(/\b(before|after)\s+(?:the\s+)?(?:(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)|(\d+)(?:st|nd|rd|th)?)\s+sentence\b/i)
        || value.match(/\b(?:(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)|(\d+)(?:st|nd|rd|th)?)\s+sentence\b.*?\b(before|after)\b/i);
      if (!match) {
        continue;
      }

      const position = String(match[1] || match[6] || 'after').toLowerCase() === 'before' ? 'before' : 'after';
      const ordinalWord = String(match[2] || match[4] || '').toLowerCase();
      const numericValue = Number.parseInt(String(match[3] || match[5] || ''), 10) || 0;
      const sentenceNumber = ordinalWord ? ordinalWords.get(ordinalWord) : numericValue;
      if (sentenceNumber && sentenceNumber > 0) {
        return {
          sentenceNumber,
          position,
          newLine: /\b(new line|own line|line below|below)\b/i.test(value),
        };
      }
    }

    return null;
  }

  getLatestReadFileResult(toolHistory = [], path = '') {
    const requestedPath = String(path || '').trim().replaceAll('\\', '/').toLowerCase();
    for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
      const step = toolHistory[index] || {};
      if (String(step.tool || '').trim() !== 'read_file' || step.result?.ok !== true || typeof step.result?.content !== 'string') {
        continue;
      }
      const resultPath = String(step.result?.path || step.input?.path || '').trim().replaceAll('\\', '/').toLowerCase();
      if (!requestedPath || !resultPath || requestedPath === resultPath || resultPath.endsWith(`/${requestedPath}`)) {
        return step.result;
      }
    }
    return null;
  }

  findProseSentence(content = '', sentenceNumber = 1) {
    const target = Math.max(1, Number.parseInt(String(sentenceNumber || ''), 10) || 1);
    const lines = String(content || '').split(/\r?\n/);
    let seen = 0;
    let inFence = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = String(lines[index] || '');
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || !trimmed || /^#{1,6}\s+/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed)) {
        continue;
      }

      const sentencePattern = /[^.!?:]+[.!?:](?=\s|$)/g;
      let match;
      while ((match = sentencePattern.exec(line)) !== null) {
        const sentence = String(match[0] || '').trim();
        if (!sentence) {
          continue;
        }
        seen += 1;
        if (seen === target) {
          return {
            text: sentence,
            lineNumber: index + 1,
          };
        }
      }
    }

    return null;
  }

  normalizeInsertedTextForSentence(input = {}, sentenceTarget = null) {
    const record = input && typeof input === 'object' ? { ...input } : {};
    const position = String(sentenceTarget?.position || '').trim().toLowerCase();
    if (position !== 'after') {
      return record;
    }

    const textKeys = ['text', 'content', 'insert_text', 'insertText'];
    const key = textKeys.find((candidate) => Object.prototype.hasOwnProperty.call(record, candidate));
    if (!key) {
      return record;
    }

    const value = String(record[key] || '');
    if (value && sentenceTarget?.newLine && !value.startsWith('\n')) {
      record[key] = `\n${value.replace(/^\s+/, '')}`;
    } else if (value && !/^\s/.test(value)) {
      record[key] = ` ${value}`;
    }
    return record;
  }

  normalizeSentenceTargetedInput(toolName, input = {}, sentenceTarget = null, toolHistory = []) {
    const normalizedToolName = String(toolName || '').trim();
    if (!['insert_in_file', 'move_text_in_file'].includes(normalizedToolName) || !sentenceTarget?.sentenceNumber) {
      return input && typeof input === 'object' ? input : {};
    }

    const record = input && typeof input === 'object' ? input : {};
    const readResult = this.getLatestReadFileResult(toolHistory, record.path);
    const sentence = this.findProseSentence(readResult?.content || '', sentenceTarget.sentenceNumber);
    if (!sentence?.text) {
      return record;
    }

    return this.normalizeInsertedTextForSentence({
      ...record,
      path: record.path || readResult?.path,
      anchor_text: sentence.text,
      line_number: sentence.lineNumber,
      position: sentenceTarget.position,
    }, sentenceTarget);
  }

  needsReadBeforeSentenceTargetedEdit(toolName, input = {}, sentenceTarget = null, toolHistory = []) {
    const normalizedToolName = String(toolName || '').trim();
    if (!['insert_in_file', 'move_text_in_file'].includes(normalizedToolName) || !sentenceTarget?.sentenceNumber) {
      return false;
    }

    const record = input && typeof input === 'object' ? input : {};
    const readResult = this.getLatestReadFileResult(toolHistory, record.path);
    return !this.findProseSentence(readResult?.content || '', sentenceTarget.sentenceNumber);
  }

  normalizeMoveIntentDecision(message = '', decision = {}, toolHistory = []) {
    const userText = String(message || '');
    const moveIntent = /\b(move|relocate|reposition)\b/i.test(userText);
    const correctionPlacementIntent = /\b(i meant|actually|instead|put it|place it|should be)\b/i.test(userText)
      && /\b(new line|own line|below|above|before|after)\b/i.test(userText);
    if (String(decision?.tool || '').trim() !== 'insert_in_file' || (!moveIntent && !correctionPlacementIntent)) {
      return decision;
    }

    const input = decision.input && typeof decision.input === 'object' ? decision.input : {};
    const insertedText = String(
      Object.prototype.hasOwnProperty.call(input, 'text') ? input.text
        : Object.prototype.hasOwnProperty.call(input, 'content') ? input.content
          : Object.prototype.hasOwnProperty.call(input, 'insert_text') ? input.insert_text
            : Object.prototype.hasOwnProperty.call(input, 'insertText') ? input.insertText
              : '',
    );
    const sourceText = insertedText.trim();
    if (!sourceText) {
      return decision;
    }

    const readResult = this.getLatestReadFileResult(toolHistory, input.path);
    const content = String(readResult?.content || '');
    if (!content.includes(sourceText)) {
      return decision;
    }
    const sourcePattern = new RegExp(`(^|\\n|[ \\t])${this.escapeRegExp(sourceText)}(?=\\s|$)`, 'm');
    const sourceMatch = content.match(sourcePattern);
    const resolvedSourceText = sourceMatch
      ? String(sourceMatch[0] || '').replace(/^\n/, '')
      : sourceText;

    return {
      ...decision,
      tool: 'move_text_in_file',
      input: {
        ...input,
        source_text: input.source_text || input.sourceText || resolvedSourceText,
        text: insertedText,
      },
      explanation: decision.explanation || 'Move the existing text instead of inserting a duplicate.',
    };
  }

  escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  normalizeContextualPathInput(session, message = '', toolName = '', input = {}) {
    const normalizedToolName = String(toolName || '').trim();
    const pathTools = new Set([
      'read_file',
      'search_text',
      'file_search',
      'insert_in_file',
      'move_text_in_file',
      'replace_lines_in_file',
      'remove_lines_in_file',
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
    const placeholderPath = /^(?:file|current-file|current_file|active-file|active_file|document|doc|untitled|relative\/path|path\/to\/file|relative-path)(?:\.[a-z0-9_-]+)?$/i.test(requestedPath);
    const currentFileRequest = /\b(current|active|open|visible|editor|this)\b/.test(userText) || userText.includes('# ');
    if (placeholderPath) {
      return {
        ...record,
        path: activeFile.path,
      };
    }
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

  getMismatchedSentenceTargetedInsert(toolHistory = [], sentenceTarget = null) {
    if (!sentenceTarget?.sentenceNumber) {
      return null;
    }

    for (let index = toolHistory.length - 1; index >= 0; index -= 1) {
      const step = toolHistory[index] || {};
      if (!['insert_in_file', 'move_text_in_file'].includes(String(step.tool || '').trim()) || step.result?.ok !== true) {
        continue;
      }

      const resultLine = Number.parseInt(String(step.result?.line_number || ''), 10) || 0;
      const path = String(step.input?.path || step.result?.path || '').trim();
      const readResult = this.getLatestReadFileResult(toolHistory.slice(0, index), path);
      const sentence = this.findProseSentence(readResult?.content || '', sentenceTarget.sentenceNumber);
      if (sentence?.lineNumber && resultLine && resultLine !== sentence.lineNumber) {
        return {
          step,
          expectedLine: sentence.lineNumber,
        };
      }
      return null;
    }

    return null;
  }

  validateBridgeToolInput(toolName, input = {}) {
    const normalizedToolName = String(toolName || '').trim();
    const record = input && typeof input === 'object' ? input : {};

    if (normalizedToolName === 'replace_in_file') {
      const hasOldText = Object.prototype.hasOwnProperty.call(record, 'old_text')
        || Object.prototype.hasOwnProperty.call(record, 'oldText')
        || Object.prototype.hasOwnProperty.call(record, 'old');
      const hasNewText = Object.prototype.hasOwnProperty.call(record, 'new_text')
        || Object.prototype.hasOwnProperty.call(record, 'newText')
        || Object.prototype.hasOwnProperty.call(record, 'new')
        || Object.prototype.hasOwnProperty.call(record, 'new_content')
        || Object.prototype.hasOwnProperty.call(record, 'newContent')
        || Array.isArray(record.new_lines)
        || Array.isArray(record.newLines);
      if (!String(record.path || '').trim()) {
        return 'replace_in_file requires a path.';
      }
      if (!hasOldText || !String(record.old_text ?? record.oldText ?? record.old ?? '')) {
        return 'replace_in_file requires old_text (or old). Read the file first, then retry with exact old_text and new_text.';
      }
      if (!hasNewText) {
        return 'replace_in_file requires new_text (or new).';
      }
    }

    if (normalizedToolName === 'save_attachment') {
      if (!String(record.path || '').trim()) {
        return 'save_attachment requires a path.';
      }
    }

    if (normalizedToolName === 'replace_lines_in_file') {
      const lineNumber = Number.parseInt(String(record.line_number || record.lineNumber || record.line || record.start_line || record.startLine || ''), 10) || 0;
      const hasText = Object.prototype.hasOwnProperty.call(record, 'text')
        || Object.prototype.hasOwnProperty.call(record, 'content')
        || Object.prototype.hasOwnProperty.call(record, 'new_text')
        || Object.prototype.hasOwnProperty.call(record, 'newText')
        || Object.prototype.hasOwnProperty.call(record, 'new_content')
        || Object.prototype.hasOwnProperty.call(record, 'newContent')
        || Array.isArray(record.new_lines)
        || Array.isArray(record.newLines);
      if (!String(record.path || '').trim()) {
        return 'replace_lines_in_file requires a path.';
      }
      if (lineNumber <= 0) {
        return 'replace_lines_in_file requires line_number (or start_line).';
      }
      if (!hasText) {
        return 'replace_lines_in_file requires text (or content, new_text, new_content, new_lines).';
      }
    }

    if (normalizedToolName === 'remove_lines_in_file') {
      const lineNumber = Number.parseInt(String(record.line_number || record.lineNumber || record.line || record.start_line || record.startLine || ''), 10) || 0;
      if (!String(record.path || '').trim()) {
        return 'remove_lines_in_file requires a path.';
      }
      if (lineNumber <= 0) {
        return 'remove_lines_in_file requires line_number (or start_line).';
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
      const hasText = Object.prototype.hasOwnProperty.call(record, 'text')
        || Object.prototype.hasOwnProperty.call(record, 'content')
        || Object.prototype.hasOwnProperty.call(record, 'insert_text')
        || Object.prototype.hasOwnProperty.call(record, 'insertText');
      if (!hasText) {
        return 'insert_in_file requires text (or content, insert_text, insertText).';
      }
    }

    if (normalizedToolName === 'move_text_in_file') {
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
      const hasText = Object.prototype.hasOwnProperty.call(record, 'text')
        || Object.prototype.hasOwnProperty.call(record, 'content')
        || Object.prototype.hasOwnProperty.call(record, 'insert_text')
        || Object.prototype.hasOwnProperty.call(record, 'insertText')
        || Object.prototype.hasOwnProperty.call(record, 'source_text')
        || Object.prototype.hasOwnProperty.call(record, 'sourceText');
      if (!String(record.path || '').trim()) {
        return 'move_text_in_file requires a path.';
      }
      if (!hasText) {
        return 'move_text_in_file requires text (or content, insert_text, insertText).';
      }
      if (!anchorText && !insertsAtBoundary && lineNumber <= 0) {
        return 'move_text_in_file requires anchor_text (or anchorText, anchor, search_text), line_number, or position start/end.';
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

    if (normalizedToolName === 'file_search') {
      const hasQuery = String(record.query || '').trim() !== '';
      const hasPattern = String(record.pattern || '').trim() !== '';
      if (!hasQuery && !hasPattern && !String(record.path || '').trim()) {
        return 'file_search requires query, pattern, or path.';
      }
    }

    if (normalizedToolName === 'run_command' && !String(record.command || '').trim()) {
      return 'run_command requires a command.';
    }

    if (normalizedToolName === 'shell' && !String(record.command || '').trim()) {
      return 'shell requires a command.';
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
    if (attachments.length || tempImagePaths.length) {
      this.logPlanner(session, `attachments=${attachments.length} materialized_images=${tempImagePaths.length}`);
    }
    const toolExecutor = new LocalToolExecutor({
      workspaceRoot: this.deps.getConfiguredWorkspaceRoot(),
      attachments,
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
    const requestedRemoveLineTarget = this.extractRequestedRemoveLineTarget(session, message);
    const requestedSentenceTarget = this.extractRequestedSentenceTarget(session, message);
    const plannerThinkingParts = [];
    const recordPlannerThinking = (rawValue) => {
      const split = this.splitReasoningContent(rawValue || '');
      if (!split.thinking) {
        return split;
      }
      plannerThinkingParts.push(split.thinking);
      return split;
    };
    const getPlannerThinking = () => this.capThinkingText(plannerThinkingParts.join('\n\n'));

    try {
      this.logPlanner(session, `start message=${JSON.stringify(this.summarizePlannerText(message, 160))}`);
      for (let step = 0; step < maxSteps; step += 1) {
        if (session.cancelRequested) {
          throw new Error('Canceled by user.');
        }

        const plannerPrompt = this.buildBridgeToolPlannerPrompt({
          session,
          message,
          toolExecutor,
          toolHistory,
        });
        this.logPlanner(session, `step=${step + 1}/${maxSteps} prompt_chars=${plannerPrompt.length} tool_history=${toolHistory.length}`);
        const assistantText = await this.runExecPrompt(session, plannerPrompt, step === 0 ? tempImagePaths : []);
        recordPlannerThinking(assistantText);
        this.logPlanner(session, `step=${step + 1} raw=${JSON.stringify(this.summarizePlannerText(assistantText))}`);
        let decision = this.parseBridgePlannerResponse(assistantText);

        if (!decision) {
          this.logPlanner(session, `step=${step + 1} parse=failed repair=starting`);
          const repairedText = await this.runExecPrompt(
            session,
            this.buildBridgePlannerRepairPrompt(assistantText),
            [],
          );
          recordPlannerThinking(repairedText);
          this.logPlanner(session, `step=${step + 1} repair_raw=${JSON.stringify(this.summarizePlannerText(repairedText))}`);
          decision = this.parseBridgePlannerResponse(repairedText);
          if (!decision) {
            this.logPlanner(session, `step=${step + 1} parse=failed json_only_retry=starting`);
            const retryText = await this.runExecPrompt(
              session,
              this.buildBridgePlannerJsonOnlyRetryPrompt(repairedText || assistantText),
              [],
            );
            recordPlannerThinking(retryText);
            this.logPlanner(session, `step=${step + 1} json_only_retry_raw=${JSON.stringify(this.summarizePlannerText(retryText))}`);
            decision = this.parseBridgePlannerResponse(retryText);
          }
        }

        if (!decision) {
          this.logPlanner(session, `step=${step + 1} parse=failed_final_fallback`);
          const fallbackMessage = this.splitReasoningContent(assistantText.trim());
          const fallbackThinking = getPlannerThinking();
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            text: fallbackMessage.text || 'I could not normalize the model response into a tool action.',
            thinking: fallbackThinking || undefined,
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
          if (this.isEditRequest(message) && this.finalResponseClaimsSuccess(decision.response) && !this.hasSuccessfulMutatingTool(toolHistory)) {
            const guardError = 'Cannot claim success for an edit request because no mutating workspace tool succeeded in this turn.';
            this.logPlanner(session, `step=${step + 1} final=rejected_without_successful_mutation error=${JSON.stringify(this.summarizePlannerText(guardError))}`);
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
          const mismatchedSentenceInsert = this.getMismatchedSentenceTargetedInsert(toolHistory, requestedSentenceTarget);
          if (mismatchedSentenceInsert && !this.finalResponseAcknowledgesToolFailure(decision.response)) {
            const guardError = `Cannot claim success because ${mismatchedSentenceInsert.step.tool} wrote line ${mismatchedSentenceInsert.step.result?.line_number || '(unknown)'}, but the requested sentence target is on line ${mismatchedSentenceInsert.expectedLine}.`;
            this.logPlanner(session, `step=${step + 1} final=rejected_after_sentence_mismatch error=${JSON.stringify(this.summarizePlannerText(guardError))}`);
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
          const finalThinking = [getPlannerThinking(), finalMessage.thinking].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            text: finalMessage.text || 'No response returned.',
            thinking: finalThinking || undefined,
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

        decision = this.normalizeLineRemovalDecision(session, message, decision, requestedRemoveLineTarget);
        decision.input = this.normalizeContextualPathInput(session, message, decision.tool, decision.input || {});
        decision.input = this.normalizeLineTargetedInsertInput(decision.tool, decision.input || {}, requestedInsertLineTarget);
        if (this.needsReadBeforeSentenceTargetedEdit(decision.tool, decision.input || {}, requestedSentenceTarget, toolHistory)) {
          const activeFile = this.getContextActiveFile(session);
          decision = {
            type: 'tool_call',
            tool: 'read_file',
            input: {
              path: String(decision.input?.path || activeFile?.path || '').trim(),
            },
            explanation: 'Read the file before resolving the requested sentence target.',
          };
        }
        decision.input = this.normalizeSentenceTargetedInput(decision.tool, decision.input || {}, requestedSentenceTarget, toolHistory);
        decision = this.normalizeMoveIntentDecision(message, decision, toolHistory);

        this.logPlanner(
          session,
          `step=${step + 1} decision=tool_call tool=${decision.tool} input=${JSON.stringify(decision.input || {})}`,
        );
        this.appendSessionEvent(session, {
          type: 'bridge.planner.step',
          preview: decision.tool === 'save_attachment'
            ? 'Saving attached image...'
            : (decision.explanation || `Running ${decision.tool}`),
          tool: {
            name: decision.tool,
            input: decision.input || {},
          },
        });
        const toolResult = await this.executeBridgeTool(session, toolExecutor, decision.tool, decision.input || {});
        if (session.cancelRequested) {
          throw new Error('Canceled by user.');
        }
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

        const autoFinalMessage = this.getAutoFinalMessageAfterSuccessfulTool(
          message,
          toolHistory,
          requestedInsertLineTarget,
          requestedSentenceTarget,
        );
        if (autoFinalMessage) {
          this.logPlanner(session, `step=${step + 1} auto_final=successful_tool tool=${decision.tool}`);
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            text: autoFinalMessage,
            thinking: getPlannerThinking() || undefined,
            created_at: Date.now(),
          });
          session.status = 'idle';
          session.running = false;
          session.pendingApproval = null;
          session.pendingApprovalResolver = null;
          session.pendingAttachments = [];
          session.updatedAt = Date.now();
          this.publishSession(session, 'session.message');
          this.publishSession(session, 'session.completed');
          return session;
        }
      }

      this.logPlanner(session, `error=max_steps_exceeded steps=${maxSteps}`);
      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        text: this.buildMaxStepFallbackMessage(toolHistory),
        thinking: getPlannerThinking() || undefined,
        created_at: Date.now(),
      });
      session.status = 'idle';
      session.running = false;
      session.pendingApproval = null;
      session.pendingApprovalResolver = null;
      session.pendingAttachments = [];
      session.updatedAt = Date.now();
      this.publishSession(session, 'session.message');
      this.publishSession(session, 'session.completed');
      return session;
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
