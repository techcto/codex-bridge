import * as vscode from 'vscode';
import type { RequestJsonOptions } from '../types';

export type BridgeHttpClientDeps = {
  getBaseUrl: () => string;
  outputChannel?: vscode.OutputChannel;
};

export class BridgeHttpClient {
  private readonly getBaseUrl: () => string;
  private readonly outputChannel?: vscode.OutputChannel;

  public constructor(deps: BridgeHttpClientDeps) {
    this.getBaseUrl = deps.getBaseUrl;
    this.outputChannel = deps.outputChannel;
  }

  public async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestJsonOptions
  ): Promise<T> {
    const url = `${this.getBaseUrl()}${path}`;
    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? 12000;
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const startedAt = Date.now();

    if (!options?.suppressLog) {
      const summary = body === undefined ? '' : ` body=${this.safeJsonStringify(this.sanitizeForLog(body)).slice(0, 400)}`;
      this.outputChannel?.appendLine(`[bridge] -> ${method} ${url}${summary}`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutHandle);
      const message = error instanceof Error ? error.message : 'Unknown fetch failure.';
      if (!options?.suppressLog) {
        this.outputChannel?.appendLine(`[bridge] request failed ${method} ${url}: ${message}`);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Timed out contacting Codex Bridge at ${url}.`);
      }
      throw new Error(`Unable to reach Codex Bridge at ${url}: ${message}`);
    }

    clearTimeout(timeoutHandle);

    const raw = await response.text();
    const elapsedMs = Date.now() - startedAt;
    let payload: T | Record<string, unknown> = {} as T;
    if (raw) {
      try {
        payload = JSON.parse(raw) as T;
      } catch (_error) {
        if (!options?.suppressLog) {
          this.outputChannel?.appendLine(`[bridge] non-JSON response from ${method} ${url}: ${raw.slice(0, 500)}`);
        }
        throw new Error(`Codex Bridge returned invalid JSON for ${method} ${path}.`);
      }
    }

    if (!response.ok) {
      const errorMessage = typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as Record<string, unknown>).error || 'Request failed.')
        : `Request failed with status ${response.status}.`;
      if (!options?.suppressLog) {
        this.outputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms): ${errorMessage}`);
      }
      throw new Error(errorMessage);
    }

    if (!options?.suppressLog) {
      this.outputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms)`);
    }

    return payload as T;
  }

  public async requestExternalJson<T>(
    method: string,
    url: string,
    body?: BodyInit | unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    const startedAt = Date.now();
    const logBody = body instanceof FormData ? '[form-data]' : this.sanitizeForLog(body);
    this.outputChannel?.appendLine(`[bridge] -> ${method} ${url}${body === undefined ? '' : ` body=${this.safeJsonStringify(logBody).slice(0, 300)}`}`);

    const requestHeaders = {
      'Accept': 'application/json',
      ...(headers || {}),
    } as Record<string, string>;

    let requestBody: BodyInit | undefined;
    if (body instanceof FormData) {
      requestBody = body;
    } else if (body !== undefined) {
      if (!requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json';
      }
      requestBody = JSON.stringify(body);
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody,
    });

    const raw = await response.text();
    const elapsedMs = Date.now() - startedAt;
    let payload: T | Record<string, unknown> = {} as T;
    if (raw) {
      try {
        payload = JSON.parse(raw) as T;
      } catch (_error) {
        this.outputChannel?.appendLine(`[bridge] non-JSON response from ${method} ${url}: ${raw.slice(0, 500)}`);
        throw new Error(`Received invalid JSON from ${url}.`);
      }
    }

    if (!response.ok) {
      const errorMessage = typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as Record<string, unknown>).error || `Request failed with status ${response.status}.`)
        : `Request failed with status ${response.status}.`;
      this.outputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms): ${errorMessage}`);
      throw new Error(errorMessage);
    }

    this.outputChannel?.appendLine(`[bridge] <- ${response.status} ${method} ${url} (${elapsedMs}ms)`);
    return payload as T;
  }

  private safeJsonStringify(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return '[unserializable response payload]';
    }
  }

  private sanitizeForLog(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeForLog(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (/(password|api[-_]?key|token|authorization|secret)/i.test(key)) {
        sanitized[key] = '[redacted]';
        continue;
      }

      sanitized[key] = this.sanitizeForLog(entry);
    }

    return sanitized;
  }
}
