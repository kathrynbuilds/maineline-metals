// Shared HTTP layer: throttling + retry with backoff. Every network client in
// the repo goes through createHttp so tests can inject fetchImpl/sleep and
// production code gets consistent rate-limit behavior.

export function createHttp({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  minIntervalMs = 0,
  retries = 3,
  rateLimitWaitMs = 30_000,
  userAgent = 'genesis-tms/0.1 (carrier capacity system)',
} = {}) {
  let lastRequestAt = 0;
  let chain = Promise.resolve(); // serializes throttled requests

  async function throttled(fn) {
    const run = chain.then(async () => {
      if (minIntervalMs > 0) {
        const wait = lastRequestAt + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
      }
      lastRequestAt = Date.now();
      return fn();
    });
    // keep the chain alive even when a request fails
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function request(url, options = {}) {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await throttled(() =>
          fetchImpl(url, {
            ...options,
            headers: { 'User-Agent': userAgent, ...options.headers },
          })
        );
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(2000 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers?.get?.('Retry-After'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : rateLimitWaitMs
        );
        attempt += 1;
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(2000 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return res;
    }
  }

  async function requestJson(url, options = {}) {
    const res = await request(url, options);
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = body ? JSON.stringify(body).slice(0, 500) : text.slice(0, 500);
      const err = new Error(`HTTP ${res.status} from ${url}: ${detail}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  return { request, requestJson };
}
