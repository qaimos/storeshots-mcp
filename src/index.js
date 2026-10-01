#!/usr/bin/env node
/**
 * StoreShots MCP (thin client). Turns raw app screenshots into App Store / Google Play
 * marketing screenshots by calling the hosted StoreShots API — no Chrome, no local renderer.
 *
 * Env:
 *   STORESHOTS_API_KEY   your key (free: https://storeshots.qaimos.co.uk/account.html)
 *   STORESHOTS_API_URL   default https://storeshots.qaimos.co.uk/api.php
 *   STORESHOTS_OUTPUT_DIR default download folder (default ~/StoreShots)
 * Logs go to stderr only; stdout is the MCP stdio transport.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.1.2';
const API_URL = (process.env.STORESHOTS_API_URL || 'https://storeshots.qaimos.co.uk/api.php').trim();
const API_KEY = (process.env.STORESHOTS_API_KEY || '').trim();
const OUTPUT_DIR = expandHome(process.env.STORESHOTS_OUTPUT_DIR || path.join(os.homedir(), 'StoreShots'));
const SIGNUP_URL = new URL('account.html', API_URL).href;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.STORESHOTS_TIMEOUT_MS || 300000);

export const STYLES = ['glow', 'midnight', 'sunset', 'mint', 'trailing'];
export const DEVICES = ['iphone', 'iphone-duo', 'android', 'ipad'];
export const TARGETS = ['ios-6.9', 'ios-6.5', 'android-phone', 'ipad-13'];

function expandHome(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
function apiUrl(action, query = {}) {
  const u = new URL(API_URL);
  u.searchParams.set('action', action);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u;
}

class ApiError extends Error {}
async function call(action, { method = 'GET', body, query, auth = true, raw = false } = {}) {
  if (auth && !API_KEY) throw new ApiError(`STORESHOTS_API_KEY is not set. Get a free key at ${SIGNUP_URL} and add it to the MCP server env.`);
  const headers = { 'User-Agent': `storeshots-api-mcp/${VERSION}` };
  if (auth) headers['X-API-Key'] = API_KEY;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(apiUrl(action, query), { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ApiError(`Cannot reach StoreShots API at ${API_URL}: ${e.cause?.message || e.message}`);
  }
  if (raw && res.ok) return res;
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    let msg = data?.error || `HTTP ${res.status}: ${text.slice(0, 200)}`;
    if (res.status === 402) msg += ` Check get_balance, then buy credits with buy_credits or at ${SIGNUP_URL}.`;
    if (res.status === 401) msg += ` (key starts with "${API_KEY.slice(0, 6)}…"; get one at ${SIGNUP_URL})`;
    throw new ApiError(msg);
  }
  if (data === null) throw new ApiError(`Unexpected non-JSON response from ${API_URL}`);
  return data;
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
/** Load a screenshot from a local path, file:// URL or http(s) URL. */
async function loadImage(src, i) {
  src = String(src).trim();
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(60000) }).catch((e) => { throw new ApiError(`screenshots[${i}]: download failed (${e.message})`); });
    if (!r.ok) throw new ApiError(`screenshots[${i}]: ${src} returned HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new ApiError(`screenshots[${i}]: larger than 10 MB`);
    const type = (r.headers.get('content-type') || '').split(';')[0] || 'image/png';
    const name = path.basename(new URL(src).pathname) || `screenshot-${i + 1}.png`;
    return { buf, type, name };
  }
  const p = src.startsWith('file://') ? fileURLToPath(src) : path.resolve(expandHome(src));
  const st = await fs.stat(p).catch(() => { throw new ApiError(`screenshots[${i}]: file not found: ${p}`); });
  if (!st.isFile()) throw new ApiError(`screenshots[${i}]: not a file: ${p}`);
  if (st.size > MAX_FILE_BYTES) throw new ApiError(`screenshots[${i}]: ${p} is larger than 10 MB`);
  return { buf: await fs.readFile(p), type: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', name: path.basename(p) };
}

function safeRel(rel) { // manifest paths like "ios-6.5/01-app.png" → no traversal
  const parts = String(rel).split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..').map((s) => s.replace(/[^\w.\- ]+/g, '_'));
  if (!parts.length) throw new ApiError(`Bad file path in manifest: ${rel}`);
  return path.join(...parts);
}
async function download(action, query, dest) {
  const res = await call(action, { query, raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return { path: dest, bytes: buf.length };
}
/** Download a job's ZIP and/or PNGs into dir. */
async function fetchOutput(jobId, dir, format) {
  const m = await call('job', { query: { id: jobId } });
  const outDir = path.resolve(expandHome(dir || path.join(OUTPUT_DIR, jobId)));
  const saved = [];
  if (format === 'zip' || format === 'both') {
    if (!m.zip) throw new ApiError('This job has no ZIP.');
    saved.push(await download('zip', { id: jobId }, path.join(outDir, safeRel(m.zip))));
  }
  if (format === 'png' || format === 'both') {
    for (const t of m.targets) for (const f of t.files) saved.push(await download('file', { id: jobId, path: f.path }, path.join(outDir, safeRel(f.path))));
  }
  return { jobId, outputDir: outDir, files: saved, watermark: m.watermark ?? null };
}

function summarize(m) {
  return {
    jobId: m.jobId, style: m.style, device: m.device, watermark: m.watermark, billing: m.billing,
    balance: m.balance ? { credits: m.balance.credits, freeRemaining: m.balance.free?.remaining } : undefined,
    targets: (m.targets || []).map((t) => ({ id: t.id, size: t.size ?? (t.width && t.height ? `${t.width}x${t.height}` : undefined), device: t.device, files: t.files.map((f) => f.path) })),
    warnings: m.warnings?.length ? m.warnings : undefined,
    expires: 'Outputs are kept on the server for 24h — use get_output to download.',
  };
}

const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const guard = (fn) => async (args) => {
  try { return await fn(args || {}); } catch (e) { return { isError: true, content: [{ type: 'text', text: `Error: ${e.message || e}` }] }; }
};
const hex = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'hex colour like #4f46e5');

export function createServer() {
  const server = new McpServer({ name: 'storeshots', version: VERSION });

  server.registerTool('list_styles', {
    title: 'List StoreShots styles',
    description: 'List the curated visual styles (background colours, text colours and layout) with the ids accepted by generate_screenshots.style. ' +
      'Call this before generate_screenshots to choose a look; use list_devices instead for device frames and output sizes. ' +
      'Takes no parameters; read-only, fetched live from the StoreShots API and requires STORESHOTS_API_KEY.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async () => json(await call('styles'))));

  server.registerTool('list_devices', {
    title: 'List devices and output sizes',
    description: 'List device frames (iphone, iphone-duo, android, ipad) and store output targets with pixel sizes (ios-6.9 1320x2868, ios-6.5 1242x2688, android-phone, ipad-13). ' +
      'Call this before generate_screenshots to pick valid device and targets values; use list_styles instead for colours/layouts. ' +
      'Takes no parameters; read-only, fetched live from the StoreShots API and requires STORESHOTS_API_KEY.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async () => json(await call('devices'))));

  server.registerTool('generate_screenshots', {
    title: 'Generate store screenshots',
    description: 'Turn 1–5 raw app screenshots (local file paths or http(s) URLs) into framed App Store / Google Play marketing screenshots ' +
      'with headlines. One call = one set (all requested sizes) = 1 credit; free keys get 3 watermarked sets per month. ' +
      'Returns a jobId plus per-target file list; set download_to (or call get_output later) to save the PNGs/ZIP locally — outputs are kept on the server for 24h. ' +
      'Call list_styles/list_devices first for valid ids. If free sets and credits are used up it returns an error: call get_balance, then buy_credits.',
    inputSchema: {
      screenshots: z.array(z.string().min(1)).min(1).max(5).describe('1–5 local image paths (absolute, ~ or relative to cwd), file:// or http(s) URLs. PNG/JPEG/WebP, ≤10 MB each. One slide per screenshot.'),
      style: z.enum(STYLES).optional().describe('Style id (default glow). See list_styles.'),
      device: z.enum(DEVICES).optional().describe('Device frame. Omit to use each target\'s default device.'),
      targets: z.array(z.enum(TARGETS)).min(1).optional().describe('Output sizes (default ios-6.9, ios-6.5, android-phone).'),
      headlines: z.array(z.string().max(140)).max(5).optional().describe('Headline per slide (≤140 chars), same order as screenshots. Missing entries are left blank; entries beyond the number of screenshots are ignored.'),
      captions: z.array(z.string().max(220)).max(5).optional().describe('Smaller caption under each headline (≤220 chars), same order as screenshots. Missing entries blank; extras ignored.'),
      appName: z.string().max(80).optional().describe('App name, used in output file names.'),
      theme: z.object({
        gradFrom: hex.optional(), gradTo: hex.optional(), bgColor: hex.optional(), bgMode: z.enum(['gradient', 'solid']).optional(),
        headlineColor: hex.optional(), captionColor: hex.optional(), frameColor: hex.optional(),
        textAlign: z.enum(['left', 'center', 'right']).optional(), screenFit: z.enum(['auto', 'cover', 'contain']).optional(),
      }).optional().describe('Optional overrides on top of the style: gradFrom/gradTo (gradient), bgColor + bgMode (solid or gradient background), headlineColor, captionColor, frameColor (hex like #4f46e5), textAlign, screenFit (how the screenshot fills the device screen).'),
      download_to: z.string().optional().describe('If set, download the results into this local directory right away (same as calling get_output). Existing files with the same names are overwritten.'),
      download_format: z.enum(['zip', 'png', 'both']).optional().describe('What to download when download_to is set: zip = one ZIP of all sizes, png = individual PNGs in per-target subfolders, both = both (default zip).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(async (a) => {
    const fd = new FormData();
    const imgs = await Promise.all(a.screenshots.map(loadImage));
    imgs.forEach(({ buf, type, name }) => fd.append('screenshots[]', new Blob([buf], { type }), name));
    if (a.style) fd.append('style', a.style);
    if (a.device) fd.append('device', a.device);
    if (a.appName) fd.append('appName', a.appName);
    if (a.targets?.length) fd.append('targets', a.targets.join(','));
    a.screenshots.forEach((_, i) => { fd.append('headline[]', a.headlines?.[i] ?? ''); fd.append('caption[]', a.captions?.[i] ?? ''); });
    for (const [k, v] of Object.entries(a.theme || {})) if (v !== undefined) fd.append(k, String(v));
    const m = await call('generate', { method: 'POST', body: fd });
    const out = summarize(m);
    if (m.watermark) out.note = 'Free tier: output has a small "Made with StoreShots" watermark. Buy credits (buy_credits) for clean output.';
    if (a.download_to) out.downloaded = await fetchOutput(m.jobId, a.download_to, a.download_format || 'zip');
    return json(out);
  }));

  server.registerTool('get_output', {
    title: 'Download generated screenshots',
    description: 'Download a finished job\'s ZIP and/or individual PNGs to a local directory (default ~/StoreShots/<jobId>, or STORESHOTS_OUTPUT_DIR/<jobId>). ' +
      'Use after generate_screenshots when download_to was not set, or to download again in another format/folder; existing files with the same names are overwritten. ' +
      'Returns the saved file paths and sizes. Jobs expire after 24h; an unknown or expired job_id returns an error (generate again).',
    inputSchema: {
      job_id: z.string().regex(/^\d{8}-[0-9a-f]{10}$/, 'jobId like 20260929-a1b2c3d4e5').describe('The jobId returned by generate_screenshots, e.g. 20260929-a1b2c3d4e5.'),
      output_dir: z.string().optional().describe('Local directory to save into (absolute, ~ or relative; created if missing). Default ~/StoreShots/<jobId>.'),
      format: z.enum(['zip', 'png', 'both']).optional().describe('zip = one ZIP of all sizes, png = individual PNGs in per-target subfolders, both = both. Default zip.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(async (a) => json(await fetchOutput(a.job_id, a.output_dir, a.format || 'zip'))));

  server.registerTool('get_balance', {
    title: 'Credits and free-tier balance',
    description: 'Show remaining paid credits, free generations left this month, and the available credit packs (ids and prices). ' +
      'Call before generate_screenshots to check you have quota, and before buy_credits to get a valid pack id. ' +
      'Takes no parameters; read-only live data that requires STORESHOTS_API_KEY.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, guard(async () => {
    const [balance, packs] = await Promise.all([call('balance'), call('packs', { auth: false }).catch(() => null)]);
    return json({ ...balance, packs: packs?.packs, pricesNote: packs?.note || undefined, account: SIGNUP_URL });
  }));

  server.registerTool('buy_credits', {
    title: 'Get a payment link for credits',
    description: 'Return a Stripe Payment Link for a credit pack, personalised for this API key (client reference + prefilled email). Nothing is charged by this tool: give the link to the user to pay in their browser; credits are added automatically after payment, so confirm with get_balance afterwards. ' +
      'Use when generate_screenshots fails for lack of credits or the user wants unwatermarked output. If it returns an error (e.g. an unknown pack id), get valid pack ids from get_balance.',
    inputSchema: { pack: z.string().min(1).describe('Pack id from get_balance (starter = 10 sets for $3, pro = 20 sets for $5).') },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, guard(async (a) => json(await call('checkout', { method: 'POST', body: { pack: a.pack } }))));

  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  (process.argv[1] && (await fs.realpath(process.argv[1]).catch(() => '')) === fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.includes('--version')) { console.log(VERSION); process.exit(0); }
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error(`[storeshots-mcp ${VERSION}] ready — API ${API_URL}${API_KEY ? '' : ' (STORESHOTS_API_KEY not set)'}`);
}
