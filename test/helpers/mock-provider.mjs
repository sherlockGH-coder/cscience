import { createServer } from 'node:http';

export function createMockProvider(options = {}) {
  const state = {
    requests: [],
    handlers: options.handlers || {},
  };

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const record = {
      method: request.method,
      path: url.pathname,
      headers: redactIncomingHeaders(request.headers),
      body,
    };
    state.requests.push(record);

    const key = `${request.method} ${url.pathname}`;
    const handler =
      state.handlers[key] ||
      state.handlers[url.pathname] ||
      state.handlers['*'];

    if (!handler) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `no handler for ${key}` } }));
      return;
    }

    try {
      const result =
        typeof handler === 'function'
          ? await handler({ request, response, body, url, record })
          : handler;
      if (result === undefined || response.writableEnded) return;

      if (result.sse) {
        response.writeHead(result.status || 200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        for (const event of result.sse) {
          if (event.event) response.write(`event: ${event.event}\n`);
          response.write(`data: ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}\n\n`);
        }
        response.end();
        return;
      }

      response.writeHead(result.status || 200, {
        'content-type': result.contentType || 'application/json',
        ...(result.headers || {}),
      });
      if (result.raw != null) {
        response.end(result.raw);
      } else {
        response.end(JSON.stringify(result.body ?? {}));
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });

  return {
    state,
    setHandler(key, handler) {
      state.handlers[key] = handler;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      return {
        host: address.address,
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function redactIncomingHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'proxy-authorization'
    ) {
      output[lower] = '[redacted]';
    } else {
      output[lower] = Array.isArray(value) ? value.join(',') : String(value);
    }
  }
  return output;
}
