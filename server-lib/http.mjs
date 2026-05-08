export function buildCorsHeaders(request) {
  const origin = request.headers.origin || '*';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, OpenAI-Beta, Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function sendJson(request, response, payload, statusCode = 200) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...buildCorsHeaders(request),
  });
  response.end(JSON.stringify(payload));
}

export function sendSseHeaders(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    ...buildCorsHeaders(request),
  });
}

export function writeSse(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sendHtml(request, response, html, statusCode = 200, options = {}) {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  if (options.allowFrame) {
    const defaultAncestors = `'self'`;
    const parentOrigin = String(options.parentOrigin || '').trim();
    const frameAncestors = parentOrigin
      ? `${defaultAncestors} ${parentOrigin}`
      : defaultAncestors;
    headers['Content-Security-Policy'] = `frame-ancestors ${frameAncestors};`;
  } else {
    headers['X-Frame-Options'] = 'SAMEORIGIN';
  }

  response.writeHead(statusCode, {
    ...headers,
    ...buildCorsHeaders(request),
  });
  response.end(html);
}

export function sendEmpty(response, statusCode = 204) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
  });
  response.end();
}

export function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function stripAnsi(value) {
  return String(value || '').replaceAll(/\u001b\[[0-9;]*m/g, '');
}
