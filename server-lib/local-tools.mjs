import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_TOOL_DEFINITIONS = [
  {
    name: 'list_files',
    description: 'List repository files relative to the workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_text',
    description: 'Search for text within workspace files.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: 'Write UTF-8 text content directly to a workspace file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_file',
    description: 'Append UTF-8 text content to a workspace file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_in_file',
    description: 'Replace exact text in a workspace file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'insert_in_file',
    description: 'Insert text before or after an anchor string, or at the start/end of a workspace file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        anchor_text: { type: 'string' },
        anchorText: { type: 'string' },
        anchor: { type: 'string' },
        search_text: { type: 'string' },
        text: { type: 'string' },
        position: { type: 'string', enum: ['before', 'after', 'start', 'end', 'beginning'] },
        location: { type: 'string', enum: ['start', 'end', 'beginning'] },
        occurrence: { type: 'string', enum: ['first', 'last'] },
      },
      required: ['path', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_directory',
    description: 'Create a directory in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
        source_path: { type: 'string' },
        destination_path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'copy_file',
    description: 'Copy a file in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
        source_path: { type: 'string' },
        destination_path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'path_exists',
    description: 'Check whether a file or directory exists in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'stat_file',
    description: 'Inspect metadata for a file or directory in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_directory',
    description: 'Read a directory and return structured entries.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'find_files',
    description: 'Find files in the workspace with an optional glob-style pattern.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_multiple_files',
    description: 'Read multiple UTF-8 text files from the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep_structured',
    description: 'Search text and return structured match records.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command inside the workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_status',
    description: 'Inspect local git status in the workspace root.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'git_log',
    description: 'Inspect recent git history in the workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer' },
        author: { type: 'string' },
        options: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_diff',
    description: 'Inspect git diff output in the workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        revspec: { type: 'string' },
        revision: { type: 'string' },
        commit: { type: 'string' },
        name_only: { type: 'boolean' },
        stat: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_show',
    description: 'Inspect a specific git object, revision, or file revision.',
    input_schema: {
      type: 'object',
      properties: {
        revspec: { type: 'string' },
      },
      required: ['revspec'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_add',
    description: 'Stage files in git when the user explicitly asks for it.',
    input_schema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_commit',
    description: 'Create a git commit when the user explicitly asks for it.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_checkout',
    description: 'Run git checkout for a revision or specific paths when explicitly requested.',
    input_schema: {
      type: 'object',
      properties: {
        revspec: { type: 'string' },
        paths: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a verified workspace patch through the bridge executor.',
    input_schema: {
      type: 'object',
      properties: {
        patch: { type: 'string' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
  },
];

export function summarizeLocalToolProtocol() {
  return LOCAL_TOOL_DEFINITIONS.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
}

function isWindowsAbsolutePath(value = '') {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '').trim());
}

function isDecodedFileUrlWindowsPath(value = '') {
  return /^\/[a-zA-Z]:\//.test(String(value || '').trim());
}

function toComparablePath(value = '') {
  return String(value || '').replaceAll('\\', '/').toLowerCase();
}

function maybeTranslateWindowsPathForPosix(candidatePath, workspaceRoot) {
  const value = String(candidatePath || '').trim();
  if (process.platform === 'win32') {
    return value;
  }

  const normalizedWindowsPath = isDecodedFileUrlWindowsPath(value)
    ? `${value[1]}:${value.slice(3)}`
    : value;

  if (!isWindowsAbsolutePath(normalizedWindowsPath)) {
    return value;
  }

  const workspaceComparable = toComparablePath(workspaceRoot);
  if (!workspaceComparable.startsWith('/mnt/')) {
    return normalizedWindowsPath;
  }

  const driveLetter = normalizedWindowsPath[0].toLowerCase();
  const remainder = normalizedWindowsPath.slice(2).replaceAll('\\', '/');
  return `/mnt/${driveLetter}${remainder.startsWith('/') ? remainder : `/${remainder}`}`;
}

function resolveWorkspacePath(workspaceRoot, relativePath = '') {
  const root = resolve(workspaceRoot);
  const raw = String(relativePath || '').trim();
  let candidate = raw;

  if (/^file:\/\//i.test(candidate)) {
    candidate = fileURLToPath(candidate);
  }

  candidate = maybeTranslateWindowsPathForPosix(candidate, root);

  const target = resolve(
    isAbsolute(candidate) || isWindowsAbsolutePath(candidate)
      ? candidate
      : join(root, candidate),
  );

  const comparableRoot = toComparablePath(root);
  const comparableTarget = toComparablePath(target);
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}/`)) {
    throw new Error('Resolved path escapes the workspace root.');
  }
  return target;
}

function getLineNumberFromOffset(text = '', offset = 0) {
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, String(text || '').length));
  return String(text || '').slice(0, safeOffset).split('\n').length;
}

function normalizeLookupName(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseGitRemoteUrl(remoteUrl = '') {
  const value = String(remoteUrl || '').trim();
  if (!value) {
    return null;
  }

  const sshMatch = value.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      host: String(sshMatch[1] || '').trim().toLowerCase(),
      repoPath: String(sshMatch[2] || '').trim().replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(value);
    return {
      host: String(url.hostname || '').trim().toLowerCase(),
      repoPath: String(url.pathname || '').trim().replace(/^\/+/, '').replace(/\.git$/i, ''),
    };
  } catch (_error) {
    return null;
  }
}

function buildCommitUrl(remoteUrl = '', commitSha = '') {
  const parsed = parseGitRemoteUrl(remoteUrl);
  const sha = String(commitSha || '').trim();
  if (!parsed || !sha || !parsed.repoPath) {
    return '';
  }

  if (parsed.host.includes('github.com')) {
    return `https://${parsed.host}/${parsed.repoPath}/commit/${sha}`;
  }

  if (parsed.host.includes('bitbucket.org')) {
    return `https://${parsed.host}/${parsed.repoPath}/commits/${sha}`;
  }

  if (parsed.host.includes('gitlab')) {
    return `https://${parsed.host}/${parsed.repoPath}/-/commit/${sha}`;
  }

  return '';
}

const DEFAULT_LIST_FILES_LIMIT = 1000;
const MAX_LIST_FILES_LIMIT = 5000;
const LIST_FILES_SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'venv',
]);

function clampListFilesLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIST_FILES_LIMIT;
  }
  return Math.max(1, Math.min(parsed, MAX_LIST_FILES_LIMIT));
}

function splitToolOutputLines(output = '') {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatListFilesResult({ files, limit, root, source, tool = 'list_files' }) {
  const truncated = files.length > limit;
  const visibleFiles = truncated ? files.slice(0, limit) : files;
  return {
    ok: true,
    tool,
    root,
    output: visibleFiles.join('\n'),
    files: visibleFiles,
    count: visibleFiles.length,
    truncated,
    limit,
    source,
    message: truncated ? `Output limited to the first ${limit} files. Pass a narrower path, pattern, or higher limit for more.` : undefined,
  };
}

async function listFilesFromDisk(workspaceRoot, relativePath, { pattern = '', limit = DEFAULT_LIST_FILES_LIMIT } = {}) {
  const targetPath = resolveWorkspacePath(workspaceRoot, relativePath);
  const files = [];
  const normalizedRoot = resolve(workspaceRoot);

  const addFile = (absolutePath) => {
    const relativeFilePath = relative(normalizedRoot, absolutePath).replaceAll('\\', '/');
    if (!relativeFilePath || (pattern && !relativeFilePath.includes(pattern))) {
      return;
    }
    files.push(relativeFilePath);
  };

  const visitDirectory = async (absolutePath) => {
    if (files.length > limit) {
      return;
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (files.length > limit) {
        return;
      }

      const entryPath = join(absolutePath, entry.name);
      if (entry.isDirectory()) {
        if (!LIST_FILES_SKIPPED_DIRECTORIES.has(entry.name)) {
          await visitDirectory(entryPath);
        }
        continue;
      }

      if (entry.isFile()) {
        addFile(entryPath);
      }
    }
  };

  const details = await stat(targetPath);
  if (details.isFile()) {
    addFile(targetPath);
  } else if (details.isDirectory()) {
    await visitDirectory(targetPath);
  } else {
    throw new Error('list_files only supports files and directories.');
  }

  return files;
}

function getShellCandidates() {
  const candidates = [];
  const pushCandidate = (command, args) => {
    if (!command || candidates.some((entry) => entry.command === command && JSON.stringify(entry.args) === JSON.stringify(args))) {
      return;
    }
    candidates.push({ command, args });
  };

  const envShell = String(process.env.SHELL || '').trim();
  if (envShell) {
    pushCandidate(envShell, ['-lc']);
  }

  pushCandidate('/bin/bash', ['-lc']);
  pushCandidate('bash', ['-lc']);
  pushCandidate('/bin/sh', ['-lc']);
  pushCandidate('sh', ['-lc']);

  if (process.platform === 'win32') {
    const comSpec = String(process.env.ComSpec || '').trim();
    if (comSpec) {
      pushCandidate(comSpec, ['/d', '/s', '/c']);
    }
    pushCandidate('cmd.exe', ['/d', '/s', '/c']);
  }

  return candidates;
}

function runShellCommand(command, { cwd, timeoutMs = 20000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const candidates = getShellCandidates();
    let candidateIndex = 0;

    const tryNextCandidate = (lastError = null) => {
      if (candidateIndex >= candidates.length) {
        rejectPromise(lastError || new Error('No usable shell was available for workspace command execution.'));
        return;
      }

      const candidate = candidates[candidateIndex];
      candidateIndex += 1;
      const child = spawn(candidate.command, [...candidate.args, command], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(value);
      };

      const timeoutHandle = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch (_error) {}
        finish(new Error(`Command timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timeoutHandle);
        if (error?.code === 'ENOENT') {
          tryNextCandidate(lastError || error);
          return;
        }
        finish(error);
      });

      child.on('exit', (code) => {
        if (code !== 0) {
          finish(new Error((stderr.trim() || `Command exited with code ${code ?? 1}`).trim()));
          return;
        }

        finish(null, {
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
        });
      });
    };

    tryNextCandidate();
  });
}

async function resolveExistingWorkspaceFile(workspaceRoot, requestedPath = '') {
  const trimmedPath = String(requestedPath || '').trim();
  if (!trimmedPath) {
    throw new Error('A workspace path is required.');
  }

  const exactPath = resolveWorkspacePath(workspaceRoot, trimmedPath);
  try {
    await stat(exactPath);
    return {
      absolutePath: exactPath,
      relativePath: relative(workspaceRoot, exactPath).replaceAll('\\', '/'),
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  if (
    trimmedPath.includes('/') ||
    trimmedPath.includes('\\') ||
    trimmedPath.startsWith('.') ||
    isAbsolute(trimmedPath) ||
    isWindowsAbsolutePath(trimmedPath)
  ) {
    throw new Error(`ENOENT: no such file or directory, open '${exactPath}'`);
  }

  const fileName = basename(trimmedPath);
  const exactMatches = [];
  try {
    const exactResult = await runShellCommand(`rg --files . -g ${JSON.stringify(`**/${fileName}`)} -g ${JSON.stringify(fileName)}`, {
      cwd: workspaceRoot,
      timeoutMs: 10000,
    });
    exactMatches.push(...String(exactResult.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } catch (_error) {}

  const dedupedExactMatches = [...new Set(exactMatches)];
  if (dedupedExactMatches.length === 1) {
    const matchedRelativePath = dedupedExactMatches[0];
    return {
      absolutePath: resolveWorkspacePath(workspaceRoot, matchedRelativePath),
      relativePath: matchedRelativePath.replaceAll('\\', '/'),
    };
  }
  if (dedupedExactMatches.length > 1) {
    throw new Error(`Multiple workspace files match '${trimmedPath}': ${dedupedExactMatches.slice(0, 8).join(', ')}`);
  }

  const normalizedRequestedName = normalizeLookupName(fileName);
  if (!normalizedRequestedName) {
    throw new Error(`ENOENT: no such file or directory, open '${exactPath}'`);
  }

  try {
    const fuzzyResult = await runShellCommand('rg --files .', {
      cwd: workspaceRoot,
      timeoutMs: 15000,
    });
    const fuzzyMatches = String(fuzzyResult.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => normalizeLookupName(basename(line)) === normalizedRequestedName);

    const dedupedFuzzyMatches = [...new Set(fuzzyMatches)];
    if (dedupedFuzzyMatches.length === 1) {
      const matchedRelativePath = dedupedFuzzyMatches[0];
      return {
        absolutePath: resolveWorkspacePath(workspaceRoot, matchedRelativePath),
        relativePath: matchedRelativePath.replaceAll('\\', '/'),
      };
    }
    if (dedupedFuzzyMatches.length > 1) {
      throw new Error(`Multiple workspace files closely match '${trimmedPath}': ${dedupedFuzzyMatches.slice(0, 8).join(', ')}`);
    }
  } catch (error) {
    if (String(error?.message || '').includes('Multiple workspace files')) {
      throw error;
    }
  }

  throw new Error(`ENOENT: no such file or directory, open '${exactPath}'`);
}

export class LocalToolExecutor {
  constructor({ workspaceRoot }) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  getToolDefinitions() {
    return LOCAL_TOOL_DEFINITIONS;
  }

  async execute(toolName, input = {}) {
    switch (toolName) {
      case 'list_files':
        return this.listFiles(input);
      case 'read_file':
        return this.readFile(input);
      case 'search_text':
        return this.searchText(input);
      case 'write_file':
        return this.writeFile(input);
      case 'append_file':
        return this.appendFile(input);
      case 'replace_in_file':
        return this.replaceInFile(input);
      case 'insert_in_file':
        return this.insertInFile(input);
      case 'delete_file':
        return this.deleteFile(input);
      case 'create_directory':
        return this.createDirectory(input);
      case 'move_file':
        return this.moveFile(input);
      case 'copy_file':
        return this.copyFile(input);
      case 'path_exists':
        return this.pathExists(input);
      case 'stat_file':
        return this.statFile(input);
      case 'read_directory':
        return this.readDirectory(input);
      case 'find_files':
        return this.findFiles(input);
      case 'read_multiple_files':
        return this.readMultipleFiles(input);
      case 'grep_structured':
        return this.grepStructured(input);
      case 'run_command':
        return this.runCommand(input);
      case 'git_status':
        return this.gitStatus();
      case 'git_log':
        return this.gitLog(input);
      case 'git_diff':
        return this.gitDiff(input);
      case 'git_show':
        return this.gitShow(input);
      case 'git_add':
        return this.gitAdd(input);
      case 'git_commit':
        return this.gitCommit(input);
      case 'git_checkout':
        return this.gitCheckout(input);
      case 'apply_patch':
        return this.applyPatch(input);
      default:
        throw new Error(`Unsupported local tool: ${toolName}`);
    }
  }

  async listFiles(input = {}) {
    const relativePath = String(input.path || '.').trim() || '.';
    const pattern = String(input.pattern || '').trim();
    const limit = clampListFilesLimit(input.limit);
    const targetPath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const normalizedRelativePath = relative(this.workspaceRoot, targetPath).replaceAll('\\', '/') || '.';
    const commandPath = normalizedRelativePath === '.' ? '.' : normalizedRelativePath;
    const headLimit = limit + 1;

    try {
      const grepSegment = pattern ? ` | grep ${JSON.stringify(pattern)}` : '';
      const rgCommand = `command -v rg >/dev/null 2>&1 || exit 127; rg --files ${JSON.stringify(commandPath)}${grepSegment} | head -n ${headLimit}`;
      const result = await runShellCommand(rgCommand, { cwd: this.workspaceRoot, timeoutMs: 10000 });
      const files = splitToolOutputLines(result.stdout);
      return formatListFilesResult({
        files,
        limit,
        root: this.workspaceRoot,
        source: 'rg',
      });
    } catch (_error) {}

    try {
      await runShellCommand('git rev-parse --is-inside-work-tree', { cwd: this.workspaceRoot, timeoutMs: 3000 });
      const grepSegment = pattern ? ` | grep ${JSON.stringify(pattern)}` : '';
      const gitCommand = `git ls-files --cached --others --exclude-standard -- ${JSON.stringify(commandPath)}${grepSegment} | head -n ${headLimit}`;
      const result = await runShellCommand(gitCommand, { cwd: this.workspaceRoot, timeoutMs: 10000 });
      const files = splitToolOutputLines(result.stdout);
      return formatListFilesResult({
        files,
        limit,
        root: this.workspaceRoot,
        source: 'git',
      });
    } catch (_error) {
      const files = await listFilesFromDisk(this.workspaceRoot, relativePath, { pattern, limit });
      return formatListFilesResult({
        files,
        limit,
        root: this.workspaceRoot,
        source: 'filesystem',
      });
    }
  }

  async readFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('read_file requires a path.');
    }
    const resolvedFile = await resolveExistingWorkspaceFile(this.workspaceRoot, relativePath);
    const filePath = resolvedFile.absolutePath;
    const content = await readFile(filePath, 'utf8');
    return {
      ok: true,
      tool: 'read_file',
      path: resolvedFile.relativePath,
      content,
    };
  }

  async searchText(input = {}) {
    const query = String(input.query || '').trim();
    if (!query) {
      throw new Error('search_text requires a query.');
    }
    const relativePath = String(input.path || '.').trim() || '.';
    const escapedPath = relativePath.replaceAll('"', '\\"');
    const command = `rg -n ${JSON.stringify(query)} "${escapedPath}"`;
    const result = await runShellCommand(command, { cwd: this.workspaceRoot });
    return {
      ok: true,
      tool: 'search_text',
      query,
      output: result.stdout,
    };
  }

  async writeFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('write_file requires a path.');
    }

    const filePath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const content = String(input.content || '');
    await writeFile(filePath, content, 'utf8');
    return {
      ok: true,
      tool: 'write_file',
      path: relativePath,
      line_number: 1,
      bytes_written: Buffer.byteLength(content, 'utf8'),
    };
  }

  async appendFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('append_file requires a path.');
    }

    const resolvedFile = await resolveExistingWorkspaceFile(this.workspaceRoot, relativePath);
    const filePath = resolvedFile.absolutePath;
    const existing = await readFile(filePath, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    const content = String(input.content || '');
    const nextContent = `${existing}${content}`;
    await writeFile(filePath, nextContent, 'utf8');
    const lineNumber = existing
      ? existing.split('\n').length
      : 1;
    return {
      ok: true,
      tool: 'append_file',
      path: resolvedFile.relativePath,
      line_number: lineNumber,
      bytes_written: Buffer.byteLength(content, 'utf8'),
    };
  }

  async replaceInFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    const oldText = String(input.old_text || '');
    const newText = String(input.new_text || '');
    const replaceAll = input.replace_all === true;

    if (!relativePath) {
      throw new Error('replace_in_file requires a path.');
    }
    if (oldText === '') {
      throw new Error('replace_in_file requires old_text.');
    }

    const resolvedFile = await resolveExistingWorkspaceFile(this.workspaceRoot, relativePath);
    const filePath = resolvedFile.absolutePath;
    const original = await readFile(filePath, 'utf8');
    if (!original.includes(oldText)) {
      throw new Error('replace_in_file could not find the target text.');
    }

    const nextContent = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    await writeFile(filePath, nextContent, 'utf8');
    const firstMatchIndex = original.indexOf(oldText);

    const replacementCount = replaceAll
      ? original.split(oldText).length - 1
      : 1;

    return {
      ok: true,
      tool: 'replace_in_file',
      path: resolvedFile.relativePath,
      line_number: getLineNumberFromOffset(original, firstMatchIndex),
      replacements: replacementCount,
    };
  }

  async insertInFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    const rawPosition = String(input.position || input.location || 'after').trim().toLowerCase();
    const anchorText = String(
      input.anchor_text
      || input.anchorText
      || input.anchor
      || input.search_text
      || '',
    );
    const text = String(input.text || '');
    const position = ['start', 'beginning', 'top'].includes(rawPosition)
      ? 'start'
      : (['end', 'bottom'].includes(rawPosition) ? 'end' : (rawPosition === 'before' ? 'before' : 'after'));
    const occurrence = String(input.occurrence || 'first').trim().toLowerCase() === 'last' ? 'last' : 'first';

    if (!relativePath) {
      throw new Error('insert_in_file requires a path.');
    }

    const resolvedFile = await resolveExistingWorkspaceFile(this.workspaceRoot, relativePath);
    const filePath = resolvedFile.absolutePath;
    const original = await readFile(filePath, 'utf8');
    if (position === 'start' || position === 'end') {
      const insertionPoint = position === 'start' ? 0 : original.length;
      const nextContent = `${original.slice(0, insertionPoint)}${text}${original.slice(insertionPoint)}`;
      await writeFile(filePath, nextContent, 'utf8');
      return {
        ok: true,
        tool: 'insert_in_file',
        path: resolvedFile.relativePath,
        line_number: getLineNumberFromOffset(original, insertionPoint),
        position,
      };
    }

    if (anchorText === '') {
      throw new Error('insert_in_file requires anchor_text (or anchorText, anchor, search_text) unless position is start or end.');
    }

    const index = occurrence === 'last' ? original.lastIndexOf(anchorText) : original.indexOf(anchorText);
    if (index === -1) {
      throw new Error('insert_in_file could not find the anchor_text.');
    }

    const insertionPoint = position === 'before' ? index : index + anchorText.length;
    const nextContent = `${original.slice(0, insertionPoint)}${text}${original.slice(insertionPoint)}`;
    await writeFile(filePath, nextContent, 'utf8');
    return {
      ok: true,
      tool: 'insert_in_file',
      path: resolvedFile.relativePath,
      line_number: getLineNumberFromOffset(original, insertionPoint),
      position,
      occurrence,
    };
  }

  async deleteFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('delete_file requires a path.');
    }

    const resolvedFile = await resolveExistingWorkspaceFile(this.workspaceRoot, relativePath);
    const filePath = resolvedFile.absolutePath;
    const details = await stat(filePath);
    if (!details.isFile()) {
      throw new Error('delete_file only supports files.');
    }

    await rm(filePath, { force: false });
    return {
      ok: true,
      tool: 'delete_file',
      path: resolvedFile.relativePath,
      deleted: true,
    };
  }

  async createDirectory(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('create_directory requires a path.');
    }

    const directoryPath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    await mkdir(directoryPath, { recursive: input.recursive !== false });
    return {
      ok: true,
      tool: 'create_directory',
      path: relativePath,
      created: true,
    };
  }

  async moveFile(input = {}) {
    const sourcePath = String(input.source_path || input.source || '').trim();
    const destinationPath = String(input.destination_path || input.destination || '').trim();
    if (!sourcePath || !destinationPath) {
      throw new Error('move_file requires source_path and destination_path.');
    }

    const resolvedSourceFile = await resolveExistingWorkspaceFile(this.workspaceRoot, sourcePath);
    const sourceFilePath = resolvedSourceFile.absolutePath;
    const destinationFilePath = resolveWorkspacePath(this.workspaceRoot, destinationPath);
    await mkdir(dirname(destinationFilePath), { recursive: true });
    await rename(sourceFilePath, destinationFilePath);
    return {
      ok: true,
      tool: 'move_file',
      source_path: resolvedSourceFile.relativePath,
      destination_path: destinationPath,
    };
  }

  async copyFile(input = {}) {
    const sourcePath = String(input.source_path || input.source || '').trim();
    const destinationPath = String(input.destination_path || input.destination || '').trim();
    if (!sourcePath || !destinationPath) {
      throw new Error('copy_file requires source_path and destination_path.');
    }

    const resolvedSourceFile = await resolveExistingWorkspaceFile(this.workspaceRoot, sourcePath);
    const sourceFilePath = resolvedSourceFile.absolutePath;
    const destinationFilePath = resolveWorkspacePath(this.workspaceRoot, destinationPath);
    await mkdir(dirname(destinationFilePath), { recursive: true });
    await copyFile(sourceFilePath, destinationFilePath);
    return {
      ok: true,
      tool: 'copy_file',
      source_path: resolvedSourceFile.relativePath,
      destination_path: destinationPath,
    };
  }

  async pathExists(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('path_exists requires a path.');
    }

    const targetPath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const exists = await stat(targetPath).then(() => true).catch((error) => {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (exists === true) {
      return {
        ok: true,
        tool: 'path_exists',
        path: relativePath,
        exists: true,
      };
    }
    try {
      const resolvedFile = await resolveExistingWorkspaceFile(this.workspaceRoot, relativePath);
      return {
        ok: true,
        tool: 'path_exists',
        path: resolvedFile.relativePath,
        exists: true,
      };
    } catch (_error) {}
    return {
      ok: true,
      tool: 'path_exists',
      path: relativePath,
      exists: false,
    };
  }

  async statFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('stat_file requires a path.');
    }

    const resolvedFile = await resolveExistingWorkspaceFile(this.workspaceRoot, relativePath);
    const targetPath = resolvedFile.absolutePath;
    const details = await stat(targetPath);
    return {
      ok: true,
      tool: 'stat_file',
      path: resolvedFile.relativePath,
      name: basename(targetPath),
      is_file: details.isFile(),
      is_directory: details.isDirectory(),
      size: details.size,
      mtime_ms: details.mtimeMs,
      ctime_ms: details.ctimeMs,
    };
  }

  async readDirectory(input = {}) {
    const relativePath = String(input.path || '.').trim() || '.';
    const targetPath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const entries = await readdir(targetPath, { withFileTypes: true });
    return {
      ok: true,
      tool: 'read_directory',
      path: relativePath,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: relativePath === '.' ? entry.name : `${relativePath.replace(/\/$/, '')}/${entry.name}`,
        type: entry.isDirectory() ? 'directory' : (entry.isFile() ? 'file' : 'other'),
      })),
    };
  }

  async findFiles(input = {}) {
    const relativePath = String(input.path || '.').trim() || '.';
    const pattern = String(input.pattern || '').trim();
    const escapedPath = relativePath.replaceAll('"', '\\"');
    const command = pattern
      ? `rg --files "${escapedPath}" -g ${JSON.stringify(pattern)}`
      : `rg --files "${escapedPath}"`;
    const result = await runShellCommand(command, { cwd: this.workspaceRoot, timeoutMs: 10000 });
    return {
      ok: true,
      tool: 'find_files',
      path: relativePath,
      pattern,
      files: String(result.stdout || '').split(/\r?\n/).filter(Boolean),
    };
  }

  async readMultipleFiles(input = {}) {
    const paths = Array.isArray(input.paths) ? input.paths.map((value) => String(value || '').trim()).filter(Boolean) : [];
    if (!paths.length) {
      throw new Error('read_multiple_files requires at least one path.');
    }

    const files = await Promise.all(paths.map(async (relativePath) => {
      const filePath = resolveWorkspacePath(this.workspaceRoot, relativePath);
      const content = await readFile(filePath, 'utf8');
      return {
        path: relativePath,
        content,
      };
    }));
    return {
      ok: true,
      tool: 'read_multiple_files',
      files,
    };
  }

  async grepStructured(input = {}) {
    const query = String(input.query || '').trim();
    if (!query) {
      throw new Error('grep_structured requires a query.');
    }

    const relativePath = String(input.path || '.').trim() || '.';
    const escapedPath = relativePath.replaceAll('"', '\\"');
    const command = `rg -n --no-heading --color never ${JSON.stringify(query)} "${escapedPath}"`;
    const result = await runShellCommand(command, { cwd: this.workspaceRoot });
    const matches = String(result.stdout || '').split(/\r?\n/).filter(Boolean).map((line) => {
      const match = line.match(/^(.*?):(\d+):(.*)$/);
      if (!match) {
        return {
          path: '',
          line_number: 0,
          line_text: line,
        };
      }
      return {
        path: match[1],
        line_number: Number.parseInt(match[2], 10) || 0,
        line_text: match[3],
      };
    });
    return {
      ok: true,
      tool: 'grep_structured',
      query,
      matches,
    };
  }

  async runCommand(input = {}) {
    const command = String(input.command || '').trim();
    if (!command) {
      throw new Error('run_command requires a command.');
    }
    const result = await runShellCommand(command, { cwd: this.workspaceRoot });
    return {
      ok: true,
      tool: 'run_command',
      command,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async gitStatus() {
    const result = await runShellCommand('git status --short --branch', { cwd: this.workspaceRoot });
    return {
      ok: true,
      tool: 'git_status',
      output: result.stdout,
    };
  }

  async gitLog(input = {}) {
    const limit = Number.isInteger(input.limit) ? input.limit : 10;
    const author = String(input.author || '').trim();
    const options = String(input.options || '').trim();
    if (options && /[;&|`$<>]/.test(options)) {
      throw new Error('git_log options contain unsupported shell characters.');
    }
    const authorArg = author ? ` --author=${JSON.stringify(author)}` : '';
    const optionsArg = options ? ` ${options}` : '';
    const result = await runShellCommand(`git log -n ${Math.max(1, limit)} --oneline --decorate${authorArg}${optionsArg}`, { cwd: this.workspaceRoot });
    let remoteUrl = '';
    try {
      const remoteResult = await runShellCommand('git remote get-url origin', { cwd: this.workspaceRoot, timeoutMs: 5000 });
      remoteUrl = String(remoteResult.stdout || '').trim();
    } catch (_error) {}
    const linkedOutput = String(result.stdout || '').split(/\r?\n/).map((line) => {
      const match = String(line || '').match(/^([0-9a-f]{7,40})(\b.*)$/i);
      if (!match) {
        return line;
      }
      const sha = String(match[1] || '').trim();
      const remainder = String(match[2] || '');
      const commitUrl = buildCommitUrl(remoteUrl, sha);
      if (!commitUrl) {
        return line;
      }
      return `- [${sha}](${commitUrl})${remainder}`;
    }).join('\n');
    return {
      ok: true,
      tool: 'git_log',
      author,
      options: options || undefined,
      output: linkedOutput || result.stdout,
      remote_url: remoteUrl || undefined,
    };
  }

  async gitDiff(input = {}) {
    const revspec = String(input.revspec || input.revision || input.commit || '').trim();
    const nameOnly = input.name_only !== false;
    const stat = input.stat !== false;
    let command = 'git diff';
    let timeoutMs = 20000;

    if (revspec) {
      const formatFlags = [
        '--format=medium',
        nameOnly ? '--name-only' : '',
        stat ? '--stat' : '',
      ].filter(Boolean).join(' ');
      command = `git show ${formatFlags} ${JSON.stringify(revspec)}`;
      timeoutMs = 10000;
    }

    const result = await runShellCommand(command, { cwd: this.workspaceRoot, timeoutMs });
    return {
      ok: true,
      tool: 'git_diff',
      revspec,
      mode: revspec ? 'commit_show' : 'workspace_diff',
      output: result.stdout,
    };
  }

  async gitShow(input = {}) {
    const revspec = String(input.revspec || '').trim();
    if (!revspec) {
      throw new Error('git_show requires a revspec.');
    }
    const result = await runShellCommand(`git show ${revspec}`, { cwd: this.workspaceRoot });
    return {
      ok: true,
      tool: 'git_show',
      revspec,
      output: result.stdout,
    };
  }

  async gitAdd(input = {}) {
    const paths = Array.isArray(input.paths) ? input.paths.map((value) => String(value || '').trim()).filter(Boolean) : [];
    if (!paths.length) {
      throw new Error('git_add requires at least one path.');
    }
    const quotedPaths = paths.map((value) => JSON.stringify(value)).join(' ');
    const result = await runShellCommand(`git add -- ${quotedPaths}`, { cwd: this.workspaceRoot });
    return {
      ok: true,
      tool: 'git_add',
      paths,
      output: result.stdout,
    };
  }

  async gitCommit(input = {}) {
    const message = String(input.message || '').trim();
    if (!message) {
      throw new Error('git_commit requires a message.');
    }
    const result = await runShellCommand(`git commit -m ${JSON.stringify(message)}`, { cwd: this.workspaceRoot, timeoutMs: 30000 });
    return {
      ok: true,
      tool: 'git_commit',
      message,
      output: result.stdout,
      stderr: result.stderr,
    };
  }

  async gitCheckout(input = {}) {
    const revspec = String(input.revspec || '').trim();
    const paths = Array.isArray(input.paths) ? input.paths.map((value) => String(value || '').trim()).filter(Boolean) : [];
    if (!revspec && !paths.length) {
      throw new Error('git_checkout requires a revspec or at least one path.');
    }

    const pathArgs = paths.length ? ` -- ${paths.map((value) => JSON.stringify(value)).join(' ')}` : '';
    const command = revspec
      ? `git checkout ${JSON.stringify(revspec)}${pathArgs}`
      : `git checkout -- ${paths.map((value) => JSON.stringify(value)).join(' ')}`;
    const result = await runShellCommand(command, { cwd: this.workspaceRoot, timeoutMs: 30000 });
    return {
      ok: true,
      tool: 'git_checkout',
      revspec,
      paths,
      output: result.stdout,
      stderr: result.stderr,
    };
  }

  async applyPatch(input = {}) {
    const patch = String(input.patch || '').trim();
    if (!patch) {
      throw new Error('apply_patch requires a patch.');
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'codex-bridge-patch-'));
    const patchFile = join(tempDir, 'change.diff');

    try {
      await writeFile(patchFile, `${patch}\n`, 'utf8');
      const command = `patch -p0 --forward --reject-file=- < ${JSON.stringify(patchFile)}`;
      const result = await runShellCommand(command, {
        cwd: this.workspaceRoot,
        timeoutMs: 30000,
      });

      return {
        ok: true,
        tool: 'apply_patch',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
