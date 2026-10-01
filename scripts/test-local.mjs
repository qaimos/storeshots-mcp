#!/usr/bin/env node
/**
 * Local E2E test: starts `php -S` on the StoreShots project root (../../api.php), signs up a user,
 * then drives this MCP server over stdio exactly as Cursor/Claude would.
 * Usage (from packages/storeshots-mcp):  npm test
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(here, '..');
const ROOT = path.resolve(PKG, '../..');
const PORT = Number(process.env.PORT || 8772);
const API = `http://127.0.0.1:${PORT}/api.php`;
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-mcp-'));
// Test fixture config (fake test-mode Payment Links) so the real config.php is not used
const CFG = path.join(TMP, 'config.test.php');
await fs.writeFile(CFG, `<?php return ['currency' => 'usd', 'packs' => [
  'starter' => ['label' => '10 screenshot sets', 'credits' => 10, 'price_text' => '$3', 'amount' => 300, 'payment_link' => 'https://buy.stripe.com/test_fixtureStarter', 'payment_link_id' => 'plink_fixture_starter'],
  'pro' => ['label' => '20 screenshot sets', 'credits' => 20, 'price_text' => '$5', 'amount' => 500, 'payment_link' => '', 'payment_link_id' => ''],
]];`);
const env = {
  ...process.env,
  STORESHOTS_API_KEY: 'admin-' + crypto.randomBytes(12).toString('hex'),
  STRIPE_WEBHOOK_SECRET: 'whsec_test_' + crypto.randomBytes(16).toString('hex'),
  STORESHOTS_CONFIG: CFG,
  STORESHOTS_DATA_PATH: path.join(TMP, 'storeshots-data.json'),
  STORESHOTS_OUTPUT_DIR: path.join(TMP, 'outputs'),
};
const php = spawn('php', ['-d', 'upload_max_filesize=12M', '-d', 'post_max_size=64M', '-d', 'memory_limit=768M', '-S', `127.0.0.1:${PORT}`, '-t', ROOT], { env, stdio: 'ignore' });
process.on('exit', () => php.kill());
for (let i = 0; i < 50; i++) { try { if ((await fetch(`${API}?action=health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`); if (!cond) fails++; };

const signup = async (email) => (await (await fetch(`${API}?action=signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })).json()).apiKey;
const KEY = await signup('mcp-user@example.com');
ok('signup via API', KEY?.startsWith('ss_'));

async function connect(key) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(PKG, 'src/index.js')],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STORESHOTS_API_URL: API, ...(key ? { STORESHOTS_API_KEY: key } : {}), STORESHOTS_OUTPUT_DIR: path.join(TMP, 'dl') },
    stderr: 'pipe',
  });
  const c = new Client({ name: 'storeshots-test', version: '1.0.0' });
  await c.connect(transport);
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let data = null; try { data = JSON.parse(text); } catch {}
  return { isError: !!r.isError, text, data };
};

const c = await connect(KEY);
const tools = (await c.listTools()).tools.map((t) => t.name).sort();
ok('tools listed', ['buy_credits', 'generate_screenshots', 'get_balance', 'get_output', 'list_devices', 'list_styles'].every((t) => tools.includes(t)), tools.join(', '));

let r = await call(c, 'list_styles');
ok('list_styles', !r.isError && r.data.styles.length === 5, r.data?.styles.map((s) => s.id).join(', '));
r = await call(c, 'list_devices');
ok('list_devices', !r.isError && r.data.devices.length === 4, r.data?.targets.map((t) => `${t.id}=${t.size}`).join(', '));
r = await call(c, 'get_balance');
ok('get_balance (new key)', !r.isError && r.data.credits === 0 && r.data.free.remaining === 3 && r.data.packs.length === 2, `credits ${r.data?.credits}, free ${r.data?.free?.remaining}, packs ${r.data?.packs?.map((p) => p.id + '=' + p.price).join('/')}`);

const S = path.join(ROOT, 'server/samples');
const dl1 = path.join(TMP, 'free-job');
r = await call(c, 'generate_screenshots', {
  screenshots: [path.join(S, 'screen-1.png'), `http://127.0.0.1:${PORT}/server/samples/screen-2.png`],
  style: 'midnight', device: 'iphone', targets: ['ios-6.9', 'ios-6.5'], appName: 'MCP Test',
  headlines: ['Local file input', 'URL input'], captions: ['Read from disk', 'Fetched over HTTP'],
  download_to: dl1, download_format: 'both',
});
ok('generate (local path + URL, free tier)', !r.isError && r.data.watermark === true && r.data.billing === 'free', r.isError ? r.text : `job ${r.data.jobId}, ${r.data.targets.map((t) => t.id + ':' + t.files.length).join(' ')}`);
const JOB = r.data?.jobId;
const files1 = r.data?.downloaded?.files || [];
ok('auto-download zip + 4 PNGs', files1.length === 5 && files1.every((f) => f.bytes > 1000), files1.map((f) => path.relative(dl1, f.path)).join(', '));
ok('free usage decremented', r.data?.balance?.freeRemaining === 2);

r = await call(c, 'get_output', { job_id: JOB, format: 'zip' });
ok('get_output default dir (zip)', !r.isError && r.data.files.length === 1 && r.data.outputDir.startsWith(path.join(TMP, 'dl')), r.data?.files?.[0]?.path);
const zipHead = r.data ? (await fs.readFile(r.data.files[0].path)).subarray(0, 2).toString() : '';
ok('zip is a real zip', zipHead === 'PK');
r = await call(c, 'get_output', { job_id: JOB, format: 'png', output_dir: path.join(TMP, 'pngs') });
const pngHead = r.data ? (await fs.readFile(r.data.files[0].path)).subarray(1, 4).toString() : '';
ok('get_output png', !r.isError && r.data.files.length === 4 && pngHead === 'PNG');

r = await call(c, 'generate_screenshots', { screenshots: Array(6).fill(path.join(S, 'screen-1.png')) });
ok('6 screenshots rejected by schema', r.isError, r.text.slice(0, 90).replace(/\s+/g, ' '));
r = await call(c, 'generate_screenshots', { screenshots: ['/nope/missing.png'] });
ok('missing file → clear error', r.isError && /file not found/.test(r.text), r.text);
r = await call(c, 'buy_credits', { pack: 'starter' });
ok('buy_credits → Payment Link + client_reference_id + prefilled_email', !r.isError && r.data.checkoutUrl.startsWith('https://buy.stripe.com/test_fixtureStarter?client_reference_id=1&prefilled_email=mcp-user%40example.com'), r.isError ? r.text : r.data.checkoutUrl);
r = await call(c, 'buy_credits', { pack: 'pro' });
ok('buy_credits for a pack without a link → not configured', r.isError && /not configured/.test(r.text), r.text);

// simulate the Stripe webhook for this user (pack "starter" = 10 credits)
const uid = 1; // first user in the fresh test database
const payload = JSON.stringify({ id: 'evt_mcp', type: 'checkout.session.completed', data: { object: { id: 'cs_test_mcp', payment_status: 'paid', client_reference_id: String(uid), payment_link: 'plink_fixture_starter', amount_total: 300, currency: 'usd' } } });
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
const wh = await (await fetch(`${API}?action=stripe-webhook`, { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body: payload })).json();
ok('webhook credited 10', wh.credited === 10, JSON.stringify(wh));

r = await call(c, 'generate_screenshots', { screenshots: [path.join(S, 'screen-3.png')], style: 'mint', targets: ['android-phone'], headlines: ['Paid, no watermark'] });
ok('paid generate → no watermark, 9 credits left', !r.isError && r.data.watermark === false && r.data.billing === 'credit' && r.data.balance.credits === 9, r.isError ? r.text : `balance ${JSON.stringify(r.data.balance)}`);
await c.close();

// second user: exhaust free tier through MCP → 402 message
const KEY2 = await signup('mcp-free@example.com');
const c2 = await connect(KEY2);
for (let i = 1; i <= 3; i++) { r = await call(c2, 'generate_screenshots', { screenshots: [path.join(S, 'screen-4.png')], targets: ['ios-6.5'] }); ok(`user2 free #${i}`, !r.isError && r.data.watermark === true); }
r = await call(c2, 'generate_screenshots', { screenshots: [path.join(S, 'screen-4.png')], targets: ['ios-6.5'] });
ok('user2 4th → 402 surfaced as tool error', r.isError && /Free tier used up/.test(r.text), r.text.slice(0, 140));
r = await call(c2, 'get_output', { job_id: JOB });
ok('user2 cannot fetch user1 job', r.isError && /not found/i.test(r.text));
await c2.close();

const c3 = await connect(null);
r = await call(c3, 'list_styles');
ok('no API key → helpful error', r.isError && /STORESHOTS_API_KEY is not set/.test(r.text), r.text.slice(0, 120));
await c3.close();

console.log(fails ? `MCP CLIENT TEST: ${fails} FAILURE(S)` : 'MCP CLIENT TEST OK');
php.kill();
await fs.rm(TMP, { recursive: true, force: true }); // keep the disk clean
process.exit(fails ? 1 : 0);
