import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function signWebhookPayload(payloadString, secret) {
  const hmac = crypto
    .createHmac('sha256', String(secret))
    .update(String(payloadString))
    .digest('hex');
  return `sha256=${hmac}`;
}

export function verifyWebhookSignature(payloadString, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected = signWebhookPayload(payloadString, secret);
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function matchRoutePath(routePattern, actualPathname) {
  const normPattern = (routePattern || '/').replace(/\/+$/, '') || '/';
  const normActual = (actualPathname || '/').replace(/\/+$/, '') || '/';
  if (normPattern === '*' || normPattern === normActual) {
    return { matched: true, params: {} };
  }
  const patSegs = normPattern.split('/').filter(Boolean);
  const actSegs = normActual.split('/').filter(Boolean);
  if (patSegs.length !== actSegs.length) {
    return { matched: false, params: {} };
  }
  const params = {};
  for (let i = 0; i < patSegs.length; i += 1) {
    const p = patSegs[i];
    const a = actSegs[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return { matched: false, params: {} };
    }
  }
  return { matched: true, params };
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

function readRequestBody(req, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBodyBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (tooLarge) {
        resolve({ tooLarge: true, raw: '', json: null });
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({ tooLarge: false, raw: '', json: null });
        return;
      }
      try {
        resolve({ tooLarge: false, raw, json: JSON.parse(raw) });
      } catch {
        resolve({ tooLarge: false, raw, json: null });
      }
    });
    req.on('error', reject);
  });
}

/**
 * Creates a zero-dependency Digital Twin Universe (DTU) behavioral HTTP mock & replay server.
 *
 * @param {object} [options]
 * @param {Array<object>} [options.routes=[]]
 * @param {object} [options.initialState={}]
 * @param {number} [options.maxBodyBytes=10485760]
 */
export function createTwinServer({
  routes = [],
  initialState = {},
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const recordedRequests = [];
  let state = structuredClone(initialState);

  const sendJson = (res, statusCode, payload, extraHeaders = {}) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(statusCode, {
      'content-type':
        typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
      ...extraHeaders,
    });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    if (method === 'GET' && pathname === '/__twin/health') {
      sendJson(res, 200, { ok: true, requestsCount: recordedRequests.length });
      return;
    }

    if (method === 'GET' && pathname === '/__twin/requests') {
      sendJson(res, 200, { requests: recordedRequests });
      return;
    }

    if (method === 'POST' && pathname === '/__twin/reset') {
      recordedRequests.length = 0;
      state = structuredClone(initialState);
      sendJson(res, 200, { ok: true, requestsCount: 0 });
      return;
    }

    let bodyData;
    try {
      bodyData = await readRequestBody(req, maxBodyBytes);
    } catch (readErr) {
      sendJson(res, 400, { error: readErr.message });
      return;
    }

    if (bodyData.tooLarge) {
      sendJson(res, 413, {
        error: 'Payload Too Large',
        maxBodyBytes,
      });
      return;
    }

    const { raw, json } = bodyData;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const reqRecord = {
      method,
      path: pathname,
      query,
      headers: req.headers,
      body: json ?? raw,
      rawBody: raw,
      timestamp: new Date().toISOString(),
    };
    recordedRequests.push(reqRecord);

    for (const route of routes) {
      const routeMethod = (route.method || 'GET').toUpperCase();
      if (routeMethod !== '*' && routeMethod !== method) {
        continue;
      }
      const { matched, params } = matchRoutePath(route.path || '/', pathname);
      if (!matched) {
        continue;
      }

      if (typeof route.handler === 'function') {
        try {
          const result = await route.handler(
            { ...reqRecord, params },
            state
          );
          const status = result?.status ?? route.status ?? 200;
          const headers = { ...(route.headers || {}), ...(result?.headers || {}) };
          const body = result?.body !== undefined ? result.body : (result ?? { ok: true });
          sendJson(res, status, body, headers);
        } catch (handlerErr) {
          sendJson(res, 500, { error: handlerErr.message || 'Twin route handler failed' });
        }
        return;
      }

      const status = route.status ?? 200;
      const headers = route.headers || {};
      const body =
        route.response !== undefined
          ? route.response
          : { ok: true, matched: route.path, params };
      sendJson(res, status, body, headers);
      return;
    }

    sendJson(res, 404, {
      error: 'No Digital Twin route matched request',
      method,
      path: pathname,
    });
  });

  return {
    server,
    getRequests: () => [...recordedRequests],
    getState: () => state,
    reset: () => {
      recordedRequests.length = 0;
      state = structuredClone(initialState);
    },
    listen: (port = 0, host = '127.0.0.1') => {
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return Promise.reject(
          new RangeError(
            `Invalid port "${port}". Expected an integer between 0 and 65535.`
          )
        );
      }
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          const url = `http://${host}:${actualPort}`;
          resolve({
            url,
            port: actualPort,
            getRequests: () => [...recordedRequests],
            getState: () => state,
            reset: () => {
              recordedRequests.length = 0;
              state = structuredClone(initialState);
            },
            close: () =>
              new Promise((resClose, rejClose) =>
                server.close((err) => (err ? rejClose(err) : resClose()))
              ),
          });
        });
      });
    },
  };
}

export function loadTwinRoutesFromFile(routesFilePath) {
  const absPath = path.resolve(routesFilePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Twin routes file not found: ${absPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  const routes = Array.isArray(parsed) ? parsed : Array.isArray(parsed.routes) ? parsed.routes : null;
  if (!routes) {
    throw new Error(`Invalid twin routes file "${absPath}": expected JSON array or { "routes": [...] }.`);
  }
  return routes;
}
