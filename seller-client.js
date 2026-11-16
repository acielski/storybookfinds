import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

const BASE = 'https://api.whatnot.com/seller-api/rest/v2';
const API_PATH = '/seller-api/rest/v2/';
const REQUEST_TIMEOUT = 15_000;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const INTERVAL_MS = 125; // Eight requests/second, shared by clients using the same token.
const slots = new Map();

function failure(message, status = 502, extra = {}) {
  return Object.assign(new Error(message), {status, provider: 'whatnot', ...extra});
}

function apiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path)) {
    throw failure('Invalid Whatnot API resource path.', 400);
  }
  // Check decoded segments too: URL normalization and upstream decoding must never
  // turn a resource into an escape from the Seller API prefix.
  for (const segment of path.split('?')[0].split('/')) {
    let decoded = segment;
    try {
      for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(decoded); i++) decoded = decodeURIComponent(decoded);
    } catch {
      throw failure('Invalid Whatnot API resource path.', 400);
    }
    if (decoded === '.' || decoded === '..' || /[/\\\s#?]/.test(decoded)) {
      throw failure('Invalid Whatnot API resource path.', 400);
    }
  }
  const url = new URL(BASE + path);
  if (url.origin !== 'https://api.whatnot.com' || !url.pathname.startsWith(API_PATH)) {
    throw failure('Invalid Whatnot API resource path.', 400);
  }
  return url;
}

async function pace(key, sleep) {
  const now = Date.now();
  const next = Math.max(now, slots.get(key) || 0);
  slots.set(key, next + INTERVAL_MS);
  // Keep an idle server's limiter bounded without evicting active reservations.
  if (slots.size > 1000) for (const [entry, until] of slots) if (until < now) slots.delete(entry);
  if (next > now) await sleep(next - now);
}

function retrySeconds(value) {
  if (!value) return 1;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 1;
}

