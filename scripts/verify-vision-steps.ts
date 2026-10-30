/**
 * End-to-end verification of the 10-step vision upgrades:
 *   Step 3  — callsite capture → event + PR blast radius; /api/scan
 *   Step 4  — fleet (cross-endpoint) fingerprint immunity
 *   Step 9  — circuit breaker OPEN → ROLLED_BACK short-circuit
 *   Step 10 — PR body carries blast radius + suggested repair
 */
const BASE = 'http://localhost:3000';
const j = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const post = (path, body, headers = {}) =>
  fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(j);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

async function main() {
  console.log('— setup: two contracts with identical shape —');
  await fetch(BASE + '/api/reset', { method: 'POST' }).then(j);
  await fetch(BASE + '/api/contracts', { method: 'DELETE' }).then(() => undefined).catch(() => undefined);
  // clear contracts via wipe script semantics: delete each
  const list0 = await j(await fetch(BASE + '/api/contracts'));
  for (const c of list0.contracts) await fetch(`${BASE}/api/contracts?id=${c.id}`, { method: 'DELETE' });

  const A = await post('/api/contracts', {
    name: 'orders-api',
    endpoint: 'https://api.shop.dev/v2/orders',
    fields: { orderId: { type: 'string', mandatory: true }, total: { type: 'number', mandatory: true }, currency: { type: 'string' } },
  });
  const B = await post('/api/contracts', {
    name: 'analytics-api',
    endpoint: 'https://api.shop.dev/v2/analytics/summary',
    fields: { orderId: { type: 'string', mandatory: true }, total: { type: 'number', mandatory: true }, currency: { type: 'string' } },
  });
  ok('contracts created', !!A.id && !!B.id);

  console.log('— Step 2/5/7/8: cold heal with TYPE drift + callsite header —');
  const h1 = await post('/api/heal',
    { contractId: A.id, payload: { orderId: 'O-1', total: '499', currency: 'INR' }, allowLlm: false },
    { 'x-api-healer-callsite': 'services/checkout.ts:42' });
  ok('HEALED_COLD', h1.status === 'HEALED_COLD', h1.status);
  ok('COERCE op emitted', h1.plan?.ops?.[0]?.op === 'COERCE', JSON.stringify(h1.plan?.ops));
  ok('callsite echoed on result', h1.callsite === 'services/checkout.ts:42', String(h1.callsite));

  console.log('— Step 4: fleet immunity — same drift on a DIFFERENT contract —');
  const h2 = await post('/api/heal', { contractId: B.id, payload: { orderId: 'O-2', total: '299', currency: 'INR' }, allowLlm: false });
  ok('fleet → HEALED_CACHED (zero LLM, zero compose)', h2.status === 'HEALED_CACHED', h2.status + ' | ' + h2.message);
  ok('fleet message says sibling route', /fleet fingerprint hit/.test(h2.message ?? ''), h2.message);
  ok('borrowed plan still re-verified by gates', h2.gates?.passed === true);

  console.log('— Step 3: callsite persisted on the event —');
  const evs = await j(await fetch(BASE + '/api/events?limit=5'));
  const coldEv = (evs.events ?? []).find((e) => e.status === 'HEALED_COLD' && e.contractId === A.id);
  ok('event stores callsite', coldEv?.callsite === 'services/checkout.ts:42', JSON.stringify(coldEv?.callsite));

  console.log('— Step 10: PR carries blast radius + suggested repair —');
  // wait for the async PR worker
  let pr: any = null;
  for (let i = 0; i < 20 && !pr; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const prs = await j(await fetch(BASE + '/api/prs'));
    pr = (prs.prs ?? []).find((p) => p.contract?.name === 'orders-api' || p.title?.includes('orders-api'));
  }
  ok('PR artifact exists (DRY_RUN)', !!pr);
  if (pr) {
    const body = pr.body ?? '';
    ok('PR has Blast radius section', body.includes('Blast radius'), body.slice(0, 120));
    ok('PR lists the consumer callsite', body.includes('services/checkout.ts:42'));
    ok('PR has Suggested permanent repair', body.includes('Suggested permanent repair'));
    ok('repair suggests Number() coercion', body.includes('Number(payload.total)'), body.match(/### Suggested[\s\S]{0,400}/)?.[0] ?? '');
    ok('PR diff mentions blast radius', (pr.diffText ?? '').includes('Blast radius') || (pr.diffText ?? '').includes('no callsite'));
  }

  console.log('— Step 3: /api/scan (AST blast-radius locator) —');
  const fs = await import('fs');
  await fs.promises.mkdir('/home/z/my-project/.tmp-scan-e2e/svc', { recursive: true });
  await fs.promises.writeFile('/home/z/my-project/.tmp-scan-e2e/svc/orders.ts',
    `async function place(order) {\n  const r = await fetch('https://api.shop.dev/v2/orders', { method: 'POST' });\n  return r.json();\n}\n`, 'utf8');
  const scan = await post('/api/scan', { contractId: A.id, root: '/home/z/my-project/.tmp-scan-e2e' });
  ok('scan finds consumer', scan.report?.matches?.length === 1, JSON.stringify(scan.report ?? scan));
  if (scan.report?.matches?.[0]) {
    const m = scan.report.matches[0];
    ok('scan reports file:line + enclosing fn', m.file === 'svc/orders.ts' && m.line === 2 && m.enclosing === 'place', JSON.stringify(m));
  }
  await fs.promises.rm('/home/z/my-project/.tmp-scan-e2e', { recursive: true, force: true });

  console.log('— Step 9: circuit breaker — 3 refusals trip OPEN, 4th is short-circuited —');
  for (let i = 1; i <= 3; i++) {
    const r = await post('/api/heal', { contractId: A.id, payload: { total: 499, currency: 'INR' }, allowLlm: false });
    ok(`refusal ${i} (missing mandatory orderId)`, r.status === 'REFUSED', r.status + ' ' + (r.message ?? ''));
  }
  const m1 = await j(await fetch(BASE + '/api/metrics'));
  ok('breaker OPEN in metrics', m1.metrics?.breakers?.open === 1, JSON.stringify(m1.metrics?.breakers));
  const blocked = await post('/api/heal', { contractId: A.id, payload: { orderId: 'O-9', total: 499 }, allowLlm: false });
  ok('OPEN breaker short-circuits → ROLLED_BACK', blocked.status === 'ROLLED_BACK', blocked.status);
  ok('message announces circuit OPEN', /circuit OPEN/.test(blocked.message ?? ''), blocked.message);
  const m2 = await j(await fetch(BASE + '/api/metrics'));
  ok('breaker reason recorded', /missing|mandatory|abstained/i.test(m2.metrics?.breakers?.list?.[0]?.reason ?? ''), JSON.stringify(m2.metrics?.breakers?.list));

  console.log('— cleanup: wipe runtime state back to pristine —');
  await fetch(BASE + '/api/reset', { method: 'POST' }).then(j);
  const fin = await j(await fetch(BASE + '/api/metrics'));
  ok('breakers cleared after reset', (fin.metrics?.breakers?.list ?? []).length === 0, JSON.stringify(fin.metrics?.breakers));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
