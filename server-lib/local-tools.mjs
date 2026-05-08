import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
    description: 'Insert text before or after an anchor string in a workspace file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        anchor_text: { type: 'string' },
        text: { type: 'string' },
        position: { type: 'string', enum: ['before', 'after'] },
        occurrence: { type: 'string', enum: ['first', 'last'] },
      },
      required: ['path', 'anchor_text', 'text'],
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
        source_path: { type: 'string' },
        destination_path: { type: 'string' },
      },
      required: ['source_path', 'destination_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'copy_file',
    description: 'Copy a file in the workspace.',
    input_schema: {
      type: 'object',
      properties: {
        source_path: { type: 'string' },
        destination_path: { type: 'string' },
      },
      required: ['source_path', 'destination_path'],
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
    const escapedPath = relativePath.replaceAll('"', '\\"');
    const commands = [
      pattern
        ? `rg --files "${escapedPath}" | rg ${JSON.stringify(pattern)}`
        : `rg --files "${escapedPath}"`,
      pattern
        ? `find "${escapedPath}" -type f | grep ${JSON.stringify(pattern)}`
        : `find "${escapedPath}" -type f`,
    ];

    let lastError = null;
    let result = null;
    for (const command of commands) {
      try {
        result = await runShellCommand(command, { cwd: this.workspaceRoot, timeoutMs: 10000 });
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!result) {
      throw (lastError || new Error('Unable to list files in the workspace.'));
    }

    return {
      ok: true,
      tool: 'list_files',
      root: this.workspaceRoot,
      output: result.stdout,
    };
  }

  async readFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('read_file requires a path.');
    }
    const filePath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const content = await readFile(filePath, 'utf8');
    return {
      ok: true,
      tool: 'read_file',
      path: relativePath,
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
      bytes_written: Buffer.byteLength(content, 'utf8'),
    };
  }

  async appendFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('append_file requires a path.');
    }

    const filePath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const existing = await readFile(filePath, 'utf8').catch((error) => {
      if (error?.code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    const content = String(input.content || '');
    const nextContent = `${existing}${content}`;
    await writeFile(filePath, nextContent, 'utf8');
    return {
      ok: true,
      tool: 'append_file',
      path: relativePath,
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

    const filePath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const original = await readFile(filePath, 'utf8');
    if (!original.includes(oldText)) {
      throw new Error('replace_in_file could not find the target text.');
    }

    const nextContent = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    await writeFile(filePath, nextContent, 'utf8');

    const replacementCount = replaceAll
      ? original.split(oldText).length - 1
      : 1;

    return {
      ok: true,
      tool: 'replace_in_file',
      path: relativePath,
      replacements: replacementCount,
    };
  }

  async insertInFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    const anchorText = String(input.anchor_text || '');
    const text = String(input.text || '');
    const position = String(input.position || 'after').trim().toLowerCase() === 'before' ? 'before' : 'after';
    const occurrence = String(input.occurrence || 'first').trim().toLowerCase() === 'last' ? 'last' : 'first';

    if (!relativePath) {
      throw new Error('insert_in_file requires a path.');
    }
    if (anchorText === '') {
      throw new Error('insert_in_file requires anchor_text.');
    }

    const filePath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const original = await readFile(filePath, 'utf8');
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
      path: relativePath,
      position,
      occurrence,
    };
  }

  async deleteFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('delete_file requires a path.');
    }

    const filePath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const details = await stat(filePath);
    if (!details.isFile()) {
      throw new Error('delete_file only supports files.');
    }

    await rm(filePath, { force: false });
    return {
      ok: true,
      tool: 'delete_file',
      path: relativePath,
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
    const sourcePath = String(input.source_path || '').trim();
    const destinationPath = String(input.destination_path || '').trim();
    if (!sourcePath || !destinationPath) {
      throw new Error('move_file requires source_path and destination_path.');
    }

    const sourceFilePath = resolveWorkspacePath(this.workspaceRoot, sourcePath);
    const destinationFilePath = resolveWorkspacePath(this.workspaceRoot, destinationPath);
    await mkdir(dirname(destinationFilePath), { recursive: true });
    await rename(sourceFilePath, destinationFilePath);
    return {
      ok: true,
      tool: 'move_file',
      source_path: sourcePath,
      destination_path: destinationPath,
    };
  }

  async copyFile(input = {}) {
    const sourcePath = String(input.source_path || '').trim();
    const destinationPath = String(input.destination_path || '').trim();
    if (!sourcePath || !destinationPath) {
      throw new Error('copy_file requires source_path and destination_path.');
    }

    const sourceFilePath = resolveWorkspacePath(this.workspaceRoot, sourcePath);
    const destinationFilePath = resolveWorkspacePath(this.workspaceRoot, destinationPath);
    await mkdir(dirname(destinationFilePath), { recursive: true });
    await copyFile(sourceFilePath, destinationFilePath);
    return {
      ok: true,
      tool: 'copy_file',
      source_path: sourcePath,
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
        return false;
      }
      throw error;
    });
    return {
      ok: true,
      tool: 'path_exists',
      path: relativePath,
      exists,
    };
  }

  async statFile(input = {}) {
    const relativePath = String(input.path || '').trim();
    if (!relativePath) {
      throw new Error('stat_file requires a path.');
    }

    const targetPath = resolveWorkspacePath(this.workspaceRoot, relativePath);
    const details = await stat(targetPath);
    return {
      ok: true,
      tool: 'stat_file',
      path: relativePath,
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
    const result = await runShellCommand(`git log -n ${Math.max(1, limit)} --oneline --decorate`, { cwd: this.workspaceRoot });
    return {
      ok: true,
      tool: 'git_log',
      output: result.stdout,
    };
  }

  async gitDiff(input = {}) {
    const revspec = String(input.revspec || '').trim();
    const command = revspec ? `git diff ${revspec}` : 'git diff';
    const result = await runShellCommand(command, { cwd: this.workspaceRoot });
    return {
      ok: true,
      tool: 'git_diff',
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