function responseFailure(response) {
  switch (response.status) {
    case 401: return failure('Whatnot rejected the API token. Update WHATNOT_API_TOKEN in Vercel and redeploy.', 401);
    case 403: return failure('Whatnot denied this action. Check the token permissions, seller verification, and customer-data access.', 403);
    case 404: return failure('This Whatnot resource is no longer available.', 404);
    case 409: return failure('Whatnot cannot perform this action with the current shipment or resource settings. Review it in Seller Hub.', 409);
    case 429: return failure('Whatnot is busy. Wait before trying again.', 429, {retryAfter: retrySeconds(response.headers.get('retry-after'))});
    default: return failure('Whatnot could not complete this request. Please try again later.', 502, {providerStatus: response.status});
  }
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Only global unicast, excluding documentation and IPv4 transition ranges.
    // This rejects mapped IPv4, loopback, link-local, multicast and unique-local.
    const parts = address.split(':');
    const first = parseInt(parts[0] || '0', 16), second = parseInt(parts[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff &&
      !(first === 0x2001 && [0, 0x10, 0xdb8].includes(second)) && first !== 0x2002;
  }
  return false;
}

async function downloadUrl(value, lookupImpl, signal) {
  let url;
  try { url = new URL(value); } catch { throw failure('Whatnot returned an invalid report download link.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !hostname || hostname === 'localhost' ||
      /\.(?:localhost|local|internal)$/.test(hostname)) {
    throw failure('Whatnot returned an unsafe report download link.');
  }
  let addresses;
  try {
    if (isIP(hostname)) addresses = [{address: hostname}];
    else {
      addresses = await new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Timed out', 'AbortError'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, {once: true});
        Promise.resolve(lookupImpl(hostname, {all: true, verbatim: true})).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    }
  } catch { throw failure('The Whatnot report download host could not be reached.'); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !publicAddress(item.address))) {
    throw failure('Whatnot returned an unsafe report download link.');
  }
  return url;
}

/** Seller requests stay server-side. Never pass this client or its token to React. */
export function createSellerClient({token, fetchImpl = fetch, lookupImpl = lookup, sleepImpl = delay} = {}) {
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token) || token.length > 4096) {
    throw failure('Add WHATNOT_API_TOKEN to the server environment to connect your shop.', 503);
  }
  const key = createHash('sha256').update(token).digest('hex');

  async function request(method, path, body) {
    const verb = String(method).toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'].includes(verb)) throw failure('Unsupported Whatnot request method.', 400);
    if ((verb === 'GET' || verb === 'HEAD') && body !== undefined) throw failure('Read requests cannot contain a body.', 400);
    const url = apiUrl(path);
    for (let attempt = 0; ; attempt++) {
      await pace(key, sleepImpl);
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: verb,
          headers: {Authorization: 'Bearer ' + token, Accept: 'application/json', ...(body !== undefined ? {'Content-Type': 'application/json'} : {})},
          ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT), redirect: 'error', credentials: 'omit',
        });
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw failure('Whatnot took too long to respond. Check sync status before retrying a write.', 504);
        throw failure('Cannot reach Whatnot. Check sync status before retrying a write.');
      }
      if (!response.ok) {
        const error = responseFailure(response);
        await response.body?.cancel().catch(() => {});
        if (verb === 'GET' && error.status === 429 && attempt < 2) {
          const wait = Math.max(error.retryAfter * 1000, 250 * 2 ** attempt);
          // Longer waits belong to the next durable sync request, not this function.
          if (wait <= 3000) { await sleepImpl(wait); continue; }
        }
        throw error;
      }
      if (response.status === 204 || verb === 'HEAD') return null;
      try { return await response.json(); }
      catch { throw failure('Whatnot returned an unreadable response. Please try again later.'); }
    }
  }

  async function page(path, cursor = null) {
    const url = apiUrl(path);
    url.searchParams.set('limit', '50');
    if (cursor !== null && cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 2048) throw failure('Invalid Whatnot pagination cursor.', 400);
      url.searchParams.set('cursor', cursor);
    }
    const result = await request('GET', url.href.slice(BASE.length));
    if (!result || !Array.isArray(result.data) ||
        (result.next_cursor != null && (typeof result.next_cursor !== 'string' || result.next_cursor.length > 2048))) {
      throw failure('Whatnot returned an invalid page. Sync was not advanced.');
    }
    return {data: result.data, next_cursor: result.next_cursor || null};
  }

  async function downloadReport(value) {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT);
    let current = value;
    for (let redirects = 0; redirects <= 3; redirects++) {
      const url = await downloadUrl(current, lookupImpl, signal);
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: 'GET', headers: {Accept: 'text/csv, application/pdf, application/octet-stream, text/plain'},
          signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        });
      } catch { throw failure('The Whatnot report download failed. Request a fresh report link and try again.'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || redirects === 3) throw failure('The Whatnot report download redirected too many times.');
        try { current = new URL(location, url).href; }
        catch { throw failure('Whatnot returned an invalid report download link.'); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure('The Whatnot report download is unavailable. Request a fresh report link and try again.');
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REPORT_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw failure('The Whatnot report is larger than 8 MB. Sync a shorter date range.', 413);
      }
      if (!response.body) throw failure('Whatnot returned an empty report download.');
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      try {
        for (;;) {
          const {done, value: bytes} = await reader.read();
          if (done) break;
          length += bytes.byteLength;
          if (length > MAX_REPORT_BYTES) {
            await reader.cancel();
            throw failure('The Whatnot report is larger than 8 MB. Sync a shorter date range.', 413);
          }
          chunks.push(Buffer.from(bytes));
        }
      } catch (error) {
        if (error?.provider === 'whatnot') throw error;
        throw failure('The Whatnot report download was interrupted. Try again with a fresh link.');
      } finally { reader.releaseLock(); }
      if (!length) throw failure('Whatnot returned an empty report download.');
      return Buffer.concat(chunks, length);
    }
  }
  return {request, page, downloadReport};
}
