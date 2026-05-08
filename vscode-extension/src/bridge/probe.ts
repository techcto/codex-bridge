import * as net from 'net';

import type { BridgeHealthResponse, BridgeProbeResult, RequestJsonOptions } from '../types';

export async function probeBridge(
  options: {
    getBaseUrl: () => string;
    getBaseUrlInfo: () => URL;
    getLocalBridgePort: () => string;
    getErrorMessage: (error: unknown) => string;
    requestJson: <T>(method: string, path: string, body?: unknown, options?: RequestJsonOptions) => Promise<T>;
  },
  timeoutMs = 1500
): Promise<BridgeProbeResult> {
  const url = options.getBaseUrlInfo();
  const host = url.hostname;
  const port = Number.parseInt(options.getLocalBridgePort(), 10);
  const socketReachable = await canConnectToPort(host, port, timeoutMs);

  if (!socketReachable) {
    return {
      baseUrl: options.getBaseUrl(),
      host,
      port,
      socketReachable,
      healthOk: false,
      healthError: `Nothing is listening on ${host}:${port}.`,
    };
  }

  try {
    const health = await options.requestJson<BridgeHealthResponse>('GET', '/health', undefined, { timeoutMs, suppressLog: true });
    return {
      baseUrl: options.getBaseUrl(),
      host,
      port,
      socketReachable,
      healthOk: health.ok === true,
      healthError: health.ok === true ? undefined : (health.error || 'Bridge responded but did not report healthy status.'),
    };
  } catch (error) {
    return {
      baseUrl: options.getBaseUrl(),
      host,
      port,
      socketReachable,
      healthOk: false,
      healthError: options.getErrorMessage(error),
    };
  }
}

export async function canConnectToPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

export function formatBridgeProbe(result: BridgeProbeResult): string {
  if (!result.socketReachable) {
    return `Configured bridge URL ${result.baseUrl} is not reachable because nothing is listening on ${result.host}:${result.port}.`;
  }

  if (result.healthOk) {
    return `Configured bridge URL ${result.baseUrl} is healthy.`;
  }

  return `Configured bridge URL ${result.baseUrl} accepts TCP connections, but /health did not succeed: ${result.healthError || 'Unknown bridge health failure.'}`;
}
