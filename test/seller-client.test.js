import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSellerClient} from '../seller-client.js';

let sequence = 0;
function client(fetchImpl, extra = {}) {
  return createSellerClient({token: 'test-token-' + ++sequence, fetchImpl,
    lookupImpl: async () => [{address: '8.8.8.8', family: 4}], sleepImpl: async () => {}, ...extra});
}
const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});

test('confines authenticated calls to Whatnot Seller API and keeps write bodies JSON', async () => {
  const calls = [], api = client(async (url, options) => {calls.push({url, options}); return json({id: 'one'});});
  assert.deepEqual(await api.request('POST', '/reports', {report_parameters: {report_type: 'seller_financial_report'}}), {id: 'one'});
  assert.equal(calls[0].url, 'https://api.whatnot.com/seller-api/rest/v2/reports');
  assert.match(calls[0].options.headers.Authorization, /^Bearer test-token-/);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {report_parameters: {report_type: 'seller_financial_report'}});
  for (const path of ['https://evil.com', '//evil.com', '/../outside', '/%2e%2e/outside', '/products/%252e%252e', '/products/abc%2fdef', '/products\\x', '/products#token']) {
    await assert.rejects(api.request('GET', path), error => error.status === 400);
  }
  assert.equal(calls.length, 1);
});

test('validates pages and carries opaque cursor safely', async () => {
  let called;
  const api = client(async url => {called = new URL(url); return json({data: [{id: 'a'}], next_cursor: 'next'});});
  assert.deepEqual(await api.page('/products?reverse=false', 'opaque+/?='), {data: [{id: 'a'}], next_cursor: 'next'});
  assert.equal(called.searchParams.get('limit'), '50');
  assert.equal(called.searchParams.get('cursor'), 'opaque+/?=');
  assert.equal(called.searchParams.get('reverse'), 'false');
  for (const payload of [null, {}, {data: {}}, {data: [], next_cursor: 9}]) {
    await assert.rejects(client(async () => json(payload)).page('/products'), /invalid page/);
  }
  assert.deepEqual(await client(async () => json({data: []})).page('/products'), {data: [], next_cursor: null});
});

test('retries a rate-limited GET after Retry-After but never retries a mutation', async () => {
  const waits = []; let calls = 0;
  const api = client(async () => ++calls === 1 ? new Response('secret upstream detail', {status: 429, headers: {'Retry-After': '2'}}) : json({ok: true}), {sleepImpl: async ms => waits.push(ms)});
  assert.deepEqual(await api.request('GET', '/users/me'), {ok: true});
  assert.equal(calls, 2); assert.ok(waits.includes(2000));
  calls = 0;
  const writes = client(async () => {calls++; return new Response('token should never escape', {status: 429, headers: {'Retry-After': '7'}});});
  await assert.rejects(writes.request('POST', '/shipments/one/generate_label'), error => error.status === 429 && error.retryAfter === 7 && !error.message.includes('token should'));
  assert.equal(calls, 1);
  await assert.rejects(client(async () => new Response('', {status: 429, headers: {'Retry-After': '120'}})).request('GET', '/products'), error => error.retryAfter === 120);
});

test('sanitizes denied, failed, timed-out, and malformed upstream responses', async () => {
  for (const status of [401, 403, 404, 409, 500]) {
    await assert.rejects(client(async () => new Response('leaked-secret', {status})).request('GET', '/users/me'), error =>
      error.provider === 'whatnot' && !error.message.includes('leaked-secret') && error.status === (status === 500 ? 502 : status));
  }
  await assert.rejects(client(async () => {throw new DOMException('token detail', 'TimeoutError');}).request('GET', '/users/me'), error => error.status === 504 && !error.message.includes('token detail'));
  await assert.rejects(client(async () => {throw Error('leaked-secret');}).request('POST', '/reports', {}), /Cannot reach Whatnot/);
  await assert.rejects(client(async () => new Response('not JSON')).request('GET', '/products'), /unreadable response/);
  assert.equal(await client(async () => new Response(null, {status: 204})).request('DELETE', '/products/a'), null);
});

test('shares request pacing between separate clients for the same token', async () => {
  const waits = [], token = 'shared-rate-test-' + ++sequence;
  const options = {token, fetchImpl: async () => json({}), sleepImpl: async ms => waits.push(ms)};
  const first = createSellerClient(options), second = createSellerClient(options);
  await Promise.all([first.request('GET', '/users/me'), second.request('GET', '/users/me'), first.request('GET', '/users/me')]);
  assert.equal(waits.length, 2); assert.ok(waits[0] > 0); assert.ok(waits[1] > waits[0]);
});

test('downloads reports without forwarding seller credentials or cookies, including redirects', async () => {
  const calls = [], api = client(async (url, options) => {
    calls.push({url, options});
    return calls.length === 1 ? new Response(null, {status: 302, headers: {Location: 'https://storage.example.com/final?signature=example'}}) : new Response('ledger_transaction_id\n123\n');
  });
  const result = await api.downloadReport('https://reports.example.com/report?signature=example');
  assert.ok(Buffer.isBuffer(result)); assert.match(result.toString(), /ledger_transaction_id/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'manual');
    assert.match(call.options.headers.Accept, /application\/pdf/);
  }
});

test('rejects private addresses and checks redirect destinations before making requests', async () => {
  let calls = 0;
  const api = client(async () => {calls++; return new Response('csv');});
  for (const url of ['http://reports.example.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://10.0.0.2/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://169.254.169.254/latest/meta-data', 'https://a:b@reports.example.com/a', 'https://reports.example.com:8443/a']) {
    await assert.rejects(api.downloadReport(url), /unsafe/);
  }
  assert.equal(calls, 0);
  const ipv6 = client(async () => {calls++; return new Response('csv');}, {lookupImpl: async () => [{address: '2001:0000:4136:e378:8000:63bf:3fff:fdd2'}]});
  await assert.rejects(ipv6.downloadReport('https://reports.example.com/a'), /unsafe/);
  assert.equal(calls, 0);
  const rebinding = client(async () => {calls++; return new Response('csv');}, {lookupImpl: async () => [{address: '8.8.8.8'}, {address: '192.168.0.1'}]});
  await assert.rejects(rebinding.downloadReport('https://reports.example.com/a'), /unsafe/);
  assert.equal(calls, 0);
  const redirected = client(async () => {calls++; return new Response(null, {status: 302, headers: {Location: 'https://127.0.0.1/secret'}});});
  await assert.rejects(redirected.downloadReport('https://reports.example.com/a'), /unsafe/);
  assert.equal(calls, 1);
});

test('enforces report size from both content-length and actual stream bytes', async () => {
  await assert.rejects(client(async () => new Response('csv', {headers: {'Content-Length': '9000000'}})).downloadReport('https://reports.example.com/a'), error => error.status === 413);
  const stream = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close();}});
  await assert.rejects(client(async () => new Response(stream)).downloadReport('https://reports.example.com/a'), error => error.status === 413);
  await assert.rejects(client(async () => new Response('')).downloadReport('https://reports.example.com/a'), /empty report/);
});

test('requires a server token and rejects unsupported requests without calling fetch', async () => {
  assert.throws(() => createSellerClient({token: ''}), /WHATNOT_API_TOKEN/);
  assert.throws(() => createSellerClient({token: 'has whitespace'}), /WHATNOT_API_TOKEN/);
  const api = client(async () => {throw Error('should not call');});
  await assert.rejects(api.request('PUT', '/products'), error => error.status === 400);
  await assert.rejects(api.request('GET', '/products', {}), error => error.status === 400);
});
