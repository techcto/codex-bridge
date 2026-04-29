import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export class AppServerClient extends EventEmitter {
  constructor({ cwd, env = {}, clientInfo, codexCommand = 'codex' }) {
    super();
    this.cwd = cwd;
    this.env = env;
    this.clientInfo = clientInfo;
    this.codexCommand = codexCommand;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.initialized = false;
    this.stopping = false;
  }

  async start() {
    if (this.initialized) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.#startInternal();
    await this.startPromise;
    this.startPromise = null;
  }

  async request(method, params = null) {
    await this.start();
    return this.#sendRequest(method, params);
  }

  async #sendRequest(method, params = null) {
    const id = this.nextId++;
    const payload = { id, method };
    if (params !== null && params !== undefined) {
      payload.params = params;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async stop() {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.stopping = true;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.off('exit', handleExit);
        resolve();
      };
      const handleExit = () => {
        finish();
      };

      this.once('exit', handleExit);

      try {
        child.kill('SIGTERM');
      } catch (error) {
        finish();
        return;
      }

      setTimeout(finish, 5000);
    });
  }

  async #startInternal() {
    this.stopping = false;
    this.child = spawn(this.codexCommand, ['app-server'], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      lines.map((line) => line.trim()).filter(Boolean).forEach((line) => this.#handleLine(line));
    });

    this.child.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk.toString());
    });

    this.child.on('error', (error) => {
      this.#reset(new Error(`Codex App Server error: ${error.message}`));
    });

    this.child.on('exit', (code, signal) => {
      const details = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      this.#reset(new Error(`Codex App Server exited with ${details}`));
    });

    await this.#sendRequest('initialize', {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });

    this.initialized = true;
  }

  #handleLine(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      this.emit('warning', `Invalid JSON from App Server: ${line}`);
      return;
    }

    if (payload && typeof payload === 'object' && payload.id !== undefined && payload.method) {
      this.#handleServerRequest(payload);
      return;
    }

    if (payload && typeof payload === 'object' && payload.id !== undefined) {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message || 'App Server request failed.'));
      } else {
        pending.resolve(payload.result ?? null);
      }
      return;
    }

    if (payload && typeof payload === 'object' && payload.method) {
      this.emit('notification', {
        method: payload.method,
        params: payload.params ?? {},
      });
    }
  }

  #handleServerRequest(payload) {
    const response = {
      id: payload.id,
      error: {
        code: -32000,
        message: `Unsupported App Server request: ${payload.method}`,
      },
    };

    try {
      this.child.stdin.write(`${JSON.stringify(response)}\n`);
    } catch (error) {}

    this.emit('serverRequest', payload);
  }

  #reset(error) {
    const expectedStop = this.stopping;
    this.stopping = false;
    this.initialized = false;
    this.startPromise = null;
    this.child = null;

    if (error) {
      this.pending.forEach(({ reject }) => reject(error));
    } else {
      this.pending.forEach(({ resolve }) => resolve(null));
    }
    this.pending.clear();

    this.emit('exit', expectedStop ? null : error);
  }
}
