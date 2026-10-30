// Agent ID Sniper — 幣安 Agentic Wallet（.ai Agent ID）專屬鑄造監控 + 自動鑄造 + 持倉自動止盈。
// 全部在本地跑：掃 BSC 新合約 → 模擬 → 用 baw CLI 自動打 → 開池後照規則自動賣 → Telegram 通知。不使用任何 AI。
// 停止：在同資料夾放 WATCH_STOP 檔。設定見 config.example.json。
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url), SELF_MT = statSync(SELF).mtimeMs;
const LOG = join(DIR, 'data', 'watch.log'), STATE = join(DIR, 'data', 'watch_state.json');
const ts = () => new Date().toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' });
const log = (s) => { try { appendFileSync(LOG, `[${ts()}] ${s}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const USDT = '0x55d398326f99059ff775485246999027b3197955', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';
const NATIVE_BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // 賣出一律換回 BNB
const ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e', FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const REGISTRY = '60b9262456de011f7d15a54cdd8c48baaa8b022f'; // 幣安 Agent ID 登記合約：合約碼裡出現它 = 只限 Agent ID
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

// 手動追蹤的持倉（config.json 的 tokens）。cost = 每個錢包的成本（U）；both = 每個錢包都有這個成本；hold = 不自動賣只通知；sellNow = 立刻全部賣出
const TOKENS = (CONFIG.tokens || []).map((t) => ({ ...t, addr: t.addr.toLowerCase() }));
// 賣出規則（付費幣到價就執行；免費幣只通知），可在 config.json 的 rules 覆寫
const RULE = {
  backX: 3, halfX: [5, 10], crash: 0.6,   // 3 倍賣回本錢；5 倍、10 倍各賣剩下一半；從最高回落 60% 全賣
  fastMin: 30, fastCrash: 0.35,           // 速戰模式：開池 30 分鐘內，從最高回落 35% 就全賣
  noPumpMin: 20, noPumpX: 2,              // 開池 20 分鐘還沒到 2 倍 → 全賣
  stallSec: 300, drop: 0.5,               // 免費幣：回調 50% 通知
  notifyX: [5, 10],
  ...(CONFIG.rules || {}),
};

let TG = null;
{ const a = CONFIG.telegram?.botToken || process.env.TG_BOT_TOKEN, b = CONFIG.telegram?.chatId || process.env.TG_CHAT_ID; if (a && b) TG = { a, b }; }
// 使用者定：只有要買賣、要使用者決定的才響鈴；其他（自動鑄、收到幣、登入成功…）靜音送達
const important = (t) => /^(⏰|⚠️|🔑|💰|🔥|🚀|🦋|🏗|🛒)/u.test(t) || t.includes('不是免費');

const sendable = (t) => /^(💰|🛒|🔑|⏰|🦋)/u.test(t) || (/^🚀/u.test(t) && (t.includes('開池') || t.includes('平台幣'))) || (/^🔥/u.test(t) && /\d+ 倍/.test(t) && !t.includes('搶打')) || (/^⚠️/u.test(t) && /(想賣但失敗|回調|回落|登入|開發者模式)/.test(t));

const GROUP_ID = CONFIG.telegram?.groupChatId || ''; // 可選：也發到 TG 群（買入、開池、倍數、賣出）
const groupSent = new Map();
async function toGroup(text) { 
  if (!TG) return;
  let msg = '', key = '';
  const ca = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0] || '';
  if (/^🚀/u.test(text) && text.includes('開池')) { const sym = (text.match(/^🚀\s*(\S+)\s*開池/u) || [])[1] || ''; msg = `🚀 ${sym} 开盘了\n池子：${ca}`; key = 'open:' + (sym || ca); }
  else if (/^(🆕|🔥)/u.test(text) && /(已自動鑄造|已排入自動鑄造)/.test(text)) { const name = (text.match(/項目[：:]?\s*([^\n（(|]+)/) || text.match(/合約[：:]\s*([^\n（(|]+)/) || [])[1]?.trim() || ''; msg = `🎯 打了：${name || '新项目'}\n合约：${ca}`; key = 'mint:' + ca.toLowerCase(); }
  if (!msg || !ca) return;
  const now = Date.now(); if (groupSent.has(key) && now - groupSent.get(key) < 6 * 3600e3) return; groupSent.set(key, now);
  try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text: '📡 Agent ID 播报\n' + msg, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function tg(text) { log('TG: ' + text.replace(/\n/g, ' | ')); toGroup(text).catch(() => {}); if (!TG || (!CONFIG.notifyAll && !sendable(text))) return; try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text, disable_web_page_preview: true, disable_notification: !important(text) }), signal: AbortSignal.timeout(10000) }); } catch {} }

const RPCS = ['https://bsc.publicnode.com', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'];
let ri = 0;
async function rpc(method, params) {
  let last; for (let i = 0; i < RPCS.length; i++) { const u = RPCS[(ri + i) % RPCS.length]; try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) })).json(); if (r.error) throw new Error(r.error.message); ri = (ri + i) % RPCS.length; return r.result; } catch (e) { last = e; } }
  throw last;
}
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const wa = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const big = (h) => (h && h !== '0x' ? BigInt(h.slice(0, 66)) : 0n);
const parseOut = (res) => (e, so, se) => { const t = String(so || se || e?.message || ''); let j = null; try { j = JSON.parse(t.slice(t.indexOf('{'))); } catch {} res({ t, j }); };
// 每個錢包一個 baw（幣安 Agentic Wallet CLI）。第二個以後的錢包用獨立的 BINANCE_BAW_DIR / BINANCE_INSTANCE_ID（見 README）
function makeBaw(wc) {
  if (!wc.bawDir) return (args, timeout = 180000) => new Promise((res) => execFile('baw', [...args, '--json'], { shell: true, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res)));
  const env = { ...process.env, BINANCE_BAW_DIR: join(DIR, wc.bawDir), BINANCE_INSTANCE_ID: wc.instanceId || wc.name };
  const bin = join(DIR, wc.bawPkg || 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js');
  return (args, timeout = 180000) => new Promise((res) => execFile(process.execPath, [bin, ...args, '--json'], { env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res)));
}
const WALLETS = (CONFIG.wallets || []).map((wc) => ({ name: wc.name, addr: wc.address.toLowerCase(), baw: makeBaw(wc) }));
if (!WALLETS.length) { console.error('config.json 裡沒有 wallets'); process.exit(1); }
const ME = WALLETS[0].addr;

let S = { tokens: {}, lastBlock: 0, seenMints: {}, lastLoginAlert: 0 };
try { S = { ...S, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}
for (const k of Object.keys(S.tokens)) delete S.tokens[k].verified;
const save = () => { try { writeFileSync(STATE, JSON.stringify(S, null, 1)); } catch {} };

// ---------- 持倉 ----------
async function findPair(t) {
  for (const q of [USDT, WBNB, USD1]) { const r = await call(FACTORY, '0xe6a43905' + wa(t.addr) + wa(q)); const p = r ? '0x' + r.slice(-40) : null; if (!p || /^0x0{40}$/.test(p)) continue; const rs = await call(p, '0x0902f1ac'); if (!rs || BigInt('0x' + rs.slice(2, 66)) === 0n || BigInt('0x' + rs.slice(66, 130)) === 0n) continue; /* 有池子但沒加流動性 = 還沒真的開盤 */ return { pair: p, quote: q }; }
  return null;
}
async function valueUsd(t, amt) { // 全部賣掉約可換多少 USDT
  if (amt <= 0n) return 0;
  for (const path of [[t.addr, USDT], [t.addr, WBNB, USDT], [t.addr, USD1]]) { const r = await call(ROUTER, '0xd06ca61f' + w(amt) + w(64) + w(path.length) + path.map(wa).join('')); if (r) return Number(BigInt('0x' + r.slice(-64))) / 1e18; }
  return null;
}
async function flow(t, st, from, to) { // 新錢包數、成交筆數
  try {
    const tr = await rpc('eth_getLogs', [{ address: t.addr, topics: [T_TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    st.holders = st.holders || {}; let fresh = 0;
    for (const l of tr) { const toA = '0x' + l.topics[2].slice(26); if (!st.holders[toA]) { st.holders[toA] = 1; fresh++; } }
    let swaps = 0; if (st.pair) swaps = (await rpc('eth_getLogs', [{ address: st.pair, topics: [T_SWAP], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])).length;
    return { fresh, swaps };
  } catch { return { fresh: 0, swaps: 0 }; }
}
async function sell(t, st, amt, why, W = WALLETS[0]) {
  const qty = (Number(amt / 10n ** 14n) / 1e4).toFixed(4);
  const bnb0 = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', t.addr, '--toToken', NATIVE_BNB]);
  log(`卖 ${t.sym} ${qty}: ${r.t.slice(0, 600)}`);
  if (!r.j?.success) { await tg(`⚠️ ${t.sym} 想賣但失敗（${why}）\n${(r.j?.error?.message || r.t).slice(0, 200)}\n如果是登入過期，請重新登入 AI 錢包`); return false; }
  await sleep(15000);
  const bnb1 = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  const got = Number(bnb1 - bnb0) / 1e18, px = await bnbUsd().catch(() => 0), gotU = got * px; // 賣出實際換回多少（使用者想知道每筆拿回多少錢）
  S.trades = S.trades || []; S.trades.push({ sym: t.sym, w: W.name, bnb: +got.toFixed(6), usd: +gotU.toFixed(2), cost: t.cost || 0, at: ts(), why });
  await tg(`💰 [${W.name}] 已賣出 ${t.sym}（${why}）\n數量 ${qty}${got > 0 ? `\n換回 ${got.toFixed(5)} BNB（約 ${gotU.toFixed(2)}U）` : ''}\n訂單 ${r.j.data?.orderId || ''}`);
  return true;
}

async function holdings(head, onlyFast = false) {
  await Promise.all(WALLETS.map((W) => holdW(W, head, onlyFast).catch((e) => log('holdings ' + W.name + ' ' + e.message))));
}
async function holdW(W, head, onlyFast) { // 兩個錢包同時跑（速戰：賣單不排隊）
  for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    const t = { ...t0, cost: (t0.only || t0.both || W.addr === ME) ? t0.cost : 0 };
    const key = W.addr === ME ? t.sym : W.name + ':' + t.sym;
    const st = (S.tokens[key] = S.tokens[key] || { hist: [], peak: 0, peakAt: 0, sold: 0 });
    if (onlyFast && !(st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done)) continue;
    const bal = big(await call(t.addr, '0x70a08231' + wa(W.addr)));
    const prevBal = BigInt(st.lastBal || '0'); st.lastBal = bal.toString();
    if (bal > prevBal && st.balInit) { const v0 = await valueUsd(t, bal - prevBal); await tg(`🎁 [${W.name}] 收到 ${t.sym} ${(Number(bal - prevBal) / 1e18).toLocaleString()} 顆${v0 != null ? '，約值 ' + v0.toFixed(2) + 'U' : '（還沒有池子可以報價）'}\n會自動追蹤，到高點就賣`); }
    st.balInit = true;
    if (bal === 0n) { st.done = true; continue; }
    if (st.pair && !st.verified) { const rs = await call(st.pair, '0x0902f1ac'); if (!rs || BigInt('0x' + rs.slice(2, 66)) === 0n) { delete st.pair; st.checked = true; } st.verified = true; } // 舊版誤判的空池子清掉
    if (!st.pair) {
      const p = await findPair(t);
      const first = !st.checked; st.checked = true;
      if (p) { st.pair = p.pair; st.openAt = st.openAt || Date.now(); st.fromBlock = head - 400; if (!first) await tg(`🚀 ${t.sym} 開池了（PancakeSwap）\n池子 ${p.pair}\n開始追蹤價格，達到高點會自動賣`); }
      else { if (t0.deployer && t0.boughtAt && Date.now() - t0.boughtAt > 48 * 3600e3) blacklist(t0.deployer, `${t.sym} 打完 48 小時還沒開池`); continue; }
    }
    const v = await valueUsd(t, bal); if (v == null) continue;
    const from = Math.max(st.fromBlock || head - 20, head - 2000); const f = await flow(t, st, from, head); st.fromBlock = head + 1;
    const now = Date.now(); st.hist.push({ t: now, v, fresh: f.fresh, swaps: f.swaps }); st.hist = st.hist.filter((h) => now - h.t < 20 * 60e3);
    if (v > st.peak) { st.peak = v; st.peakAt = now; }
    const sum = (a, b, k) => st.hist.filter((h) => now - h.t >= a * 1000 && now - h.t < b * 1000).reduce((s, h) => s + h[k], 0);
    const fresh5 = sum(0, 300, 'fresh'), swaps5 = sum(0, 300, 'swaps'), swapsPrev5 = sum(300, 600, 'swaps');
    const stalled = now - st.peakAt >= RULE.stallSec * 1000;
    // 使用者的「高點訊號」：5 分鐘沒新高、錢包數還在增加、成交量放緩（有在成交但比前 5 分鐘少）
    const signal = stalled && fresh5 > 0 && swaps5 > 0 && swaps5 <= swapsPrev5;
    if (st.stage == null) st.stage = st.sold >= 2 ? 9 : st.sold === 1 ? 1 : 0; // 舊版狀態換算
    if (st.stage >= 9) { st.last = { v, at: ts() }; continue; }
    st.notified = st.notified || [];
    if (t.cost > 0) for (const x of RULE.notifyX) if (v >= t.cost * x && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.sym} 到 ${x} 倍了！市值約 ${v.toFixed(2)}U（成本 ${t.cost}U）\n照計畫繼續放飛，從最高點跌 50% 才會賣`); }
    if (t.sellNow) { if (!st.sellNowDone) { if (await sell(t, st, bal, '你指示全部賣出', W)) { st.sellNowDone = true; st.stage = 9; } } continue; }
    if (t.hold) t.cost0 = t.cost;
    if (!(t.cost > 0) || t.hold) { // 免費的、或使用者說先別賣的：不自動賣，只通知（以開池後第一個價格當基準）
      st.base = t.hold ? t.cost : (st.base || v); st.notified = st.notified || [];
      for (const x of RULE.notifyX) if (v >= st.base * x && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.hold ? '' : '免費幣 '}${t.sym} 漲到${t.hold ? "成本" : "開池價"}的 ${x} 倍！市值約 ${v.toFixed(2)}U\n${t.hold ? '你說先別賣，要賣在 TG 打「賣 ' + t.sym + '」' : '從最高回落 50% 會自動全賣；想先賣在 TG 打「賣 ' + t.sym + '」'}`); }
      if (!t.hold && st.peak > 0 && v < st.peak * (1 - RULE.drop) && v >= 0.3 && (st.freeFail || 0) < 3 && Date.now() - (st.freeFailAt || 0) > 600e3) { 
        if (await sell(t, st, bal, `免費幣從最高 ${st.peak.toFixed(2)}U 回落 50%，全部賣出（約 ${v.toFixed(2)}U）`, W)) { st.stage = 9; continue; }
        st.freeFail = (st.freeFail || 0) + 1; st.freeFailAt = Date.now();
      }
      if (t.hold && v < st.peak * (1 - RULE.drop) && st.dropWarnedPeak !== st.peak) { st.dropWarnedPeak = st.peak; await tg(`⚠️ [${W.name}] ${t.hold ? '' : '免費幣 '}${t.sym} 從最高 ${st.peak.toFixed(2)}U 回調 50%，現在約 ${v.toFixed(2)}U\n${t.hold ? "你說先別賣，不會自動賣" : "免費幣不會自動賣"}，要賣手動處理`); }
      st.last = { v, at: ts() }; continue;
    }
    st.done2 = st.done2 || [];
    const age = Date.now() - (st.openAt || 0), fast = age < RULE.fastMin * 60e3;
    const crash = fast ? RULE.fastCrash : RULE.crash;
    if (st.peak > 0 && v < st.peak * (1 - crash)) {
      if (!st.done2.includes('back') && t0.deployer) blacklist(t0.deployer, `${t.sym} 還沒回本就崩`);
      if (await sell(t, st, bal, `${fast ? '速戰模式：' : ''}從最高 ${st.peak.toFixed(2)}U 回落 ${Math.round(crash * 100)}%，全部賣出`, W)) st.stage = 9;
    } else if (st.openAt && age > RULE.noPumpMin * 60e3 && st.peak < t.cost * RULE.noPumpX && !st.done2.includes('back')) {
      if (await sell(t, st, bal, `開池 ${RULE.noPumpMin} 分鐘還沒到 ${RULE.noPumpX} 倍，判斷沒行情，全部賣出（市值約 ${v.toFixed(2)}U）`, W)) st.stage = 9;
    } else if (!st.done2.includes('back') && v >= t.cost * RULE.backX) {
      const pct = Math.min(100, Math.ceil((t.cost / v) * 100 * 1.03));
      if (await sell(t, st, (bal * BigInt(pct)) / 100n, `到 ${RULE.backX} 倍，賣 ${pct}% 拿回本錢 ${t.cost}U（市值約 ${v.toFixed(2)}U）`, W)) st.done2.push('back');
    } else for (const x of RULE.halfX) {
      if (!st.done2.includes('h' + x) && v >= t.cost * x) { if (await sell(t, st, bal / 2n, `到 ${x} 倍，賣出一半（市值約 ${v.toFixed(2)}U）`, W)) st.done2.push('h' + x); break; }
    }
    st.last = { v, fresh5, swaps5, swapsPrev5, at: ts() };
  }
}

// ---------- 新的 Agent ID 專屬鑄造 ----------
const CANDS = [['mint()', '0x1249c58b'], ['freeMint()', '0x5b70ea9f'], ['claim()', '0x4e71d92d'], ['mint(1)', '0xa0712d68' + w(1)], ['publicMint()', '0x26092b83'], ['commitFreeMint()', '0x74d04cfc'], ['registerForRewards()', '0x9f92d0dd'], ['freeMint(1)', '0x7c928fe9' + w(1)], ['claim(1)', '0x379607f5' + w(1)], ['mintFree()', '0x8ab53447'], ['claimFree()', '0xf366afc9'], ['agentMint()', '0x1be3587a']];
// ---- keccak256（算 CREATE2 地址用）----
const KRC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const KROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const M64 = (1n << 64n) - 1n; const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakHex(hex) {
  const msg = Buffer.from(hex, 'hex'); const rate = 136; const padLen = rate - (msg.length % rate); const p = Buffer.concat([msg, Buffer.alloc(padLen)]); p[msg.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= p.readBigUInt64LE(off + i * 8);
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[y + x] ^= D; }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], KROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= KRC[r];
    }
  }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8); return out.toString('hex');
}
const DEPLOYERS = ['0x4e59b44847b379578588920ca78fbf26c0b4956c', '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', '0x0000000000ffe8b47b3e2130213b802212439497', '0x914d7fec6aac8cd542e72bca78b30650d45643d7'];

// ---------- 聰明錢包：之前賺錢項目（JAGENT/SWARM/BIBIAI/BNBS…）最早去打的 Agent ID 錢包；他們一動手就提早檢查 ----------
const WINNERS = ['0x8e6442663a4f8c50b6132c68d42a30e7dfe4ae15', '0x04fd77c2f97d044b3c719282fd0a0568f4254afa', '0x415aac3e46264c046d103c994a1da71f05c547f9', '0x171f264f938d55d968afc5d6b133c4157a61f05f'];
let SMART = new Set(S.smart || []);
async function buildSmart() {
  const head = parseInt(await rpc('eth_blockNumber', []), 16); const cnt = {};
  for (const a of WINNERS) {
    try {
      const has = async (b) => (((await rpc('eth_getCode', [a, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2);
      let lo = head - 400000, hi = head; if (await has(lo)) continue;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (await has(m)) hi = m; else lo = m; }
      const tos = [];
      for (let f = hi; f < Math.min(head, hi + 60000) && tos.length < 300; f += 3000) {
        const logs = await rpc('eth_getLogs', [{ address: a, fromBlock: '0x' + f.toString(16), toBlock: '0x' + (f + 2999).toString(16), topics: [T_TRANSFER, '0x' + '0'.repeat(64)] }]).catch(() => []);
        for (const l of logs || []) { const t = '0x' + l.topics[2].slice(26); if (!tos.includes(t)) tos.push(t); if (tos.length >= 300) break; }
      }
      for (const t of tos) cnt[t] = (cnt[t] || 0) + 1;
    } catch (e) { log('smart ' + a + ' ' + e.message); }
  }
  for (const W of WALLETS) delete cnt[W.addr];
  const list = Object.entries(cnt).filter(([, c]) => c >= 2).map(([t]) => t);
  if (list.length) { SMART = new Set(list); S.smart = list; S.smartAt = Date.now(); log(`聰明錢包名單更新：${list.length} 個`); }
}

// ---------- 保險：同一個合約短時間被很多錢包呼叫（像奶寶龍開打）→ 立刻檢查是不是 Agent ID 專屬 ----------
const HOT = new Map(), hotChecked = new Map();
function countHot(txs) {
  const now = Date.now(); if (!SMART.size && S.smart?.length) SMART = new Set(S.smart);
  for (const t of txs) {
    const recv = (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n; // 直接轉 BNB 就鑄（像 BNBS）
    if (!t.to || (t.input || '').length > 2 + 8 + 64 * 4 || BigInt(t.value || '0x0') > 2n * 10n ** 17n) continue; // 鑄造常要付 BNB（QUOGENT 0.0005、灯笼镇 0.0125–0.1），≤0.2 BNB 的呼叫都算
    if (/^0x(a9059cbb|095ea7b3|23b872dd|d0e30db0|2e1a7d4d|39509351|a457c2d7)/.test(t.input || '')) continue; // 轉帳、授權、存取這類不是鑄造 // 只看短呼叫、≤0.001 BNB 的（鑄造的樣子）
    const k = t.to.toLowerCase(); let h = HOT.get(k); if (!h) { h = { from: new Set(), at: now, sel: new Map() }; HOT.set(k, h); }
    if (now - h.at > 180e3) { h.from.clear(); h.at = now; h.sel.clear(); h.smart = new Set(); h.vals = new Map(); }
    if (SMART.has(t.from.toLowerCase())) (h.smart = h.smart || new Set()).add(t.from.toLowerCase());
    h.from.add(t.from.toLowerCase()); const sl = (t.input || '').slice(0, 10); h.sel.set(sl, (h.sel.get(sl) || 0) + 1); if (recv) { h.vals = h.vals || new Map(); const vv = BigInt(t.value).toString(); h.vals.set(vv, (h.vals.get(vv) || 0) + 1); }
  }
  if (HOT.size > 20000) for (const [k, h] of HOT) if (now - h.at > 180e3) HOT.delete(k);
}
// ---------- 第三道保險：直接看「鑄造事件」（不管合約怎麼部署、付多少錢）----------
// 每個區塊所有 Transfer(from=0x0) 都看：同一個代幣／NFT 3 分鐘內被鑄給 15 個以上不同錢包 → 找出大家呼叫的合約 → 判斷是不是 Agent ID 專屬 → 照規則打
const MINTS = new Map(), mintChecked = new Map();
const ZERO32 = '0x' + '0'.repeat(64);
async function mintLogs(from, to) {
  // 1) drpc 支援不帶地址的 getLogs（最省流量）
  try { const r = await (await fetch('https://bsc.drpc.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [T_TRANSFER, ZERO32] }] }), signal: AbortSignal.timeout(10000) })).json(); if (Array.isArray(r.result)) return r.result; } catch {}
  // 2) 退而求其次：抓整個區塊的收據自己過濾
  const out = [], nodes = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://bsc-rpc.publicnode.com'];
  await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => from + i).map(async (b, i) => {
    for (let k = 0; k < nodes.length; k++) { try { const r = await (await fetch(nodes[(i + k) % nodes.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockReceipts', params: ['0x' + b.toString(16)] }), signal: AbortSignal.timeout(12000) })).json(); if (Array.isArray(r.result)) { for (const rc of r.result) for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics[1] === ZERO32 && l.topics[2]) out.push(l); return; } } catch {} }
  }));
  return out;
}
async function mintScan(head) {
  if (!S.mintBlock || head - S.mintBlock > 300) S.mintBlock = head - 5;
  const to = Math.min(head, S.mintBlock + 60); if (to <= S.mintBlock) return;
  const logs = await mintLogs(S.mintBlock + 1, to); S.mintBlock = to;
  const now = Date.now();
  for (const l of logs) {
    const a = l.address.toLowerCase(); let m = MINTS.get(a); if (!m) { m = { at: now, to: new Set(), txs: [] }; MINTS.set(a, m); }
    if (now - m.at > 1800e3) { m.at = now; m.to.clear(); m.txs = []; } // 30 分鐘內累計（慢熱的項目也抓得到）
    m.to.add('0x' + l.topics[2].slice(26)); if (m.txs.length < 8) m.txs.push(l.transactionHash);
  }
  if (MINTS.size > 30000) for (const [k, m] of MINTS) if (now - m.at > 1800e3) MINTS.delete(k);
  for (const [a, m] of MINTS) {
    if (m.to.size < 6 || (mintChecked.has(a) && m.to.size < mintChecked.get(a) * 2) || S.seenMints[a]) continue; // 沒過的，等人數翻倍再看一次 // 6 個不同錢包被鑄到就檢查（QUOGENT 開打頭 15 分鐘只有十幾個錢包）
    mintChecked.set(a, m.to.size); if (mintChecked.size > 20000) mintChecked.delete(mintChecked.keys().next().value);
    await checkMinted(a, m).catch((e) => log('mintScan ' + a + ' ' + e.message));
  }
}
async function checkMinted(tok, m) {
  // 找出大家實際呼叫的合約（鑄造合約可能跟代幣合約不同）
  const txs = (await Promise.all(m.txs.slice(0, 6).map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter(Boolean);
  const cnt = {}; for (const t of txs) if (t.to) cnt[t.to.toLowerCase()] = (cnt[t.to.toLowerCase()] || 0) + 1;
  const target = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0]; if (!target) return;
  if (S.seenMints[target] || S.seenMints[tok]) return;
  // 是不是 Agent ID 專屬：合約碼有登記合約，或鑄到的錢包六成以上有 .ai 身份
  let code = ((await rpc('eth_getCode', [target, 'latest']).catch(() => '')) || '').toLowerCase();
  if (code.length > 2 && code.length < 4000) { try { const impl = await rpc('eth_getStorageAt', [target, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']); if (impl && BigInt(impl) !== 0n) code += ((await rpc('eth_getCode', ['0x' + impl.slice(-40), 'latest'])) || '').toLowerCase(); } catch {} }
  const tcode = tok === target ? code : ((await rpc('eth_getCode', [tok, 'latest']).catch(() => '')) || '').toLowerCase();
  let gated = code.includes(REGISTRY) || tcode.includes(REGISTRY), share = 0;
  if (!gated) {
    // 沒寫 Agent ID 檢查的：只看兩天內新部署的合約（排除 LP、老代幣這類每天都在鑄的）
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const old = (await rpc('eth_getCode', [tok, '0x' + (head - 400000).toString(16)]).catch(() => '0x')) || '0x';
    if (old.length > 2) return;
    const sample = [...m.to].slice(0, 12); let n = 0;
    for (const x of sample) { const r = await call('0x' + REGISTRY, '0x70a08231' + wa(x)); if (r && BigInt(r.slice(0, 66)) > 0n) n++; }
    share = n / sample.length; if (n < 4 || share < 0.6) return;
    gated = true;
  }
  S.seenMints[target] = ts(); S.seenMints[tok] = ts();
  const name = tokStr(await call(tok, '0x06fdde03')) || tokStr(await call(target, '0x06fdde03'));
  // 先試常見免費函式；不行就「照別人的呼叫內容重播」（不含別人地址的才重播）
  let minted = '';
  const sampleTx = txs.find((t) => t.to && t.to.toLowerCase() === target);
  for (const W of WALLETS) {
    let ff = await findFree(W.addr, target, code);
    if (!ff && sampleTx && sampleTx.input.length >= 10 && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase())) {
      for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from: W.addr, to: target, data: sampleTx.input, value: '0x' + v.toString(16) }, 'latest']); const nm = '重播' + sampleTx.input.slice(0, 10); if (!CANDS.some((c) => c[0] === nm)) CANDS.push([nm, sampleTx.input]); ff = { n: nm, v }; break; } catch {} }
    }
    if (ff) minted += `[${W.name}] ` + queueMint(target, ff.n, W, ff.v) + '\n';
  }
  if (!minted) {
    S.paid = S.paid || {};
    const val = sampleTx ? BigInt(sampleTx.value || '0x0') : 0n;
    const noAddr = sampleTx && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase());
    S.paid[target] = { at: Date.now(), name, done: {}, wallets: m.to.size, ...((sampleTx?.input || '0x') === '0x' && val > 0n ? { recvValue: val.toString(), recvSeen: m.to.size } : {}), ...(noAddr && sampleTx.input !== '0x' ? { replay: { data: sampleTx.input, value: val.toString() } } : {}) };
  }
  await tg(`🔥 發現正在被鑄造的 Agent ID 項目${name ? '：' + name : ''}（3 分鐘內鑄給 ${m.to.size} 個錢包${share ? `，${Math.round(share * 100)}% 有 .ai 身份` : ''}）\n${target}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度超過 80% 且每個錢包 ≤20U 會自動打'}`);
}

async function hotScan() {
  for (const [c, h] of HOT) {
    if ((h.from.size < 12 && (h.smart?.size || 0) < 2) || S.seenMints[c] || hotChecked.has(c)) continue;
    hotChecked.set(c, Date.now()); if (hotChecked.size > 5000) hotChecked.delete(hotChecked.keys().next().value);
    let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase();
    if (code.length > 2 && code.length < 4000) { try { let impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']); if (impl && BigInt(impl) !== 0n) code += ((await rpc('eth_getCode', ['0x' + impl.slice(-40), 'latest'])) || '').toLowerCase(); } catch {} }
    let viaAgents = 0;
    if (!code.includes(REGISTRY)) {
      // 合約碼裡沒有 Agent ID 登記合約（可能用後端簽名驗證，像灯笼镇、Silicon Dreamers）→ 改看「打它的人是不是大多持有 Agent ID」
      if (code.length < 4) continue;
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const old = (await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x')) || '0x';
      if (old.length > 2) continue; // 兩天前就存在的老合約不算新項目
      const sample = [...h.from].slice(0, 16); let n = 0;
      for (const a of sample) { const r = await call('0x' + REGISTRY, '0x70a08231' + wa(a)); if (r && BigInt(r.slice(0, 66)) > 0n) n++; }
      if (n < 8 || n / sample.length < 0.6) continue;
      viaAgents = n / sample.length;
    }
    S.seenMints[c] = ts();
    const name = tokStr(await call(c, '0x06fdde03'));
    // 熱門呼叫的函式也加入候選（不在 CANDS 裡的鑄造函式名）
    const topSel = [...h.sel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    let minted = '';
    for (const W of WALLETS) {
      let ff = await findFree(W.addr, c, code);
      if (!ff && topSel && topSel.length === 10) for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from: W.addr, to: c, data: topSel, value: '0x' + v.toString(16) }, 'latest']); CANDS.push(['熱門函式' + topSel, topSel]); ff = { n: '熱門函式' + topSel, v }; break; } catch {} }
      if (ff) minted += `[${W.name}] ` + queueMint(c, ff.n, W, ff.v) + '\n';
    }
    if (!minted) {
      S.paid = S.paid || {};
      // 轉 BNB 就鑄的：取大家最常轉的金額當「一份的價格」（至少 10 筆一樣才算數）
      const top = [...(h.vals || new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
      S.paid[c] = { at: Date.now(), name, done: {}, wallets: h.from.size, ...(top && top[1] >= 2 ? { recvValue: top[0], recvSeen: top[1] } : {}) };
    }
    await tg(`🔥 發現正在被搶打的 Agent ID 項目${name ? '：' + name : ''}${viaAgents ? `（合約沒寫 Agent ID 檢查，但打它的錢包 ${Math.round(viaAgents * 100)}% 持有 .ai 身份，可能是後端簽名驗證）` : ''}（3 分鐘內 ${h.from.size} 個錢包${h.smart?.size ? '，其中聰明錢包 ' + h.smart.size + ' 個' : ''}）\n${c}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度超過 80% 且每個錢包 ≤20U 會自動打'}\nhttps://bscscan.com/address/${c}`);
  }
}

async function scanNew(head) {
  if (!S.lastBlock) S.lastBlock = head - 5;
  if (head - S.lastBlock > 1500) { log(`掃描落後太多（${head - S.lastBlock} 塊），跳到最新`); S.lastBlock = head - 200; }
  // BSC 現在約 0.45 秒一個區塊（每分鐘 ~130 塊），以前一次只掃 40 塊會越落越後（曾落後 2.5 小時）→ 改成多節點並行抓
  const to = Math.min(head, S.lastBlock + 400);
  const nums = []; for (let b = S.lastBlock + 1; b <= to; b++) nums.push(b);
  const blocks = new Map(); let idx = 0;
  const fetchBlk = async (b) => { for (let k = 0; k < RPCS.length; k++) { const u = RPCS[(b + k) % RPCS.length]; try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] }), signal: AbortSignal.timeout(15000) })).json(); if (r.result) return r.result; } catch {} } return null; };
  await Promise.all(Array.from({ length: 24 }, async () => { while (idx < nums.length) { const b = nums[idx++]; const blk = await fetchBlk(b); if (blk) { countHot(blk.transactions); } if (blk) blocks.set(b, blk.transactions.filter((t) => !t.to || ((t.input || '').length > 2000 && ((t.input || '').toLowerCase().includes(REGISTRY) || DEPLOYERS.includes(t.to.toLowerCase()))))); else blocks.set(b, null); } }));
  let done = S.lastBlock;
  for (const b of nums) { if (blocks.get(b) == null) break; done = b; }
  if (done === S.lastBlock && nums.length) { log('scan 抓區塊失敗 ' + nums[0]); return; }
  S.scanLag = head - done;
  for (let b = S.lastBlock + 1; b <= done; b++) {
    for (const tx of blocks.get(b) || []) {
      // 新合約有三種出生方式：①直接部署 ②透過 CREATE2 部署器（灯笼镇就是這種）③由別的工廠合約建立
      const inp = (tx.input || '').toLowerCase();
      if (tx.to && !(inp.length > 2000 && (inp.includes(REGISTRY) || DEPLOYERS.includes(tx.to.toLowerCase())))) continue;
      let cs = [];
      try {
        if (!tx.to) { const rc = await rpc('eth_getTransactionReceipt', [tx.hash]); if (rc?.contractAddress) cs = [rc.contractAddress.toLowerCase()]; }
        else if (tx.to.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c') { const salt = inp.slice(2, 66), init = inp.slice(66); cs = ['0x' + keccakHex('ff' + tx.to.slice(2).toLowerCase() + salt + keccakHex(init)).slice(24)]; }
        else { const rc = await rpc('eth_getTransactionReceipt', [tx.hash]); if (rc?.status !== '0x1') continue; const as = [...new Set((rc.logs || []).map((l) => l.address.toLowerCase()))]; for (const a of as) { const before = await rpc('eth_getCode', [a, '0x' + (b - 1).toString(16)]).catch(() => '0x'); if (!before || before === '0x') cs.push(a); } }
      } catch { continue; }
      for (const c of cs) try {
        if (S.seenMints[c]) continue;
        let code = (await rpc('eth_getCode', [c, 'latest'])) || '';
        // 代理合约（EIP-1967 / Beacon）：去看背后真正的实现合约
        if (!code.toLowerCase().includes(REGISTRY) && code.length < 4000) {
          try {
            let impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']);
            if (!impl || BigInt(impl) === 0n) { const bc = await rpc('eth_getStorageAt', [c, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', 'latest']); if (bc && BigInt(bc) !== 0n) impl = await call('0x' + bc.slice(-40), '0x5c60da1b'); }
            if (impl && BigInt(impl) !== 0n) code += (await rpc('eth_getCode', ['0x' + impl.slice(-40), 'latest'])) || '';
          } catch {}
        }
        if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
        S.seenMints[c] = ts(); noteDeploy(code); S.deployer = S.deployer || {}; S.deployer[c] = (tx.from || '').toLowerCase(); noteDev(S.deployer[c], c);
        const ok = [];
        { const ff = await findFree(ME, c, code); if (ff) ok.push(ff.n + (ff.v > 0n ? `（付 ${Number(ff.v) / 1e18} BNB 手續費）` : '')); }
        const str = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return ''; } };
        let name = str(await call(c, '0x06fdde03'));
        if (!name) for (const sel of ['0xfc0c546a']) { const r = await call(c, sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { const ta = '0x' + r.slice(26, 66); const n2 = str(await call(ta, '0x06fdde03')), s2 = str(await call(ta, '0x95d89b41')); if (n2) { name = `${n2}${s2 ? ' ($' + s2 + ')' : ''}`; break; } } }
        const lc = code.toLowerCase();
        const pay = lc.includes('55d398326f99059ff775485246999027b3197955') ? '要付 USDT' : lc.includes('8ac76a51cc950d9822d68b83fe1ad97b32cd580d') ? '要付 USDC' : '可能要付 BNB';
        const factoryLike = ['27cca59f', '7d38bb0d', '1737a4bd'].some((x) => code.includes(x)) || /(6c61756e6368|666163746f7279)/.test(code.toLowerCase());
        if (factoryLike) await tg(`🏗 發現疑似新的 Agent ID 發射台／工廠合約${name ? '：' + name : ''}\n${c}\n可能是像 ToshX、Flap Agent 這種平台，可以自己到 BscScan 查看`);
        let minted = '';
        for (const W of WALLETS) { const ff = await findFree(W.addr, c, code); const f = ff?.n; if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n'; }
        if (!ok.length) { S.paid = S.paid || {}; S.paid[c] = { at: Date.now(), name, done: {} }; }
        await tg(`🆕 發現新的 Agent ID 專屬合約${name ? '：' + name : ''}\n${c}\n${ok.length ? '✅ 模擬免費可鑄：' + ok.join('、') + '\n' + minted : `⚪ 現在不是免費的（${pay}，或還沒開）→ 已加入追蹤：\n· 開放後若免費或手續費 ≤0.001 BNB → 自動打\n· 付費 → 進度超過 80% 且每個錢包 ≤20U → 自動打`}\nhttps://bscscan.com/address/${c}`);
      } catch {}
    }
  }
  await hotScan().catch((e) => log('hotScan ' + e.message));
  await mintScan(done).catch((e) => log('mintScan ' + e.message));
  await proxyScan(S.lastBlock + 1, done).catch((e) => log('proxyScan ' + e.message));
  S.lastBlock = done;
}

// ---------- 工厂合约建出来的代理合约（像 AIDROP 金库）：用「代理升级」事件抓 ----------
const T_BEACON_UP = '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e'; // BeaconUpgraded(address)
const T_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';  // Upgraded(address)
const implCache = new Map();
const VAULT_FACTORIES = ['0x90497450f2a706f1951b5bdda52b4e5d16f34c06']; // Flap 金庫工廠（AIDROP 就是它建的）
async function proxyScan(from, to) {
  if (to < from) return;
  // 公用節點不允許不帶地址的 getLogs，所以盯 Flap 金庫工廠：它每建一個新金庫就有事件，再從那筆交易收據找新代理合約
  const fl = await rpc('eth_getLogs', [{ address: VAULT_FACTORIES, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  const txs = [...new Set((fl || []).map((l) => l.transactionHash))];
  const logs = [];
  for (const h of txs) { const rc = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); for (const l of rc?.logs || []) if (l.topics[0] === T_BEACON_UP || l.topics[0] === T_UPGRADED) logs.push(l); }
  for (const l of logs) {
    const c = l.address.toLowerCase(); if (S.seenMints[c]) continue;
    let impl = '0x' + l.topics[1].slice(26);
    if (l.topics[0] === T_BEACON_UP) { const r = await call(impl, '0x5c60da1b'); if (!r) continue; impl = '0x' + r.slice(-40); }
    if (!implCache.has(impl)) { const code = (await rpc('eth_getCode', [impl, 'latest']).catch(() => '')) || ''; implCache.set(impl, code); if (implCache.size > 500) implCache.delete(implCache.keys().next().value); }
    const code = implCache.get(impl);
    if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
    S.seenMints[c] = ts();
    let minted = '';
    for (const W of WALLETS) { const ff = await findFree(W.addr, c, code); const f = ff?.n; if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n'; }
    await tg(`🧩 發現工廠建立的 Agent ID 合約（代理合約，像 AIDROP 那種）\n${c}\n${minted || '⚪ 目前模擬不能免費參加（可能要付費或還沒開）'}`);
  }
}

// ---------- 自動鑄造（使用者要求開啟）：只鑄 0 元、無授權、不扣使用者任何資產的 ----------
// 「幾乎免費」：有些項目要付一點防女巫手續費（像奶寶龍 0.00022 BNB），最多接受 0.001 BNB
const NEAR_FREE = [0n, 10n ** 14n, 22n * 10n ** 13n, 3n * 10n ** 14n, 5n * 10n ** 14n, 10n ** 15n];
async function findFree(from, c, code) {
  for (const [n, d] of CANDS) { if (d.length < 10 || !code.includes(d.slice(2, 10))) continue; /* 空呼叫（直接轉 0 BNB）不算鑄造 */ for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from, to: c, data: d, value: '0x' + v.toString(16) }, 'latest']); return { n, v }; } catch {} } }
  return null;
}
// 鑄造排隊：每個錢包一條隊伍在背景跑（交易要一筆一筆送），不卡住掃描
const MQ = new Map();
function queueMint(c, fname, W, v) {
  const prev = MQ.get(W.name) || Promise.resolve();
  const job = prev.then(() => autoMintMax(c, fname, W, v)).then((m) => log(`[${W.name}] ${c} ${m.replace(/\n/g, ' | ')}`)).catch((e) => log(`[${W.name}] 鑄造失敗 ${c} ${e.message}`));
  MQ.set(W.name, job);
  return '⏳ 已排入自動鑄造（背景進行）';
}

// 每個錢包可以打多份的（每錢包上限 >1），模擬還能過就繼續打，最多 MAX_REPEAT 次
const MAX_REPEAT = 10;
async function autoMintMax(c, fname, W, val = 0n) {
  const d = Object.fromEntries(CANDS)[fname]; let first = await autoMint(c, fname, W, val), n = first.startsWith('🤖') ? 1 : 0;
  while (n > 0 && n < MAX_REPEAT) {
    await sleep(6000);
    // 第一份免費、之後要付一點的（像 QUOGENT）：每次重新找能過的金額（≤0.001 BNB）
    // 防釣魚：只有「完全免費」才連續打；要付手續費的每個項目每個錢包只打 1 份（避免被故意發盤賺手續費）
    let v2 = null; try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x0' }, 'latest']); v2 = 0n; } catch {}
    if (v2 == null) break;
    const m = await autoMint(c, fname, W, v2); if (!m.startsWith('🤖')) break; n++;
  }
  return n > 1 ? first + `\n（同一個錢包共打了 ${n} 份）` : first;
}
async function autoMint(c, fname, W = WALLETS[0], val = 0n) {
  { const dep = await deployerOf(c); if (dep) { if (!(S.devs?.[dep] || []).some((x) => x.c === c)) noteDev(dep, c); if (isRepeatDev(dep)) return `⛔ 重複 DEV（${dep.slice(0, 10)}… 24 小時內發了 ${(S.devs[dep] || []).length} 個項目），不鑄造`; if (S.black?.[dep]) return `⛔ 部署者在黑名單（${S.black[dep].why}），不鑄造`; } }
  // 防釣魚：付手續費的免費鑄造，每個錢包每天手續費合計最多 0.005 BNB
  if (val > 0n) { const dd = new Date().toDateString(); S.feeDay = S.feeDay || {}; if (S.feeDay.d !== dd) S.feeDay = { d: dd }; const used = S.feeDay[W.name] || 0; if (used + Number(val) / 1e18 > 0.005) return '⏸ 今天手續費型鑄造已達 0.005 BNB 上限，沒有鑄'; S.feeDay[W.name] = used + Number(val) / 1e18; }
  const d = Object.fromEntries(CANDS)[fname];
  const today = new Date().toDateString(); if (S.mintDay !== today) { S.mintDay = today; S.mintCount = 0; }
  S.mintCnt = S.mintCnt && S.mintCnt.d === today ? S.mintCnt : { d: today }; if ((S.mintCnt[W.name] || 0) >= 1000) return '⏸ 這個錢包今天自動鑄已達 1000 筆上限，沒有鑄';
  const bnb = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  if (bnb < 5n * 10n ** 14n) return '⚠️ BNB 不夠付 gas（< 0.0005），沒有鑄';
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', c, '--value', val.toString(), '--inputData', d]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) return '❌ 預演失敗，沒有鑄：' + (p.j?.error?.message || '').slice(0, 120);
  const losing = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) < 0 && !(String(b.contractAddress).toLowerCase().startsWith('0xeeee') && -Number(b.change) <= Number(val) * 1.01 && val > 0n));
  if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length || losing.length) return '⚠️ 預演顯示有授權或會扣你的資產，安全起見沒有鑄';
  const x = await W.baw(['contract-call', 'execute', '--requestId', rid]);
  if (!x.j?.success) return '❌ 送出失敗：' + (x.j?.error?.message || x.t).slice(0, 120);
  S.mintCount++; S.mintCnt[W.name] = (S.mintCnt[W.name] || 0) + 1;
  // 免費鑄造拿到的代幣也加入持倉追蹤（成本 0 → 只通知 5／10 倍、回調，不自動賣）
  for (const b of sim?.balanceChanges || []) { if (String(b.owner).toLowerCase() !== W.addr || b.tokenType !== 'Erc20' || !(Number(b.change) > 0)) continue; const ta = String(b.contractAddress).toLowerCase(); S.dyn = S.dyn || []; if (!S.dyn.some((t) => t.addr === ta && t.only === W.addr)) { const sy = tokStr(await call(ta, '0x95d89b41')) || ta.slice(0, 8); S.dyn.push({ sym: sy, addr: ta, cost: 0, only: W.addr }); } }
  for (const b of sim?.balanceChanges || []) if (String(b.owner).toLowerCase() === W.addr && /Erc721|Erc1155/i.test(b.tokenType || '')) { S.nftCols = S.nftCols || {}; S.nftCols[String(b.contractAddress).toLowerCase()] = 1; } // 記下持有的 NFT 系列（12 小時看一次成交量）
  const got = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr).map((b) => (b.tokenType === 'Erc721' ? 'NFT ×1' : b.tokenType + ' +' + b.change)).join('、');
  return `🤖 已自動鑄造 ${fname}${got ? '（' + got + '）' : ''}${fname.startsWith('commit') ? '\n（這種是兩步式，還要 reveal 才拿到，手動處理）' : ''}\n交易 ${x.j.data?.txHash || x.j.data?.orderId || ''}`;
}

// ---------- AIDROP 金库：出现新类型的事件（例如开放领取/发放）就通知 ----------
const AIDROP_VAULT = (CONFIG.watchVault || '').toLowerCase(); // 可選：要盯的 Flap 金庫（例如 AIDROP）
async function aidropWatch(head) {
  if (!AIDROP_VAULT) return;
  S.aidrop = S.aidrop || { topics: {}, from: head - 2000 };
  try {
    const logs = await rpc('eth_getLogs', [{ address: AIDROP_VAULT, fromBlock: '0x' + Math.max(S.aidrop.from, head - 4000).toString(16), toBlock: '0x' + head.toString(16) }]);
    const first = Object.keys(S.aidrop.topics).length === 0;
    let alerted = false;
    for (const l of logs) { const t0 = l.topics[0]; if (['0x8a587a0e', '0xe988651c'].includes(t0.slice(0, 10))) { S.aidrop.topics[t0] = 1; continue; } if (!S.aidrop.topics[t0]) { S.aidrop.topics[t0] = 1; if (!first && !alerted && (alerted = true)) await tg(`📣 AIDROP 金库出现新的链上动作（新事件类型）\n可能是开放领取或开始发放，请自行查看\n交易 ${l.transactionHash}`); } }
    S.aidrop.from = head + 1;
  } catch {}
}

// ---------- ToshX：Agent ID 专属的小额 IGO（要付钱，不自动买）。有新项目就分析后 TG 通知 ----------
const TOSH_FACTORIES = [['BNB', '0x091d0cbd1e3b7d8b2a6fd8e0795b784eddffb590'], ['USDT', '0x8296fa2d430dcf25233a39cc3306ee503967a6bb']];
async function toshWatch() {
  S.tosh = S.tosh || { counts: {} };
  for (const [quote, f] of TOSH_FACTORIES) {
    const r = await call(f, '0x27cca59f'); if (!r) continue; const n = Number(BigInt(r.slice(0, 66)));
    const prev = S.tosh.counts[f];
    if (prev === undefined) { S.tosh.counts[f] = n; continue; } // 第一次只记数量，不通知旧项目
    for (let i = prev; i < n; i++) {
      try {
        const L = await call(f, '0x7b443a76' + w(i)); const W4 = L.slice(2).match(/.{64}/g);
        const token = '0x' + W4[0].slice(24), hook = '0x' + W4[1].slice(24), creator = '0x' + W4[2].slice(24), createdAt = Number(BigInt('0x' + W4[3]));
        const str = async (sel) => { const h = await call(token, sel); try { const x = h.slice(2); const len = Number(BigInt('0x' + x.slice(64, 128))); return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return '?'; } };
        const name = await str('0x06fdde03'), sym = await str('0x95d89b41');
        // 创建者以前发过几个（两个工厂都算）
        let byCreator = 0; for (const [, f2] of TOSH_FACTORIES) { const c2 = await call(f2, '0x27cca59f'); const n2 = c2 ? Number(BigInt(c2.slice(0, 66))) : 0; for (let k = Math.max(0, n2 - 60); k < n2; k++) { const L2 = await call(f2, '0x7b443a76' + w(k)); if (L2 && L2.slice(2).match(/.{64}/g)[2].slice(24) === creator.slice(2)) byCreator++; } }
        // 官网资料（简介、推特、TG）
        let meta = null; try { const j = await (await fetch('https://toshx.xyz/api/projects', { signal: AbortSignal.timeout(10000) })).json(); meta = (j.data || []).find((p) => String(p.token_address).toLowerCase() === token); } catch {}
        const raisedRaw = quote === 'BNB' ? await rpc('eth_getBalance', [hook, 'latest']).catch(() => '0x0') : await call(USDT, '0x70a08231' + wa(hook));
        const raised = Number(BigInt(raisedRaw || '0x0')) / 1e18;
        const flags = [];
        if (!meta) flags.push('官网还没有资料（可能是测试盘）');
        if (meta && !meta.twitter) flags.push('没有推特');
        if (meta && !meta.website) flags.push('没有官网');
        if (byCreator > 1) flags.push(`同一个创建者已发过 ${byCreator} 个`);
        if (/test/i.test(name + sym)) flags.push('名字像测试盘');
        const desc = (meta?.description || '').replace(/\s+/g, ' ').slice(0, 220);
        const verdict = flags.length >= 2 ? '🔴 風險偏高，建議觀望' : flags.length === 1 ? '🟡 有疑點，自己再看看' : '🟢 資料齊全，可以考慮';
        // 使用者的規則：發射台上的一般代幣不打，只打平台幣
        const PLATFORM_DEPLOYER = '0x790091e8965ecc1adfa40aa9b95515c6289dce9d'; // TOSH 平台幣的建立者
        const isPlatform = creator.toLowerCase() === PLATFORM_DEPLOYER || /platform token|平台币|平台幣|platform coin/i.test((meta?.description || '') + name);
        if (!isPlatform) { log(`ToshX 新项目 ${name}(${sym}) 不是平台币，按规则不通知`); continue; }
        await tg(`🚀 ToshX 平台幣相關新項目：${name}（$${sym}）\n報價幣：${quote} · 已募到約 ${raised.toFixed(3)} ${quote}\n建立時間：${new Date(createdAt * 1000).toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' })}\n${desc ? '簡介：' + desc + '\n' : ''}${meta?.twitter ? 'X：' + meta.twitter + '\n' : ''}${meta?.telegram ? 'TG：' + meta.telegram + '\n' : ''}代幣 ${token}\n分析：${verdict}${flags.length ? '（' + flags.join('、') + '）' : ''}\n規則：每個 Agent ID 一份額度，通常開賣幾分鐘就滿。要打的話手動處理「打 ${sym}」和每個錢包打多少\nhttps://toshx.xyz/launchpad`);
      } catch (e) { log('tosh err ' + e.message); }
    }
    S.tosh.counts[f] = n;
  }
}

// ---------- Flap「ID AGENT CURVE」：只限 Agent ID 的曲线发射台，有新盘就分析后 TG ----------
const FLAP_READER = '0x18aa6c93f1887a243fdc348c9a77f5136555174a';
const FLAP_QUOTES = { '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436': 'NVDAB', '0x205812cdbed920aff76c6580abd681a46d11efc7': 'QQQB', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1': 'SPCXB' };
function decStrAt(hex, byteOff) { const h = hex.replace(/^0x/, ''); const len = Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64))); return Buffer.from(h.slice(byteOff * 2 + 64, byteOff * 2 + 64 + len * 2), 'hex').toString('utf8'); }
async function flapAgentWatch() {
  S.flapAgent = S.flapAgent || { total: null, names: {} };
  const p0 = await call(FLAP_READER, '0x8f82e165' + w(0) + w(1)); if (!p0) return;
  const total = Number(BigInt('0x' + p0.slice(2 + 128, 2 + 192)));
  if (S.flapAgent.total === null) { S.flapAgent.total = total; return; }
  for (let i = S.flapAgent.total; i < total; i++) {
    try {
      const pg = await call(FLAP_READER, '0x8f82e165' + w(i) + w(1)); const W5 = pg.slice(2).match(/.{64}/g); const off = Number(BigInt('0x' + W5[0])) / 32; const m = '0x' + W5[off + 1].slice(24);
      const st = await call(FLAP_READER, '0x51c023e2' + wa(m)); const SW = st.slice(2).match(/.{64}/g);
      const t0 = Number(BigInt('0x' + SW[0])) / 32, inner = t0 + Number(BigInt('0x' + SW[t0])) / 32;
      const name = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner])) / 32) * 32), sym = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner + 1])) / 32) * 32);
      const buyTax = Number(BigInt('0x' + SW[inner + 5])) / 100, sellTax = Number(BigInt('0x' + SW[inner + 6])) / 100, maxW = Number(BigInt('0x' + SW[inner + 11])) / 100;
      const quote = '0x' + SW[t0 + 1].slice(24); const qn = /^0x0{40}$/.test(quote) ? 'BNB' : FLAP_QUOTES[quote] || quote.slice(0, 10);
      const key = (sym || name).toLowerCase(); const dup = S.flapAgent.names[key]; S.flapAgent.names[key] = (dup || 0) + 1;
      const flags = []; if (buyTax + sellTax > 8) flags.push(`稅偏高 ${buyTax}%/${sellTax}%`); if (dup) flags.push('跟風同名（之前已有同名盤）'); if (/<|script|onerror|http/i.test(name + sym)) flags.push('⚠️ 名稱含可疑程式碼，別在網頁上點');
      const verdict = flags.length >= 2 ? '🔴 建議跳過' : flags.length === 1 ? '🟡 有疑點' : '🟢 首發、稅合理';
      if (!/^(flap|flapx)$/i.test(sym.trim())) { log(`Flap Agent 新盘 ${name}(${sym}) 是发射台代币，按规则不通知`); continue; }
      await tg(`🦋 Flap ID AGENT CURVE 新盤：${name.slice(0, 40)}（${sym.slice(0, 20)}）\n底池：${qn} · 稅 ${buyTax}%/${sellTax}% · 單錢包上限 ${maxW}%\n分析：${verdict}${flags.length ? '（' + flags.join('、') + '）' : ''}\n市場 ${m}\n要打的話手動處理「打 ${sym.slice(0, 20)}」和金額`);
    } catch (e) { log('flapAgent err ' + e.message); }
  }
  S.flapAgent.total = total;
}

// ---------- AI 錢包登入狀態 ----------
// ---------- 使用者確認：Agent ID 專屬的「付費」鑄造也自動打（有預算上限＋過濾）----------
// 使用者手動指定「直接打」的項目（不看 80% 與防釣魚，只受 20U 上限與模擬安全檢查）
const FORCE = new Set((CONFIG.forceMint || []).map((a) => a.toLowerCase())); // config.json 的 forceMint：手動指定直接打的合約
const PAID = {
  
  goPct: 0.8, maxUsd: 20, 
  maxBnbPerDay: CONFIG.paid?.maxBnbPerDay ?? 1e9,        // 使用者說不管怎樣就打 → 不設每日上限（只受錢包餘額限制）
  minSold: 30,              // 至少已經有 30 份被別人鑄過才跟（避開沒人理的／陷阱合約）
  maxAgeH: 168,              // 發現後 48 小時內還沒開就放棄
  keepBnb: CONFIG.paid?.keepBnb ?? 0.006,           // 錢包至少留這麼多 BNB 當 gas
};
const codeCache = new Map();
async function codeOf(a) { if (!codeCache.has(a)) codeCache.set(a, ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase()); return codeCache.get(a); }
async function bnbUsd() {
  const p = await call(FACTORY, '0xe6a43905' + wa(WBNB) + wa(USDT)); const pair = '0x' + (p || '').slice(26); const r = await call(pair, '0x0902f1ac'); const t0 = await call(pair, '0x0dfe1681');
  if (!r || !t0) return 0; const a = BigInt(r.slice(0, 66)), b = BigInt('0x' + r.slice(66, 130)); return t0.slice(26) === WBNB.slice(2) ? Number(b) / Number(a) : Number(a) / Number(b);
}
const tokStr = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return ''; } };
async function previewExec(W, to, data, valueWei, check) {
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', to, '--value', valueWei.toString(), '--inputData', data]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) throw new Error('預演失敗 ' + (p.j?.error?.message || p.t).slice(0, 120));
  const why = check(sim); if (why) throw new Error('預演不安全：' + why);
  const x = await W.baw(['contract-call', 'execute', '--requestId', rid]);
  if (!x.j?.success) throw new Error('送出失敗 ' + (x.j?.error?.message || x.t).slice(0, 120));
  await sleep(8000); return { tx: x.j.data?.txHash || '', sim };
}
async function poolOut(amtIn, from, to) { // 池子現在買得到多少（沒池子回 0）
  const r = await call(ROUTER, '0xd06ca61f' + w(amtIn) + w(64) + w(2) + wa(from) + wa(to)); if (!r || r.length < 2 + 64 * 4) return 0n; return BigInt('0x' + r.slice(2 + 64 * 3, 2 + 64 * 4));
}
const gotTok = (sim, W) => (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) > 0).reduce((a, b) => a + Number(b.change), 0);
// 鑄造進度：先找「已售／上限」這類函式；找不到就看「鑄造池剩多少幣」（合約剛部署時持有的幣 vs 現在）
const SOLD_SELS = ['a2309ff8', 'f4514d2e', '505e05fd', 'cc84efea', '192fc516', '9106d7ba', '67153ab4', 'f3f8a4fd', '06ed0717', '9659867e', '4f02c420', '1f21bfbf'];
const CAP_SELS = ['d8f93498', 'c65b61ca', '3a98ef39', 'b6b6f0c3', 'cce132d1', 'd5abeb01', '32cb6b0c', '06517a29', '2163837f', 'aa2d9a02', '76c71ca1', '98f1312e', '355274ea', '85e3f997'];
async function progressOf(c, code, tokAddr) {
  let sold = null, cap = null;
  for (const s of SOLD_SELS) { if (!code.includes(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { sold = Number(BigInt(r.slice(0, 66))); break; } }
  if (sold != null) for (const s of CAP_SELS) { if (!code.includes(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 10 && x >= sold && x < 1e12) { cap = x; break; } } }
  if (sold != null && cap) return { progress: sold / cap, sold, cap, how: '已售／上限' };
  S.prog = S.prog || {}; let pg = S.prog[c];
  const tok = tokAddr || c;
  if (!pg) {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const has = async (b) => (((await rpc('eth_getCode', [c, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2);
    let lo = head - 400000, hi = head; if (await has(lo)) { S.prog[c] = { none: 1 }; return { progress: 0, sold, cap }; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (await has(m)) hi = m; else lo = m; }
    let init = 0n; for (const b of [hi, hi + 1, hi + 5, hi + 20]) { const r = await rpc('eth_call', [{ to: tok, data: '0x70a08231' + wa(c) }, '0x' + b.toString(16)]).catch(() => null); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { init = BigInt(r.slice(0, 66)); break; } }
    pg = S.prog[c] = init > 0n ? { init: init.toString(), tok } : { none: 1 };
  }
  if (pg.none) return { progress: 0, sold, cap };
  const now = big(await call(pg.tok, '0x70a08231' + wa(c)));
  const init = BigInt(pg.init); return { progress: Number(init - now) / Number(init), sold, cap, how: '鑄造池剩餘' };
}

// ---------- 防「連續發盤釣魚」：同一份合約程式碼（換名字重複部署）24 小時內出現 3 次以上 → 視為批量發盤，付費／手續費一律不打 ----------
function codePrint(code) { const c = (code || '').toLowerCase().replace(/0x/, ''); return c.length + ':' + c.slice(0, 120) + c.slice(-120); }
function noteDeploy(code) { const fp = codePrint(code); S.fps = S.fps || {}; const now = Date.now(); const arr = (S.fps[fp] || []).filter((t) => now - t < 86400e3); arr.push(now); S.fps[fp] = arr.slice(-20); if (Object.keys(S.fps).length > 3000) S.fps = {}; return arr.length; }
function isSerial(code) { const arr = (S.fps || {})[codePrint(code)] || []; return arr.filter((t) => Date.now() - t < 86400e3).length >= 3; }

// ---------- 第三層：查項目方底細 ----------
async function deployerOf(c) {
  S.deployer = S.deployer || {}; if (S.deployer[c]) return S.deployer[c];
  const ow = await call(c, '0x8da5cb5b'); if (ow && ow.length >= 66 && BigInt(ow.slice(0, 66)) > 0n) return (S.deployer[c] = '0x' + ow.slice(26, 66));
  return '';
}
async function freshWallet(a) { // 部署者是不是大約 8 小時內才開始用的新錢包（查不到就當不是）
  try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const old = await rpc('eth_getTransactionCount', [a, '0x' + (head - 60000).toString(16)]); const now = await rpc('eth_getTransactionCount', [a, 'latest']); return parseInt(old, 16) === 0 && parseInt(now, 16) < 50; } catch { return false; }
}
// 重複 DEV：同一個部署者 24 小時內發 3 個以上 Agent ID 項目 → 硬性不鑄造（免費、手續費、付費全部）
function noteDev(dep, c) { if (!dep) return; S.devs = S.devs || {}; const now = Date.now(); const arr = (S.devs[dep] || []).filter((x) => now - x.t < 86400e3 && x.c !== c); arr.push({ t: now, c }); S.devs[dep] = arr.slice(-30); if (Object.keys(S.devs).length > 5000) S.devs = {}; }
function isRepeatDev(dep) { return !!dep && ((S.devs || {})[dep] || []).filter((x) => Date.now() - x.t < 86400e3).length >= 3; }
function blacklist(dep, why) { if (!dep) return; S.black = S.black || {}; if (!S.black[dep]) { S.black[dep] = { at: ts(), why }; log(`黑名單：${dep}（${why}）`); } }

async function paidLoop() {
  S.paid = S.paid || {}; S.dyn = S.dyn || []; S.paidSpend = S.paidSpend || {};
  const today = new Date().toDateString(); if (S.paidSpend.day !== today) S.paidSpend = { day: today };
  let price = 0;
  for (const c of FORCE) if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {} };
  if (!S.migrated2) { S.migrated2 = 1; for (const c of Object.keys(S.seenMints || {})) { if (S.paid[c]) continue; const cd = await codeOf(c); if ((cd.includes('e38fd349') && cd.includes('68bce8cd')) || (cd.includes('725c4058') && cd.includes('94bf804d'))) { S.paid[c] = { at: Date.now(), name: '', done: {} }; log('補登付費追蹤 ' + c); } } }
  // 進度 ≥40% 的（快滿的）每輪都看，不跟其他一百多個排隊；其餘輪流，每輪補到 16 個
  const all = Object.entries(S.paid);
  const hotP = all.filter(([c, P]) => FORCE.has(c) || (P.progress || 0) >= 0.4).filter(([c, P]) => !WALLETS.every((W) => P.done[W.name])).slice(0, 10);
  const rest = all.filter((e) => !hotP.includes(e)).sort((a, b) => (a[1].lastTry || 0) - (b[1].lastTry || 0)).slice(0, Math.max(6, 16 - hotP.length));
  const ents = hotP.concat(rest);
  for (const [c, P] of ents) {
    P.lastTry = Date.now(); if (WALLETS.every((W) => P.done[W.name])) { delete S.paid[c]; continue; }
    if (Date.now() - P.at > PAID.maxAgeH * 3600e3) { delete S.paid[c]; continue; }
    const code = await codeOf(c);
    // 發現時還沒開的「免費」鑄造：之後每分鐘重試，一開就自動打
    for (const W of WALLETS) { if (P.done[W.name]) continue; { const ff = await findFree(W.addr, c, code); if (!ff) continue; const n = ff.n; const m = await autoMintMax(c, n, W, ff.v); P.done[W.name] = 'free'; await tg(`🆕 [${W.name}] 之前還沒開的 Agent ID 項目 ${P.name || c.slice(0, 10)} 現在開了（免費）\n${m}`); } }
    let kind = code.includes('e38fd349') && code.includes('68bce8cd') ? 'bnb' : code.includes('725c4058') && code.includes('94bf804d') ? 'usdt' : null;
    let unit = 0n; // 一般 NFT：mint(數量) 付「單價 × 數量」BNB（像 Sentient Syndicate 的 PRICE）
    if (!kind && code.includes('a0712d68')) for (const sel of ['8d859f3e', 'a035b1fe', '6817c76c', '13faede6', '817b1cd2']) { if (!code.includes(sel)) continue; const r = await call(c, '0x' + sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { unit = BigInt(r.slice(0, 66)); kind = 'gen'; break; } }
    if (!kind && P.recvValue) kind = 'recv';
    if (!kind && P.replay) kind = 'replay'; // 少見的鑄造函式：照別人的呼叫內容與金額打（第一原則：進度 ≥80% 就打）
    if (!kind) continue;
    const soldR = await call(c, kind === 'bnb' ? '0xa2309ff8' : kind === 'gen' ? '0x18160ddd' : '0x192fc516'); const sold = soldR && soldR.length >= 66 ? Number(BigInt(soldR.slice(0, 66))) : null;
    let cap = null; for (const sel of ['0xd8f93498', '0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0x3a1d8d3a', '0xf1aee5a2', '0x85e3f997']) { const r = await call(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && sold != null && x >= sold && x < 1e12) { cap = x; break; } } }
    let tokAddr0 = ''; { const tr0 = await call(c, '0xfc0c546a'); if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tokAddr0 = '0x' + tr0.slice(26, 66); }
    let progress = cap && sold != null ? sold / cap : 0, how = '已售／上限';
    if (!(progress > 0)) { const pr = await progressOf(c, code, tokAddr0); progress = pr.progress || 0; how = pr.how || ''; }
    P.progress = progress;
    price = price || (await bnbUsd());
    const forced = FORCE.has(c);
    if (!forced && progress < PAID.goPct) continue;
    // 防釣魚：① 同款合約 24 小時內被部署 3 次以上（批量發盤）不打 ② 進度要是很多人打出來的（至少 20 個不同錢包），不是項目方自己刷的
    if (!forced) { const dep = await deployerOf(c); P.deployer = dep;
      if (dep && !(S.devs?.[dep] || []).some((x) => x.c === c)) noteDev(dep, c);
      if (isRepeatDev(dep)) { if (!P.devLogged) { P.devLogged = 1; log(`跳過 ${c}：重複 DEV ${dep}（24 小時內發了 ${(S.devs[dep] || []).length} 個項目）`); } continue; }
      if (dep && S.black?.[dep]) { if (!P.blackLogged) { P.blackLogged = 1; log(`跳過 ${c}：部署者 ${dep} 在黑名單（${S.black[dep].why}）`); } continue; }
      if (dep && P.fresh == null) P.fresh = await freshWallet(dep);
      if (P.fresh) { if (!P.freshLogged) { P.freshLogged = 1; log(`跳過 ${c}：部署者 ${dep} 是剛建立的新錢包`); } continue; }
      // 錢流：合約裡幾乎沒留 BNB、也還沒開池 → 錢多半直接流進項目方錢包，要求更多人打過（40 個）才算可信
      if (P.drain == null) { const cb = Number(BigInt((await rpc('eth_getBalance', [c, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18; const pr = tokAddr0 || c; const pair = await call(FACTORY, '0xe6a43905' + wa(pr) + wa(WBNB)); P.drain = cb < 0.01 && !(pair && BigInt(pair) > 0n); }
    }
    // 使用者定：只打新的 → 兩天前就部署的老合約不打
    if (!forced) { if (P.old == null) { const head = parseInt(await rpc('eth_blockNumber', []), 16); const o = await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x'); P.old = !!o && o.length > 2; } if (P.old) { for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'old'; continue; } }
    // 已經開池交易的項目不再自動鑄造（鑄造≈用市價買，不划算）
    if (!forced) { const tk = tokAddr0 || c; let opened = false; for (const q of [WBNB, USDT]) { const pr = await call(FACTORY, '0xe6a43905' + wa(tk) + wa(q)); if (pr && BigInt(pr) > 0n) { const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n) { opened = true; break; } } } if (opened) { for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'pool-open'; log(`跳過 ${c}：已經開池交易，不再鑄造`); continue; } }
    if (!forced && isSerial(code)) { if (!P.serialLogged) { P.serialLogged = 1; log(`跳過 ${c}：同款合約 24 小時內部署 3 次以上，疑似批量發盤`); } continue; }
    if (!forced) { const need = P.drain ? 40 : 20; const seen = Math.max(P.wallets || 0, HOT.get(c)?.from.size || 0); if (seen < need) { const r = await rpc('eth_getLogs', [{ address: tokAddr0 || c, fromBlock: '0x' + (parseInt(await rpc('eth_blockNumber', []), 16) - 3000).toString(16), toBlock: 'latest', topics: [T_TRANSFER] }]).catch(() => []); const uniq = new Set((r || []).map((l) => l.topics[2])).size; P.wallets = Math.max(P.wallets || 0, uniq); if (uniq < need) continue; } } // 還沒到 80%（或讀不到進度）→ 先不打，之後每分鐘再看
    const limitUsd = Infinity;
    let tokAddr = ''; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66) tokAddr = '0x' + tr.slice(26, 66);
    const sym = tokAddr ? tokStr(await call(tokAddr, '0x95d89b41')) || P.name || c.slice(0, 8) : P.name || c.slice(0, 8);
    for (const W of WALLETS) {
      if (P.done[W.name]) continue;
      try {
        price = price || (await bnbUsd());
        const spent = S.paidSpend[W.name] || 0;
        const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
        let n = 10, costWei = 0n;
        if (kind === 'replay') {
          const v = BigInt(P.replay.value || '0'); const vb = Number(v) / 1e18;
          if (!price || vb * price > PAID.maxUsd || vb * 1.005 > bal - PAID.keepBnb) continue;
          try { await rpc('eth_call', [{ from: W.addr, to: c, data: P.replay.data, value: '0x' + v.toString(16) }, 'latest']); } catch { if (!P.replayFailLogged) { P.replayFailLogged = 1; log(`跳過 ${c}（${sym}）：進度 ${Math.round(progress * 100)}% 但照別人的方式鑄造會失敗（多半是白名單或後端簽名，只有特定錢包能打）`); } continue; }
          const r = await previewExec(W, c, P.replay.data, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的鑄造方式）\n花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}`);
          continue;
        }
        if (kind === 'recv') {
          const v = BigInt(P.recvValue); const vb = Number(v) / 1e18;
          if (!price || vb * price > PAID.maxUsd || vb * 1.005 > bal - PAID.keepBnb) continue;
          try { await rpc('eth_call', [{ from: W.addr, to: c, value: '0x' + v.toString(16) }, 'latest']); } catch { continue; } // 不能鑄（沒資格、已打過、額度滿）
          const r = await previewExec(W, c, '0x', v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          });
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          const ta = tokAddr0 || c; if (!S.dyn.some((t) => t.addr === ta && t.only === W.addr)) S.dyn.push({ sym, addr: ta, cost: +(vb * price).toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          await tg(`🛒 [${W.name}] 自動打了「轉 BNB 鑄造」項目：${sym}\n轉 ${vb} BNB（約 ${(vb * price).toFixed(1)}U，${P.recvSeen} 個錢包都轉這個金額）· 進度約 ${Math.round(progress * 100)}%（${how}）\n${c}\n交易 ${r.tx}`);
          continue;
        }
        if (kind === 'gen') {
          let data = '';
          for (; n >= 1; n--) { costWei = unit * BigInt(n); if ((Number(costWei) / 1e18) * 1.005 > bal - PAID.keepBnb || !price || (Number(costWei) / 1e18) * price > PAID.maxUsd) continue; data = '0xa0712d68' + w(n); try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + costWei.toString(16) }, 'latest']); break; } catch {} }
          if (n < 1) continue;
          const r = await previewExec(W, c, data, costWei, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 BNB 以外或超過價格';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          const vb = Number(costWei) / 1e18; S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度 ${sold ?? '?'}／${cap ?? '?'}\n${c}\n交易 ${r.tx}`);
          continue;
        }
        if (kind === 'bnb') {
          for (; n >= 1; n--) { const q = await call(c, '0x68bce8cd' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && (Number(costWei) / 1e18) * 1.005 <= bal - PAID.keepBnb && price && (Number(costWei) / 1e18) * price <= PAID.maxUsd) break; } // 買得起的最多份數（留 gas）
          if (n < 1) continue; // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
          const v = (costWei * 1005n) / 1000n, vb = Number(v) / 1e18;
          if (spent + vb > PAID.maxBnbPerDay || bal - vb < PAID.keepBnb) continue;
          const data = '0xe38fd349' + w(n) + wa('0x0000000000000000000000000000000000000000') + w(v);
          try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + v.toString(16) }, 'latest']); } catch { continue; } // 還沒開或沒資格
          const pool = tokAddr ? Number(await poolOut(v, WBNB, tokAddr)) : 0;
          const r = await previewExec(W, c, data, v, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（第一原則：進度 ≥80% 照打）`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外的資產或超過報價';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          });
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          const usd = vb * price; if (tokAddr) S.dyn.push({ sym, addr: tokAddr, cost: +usd.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now(), ...(FORCE.has(c) ? { hold: true } : {}) }); // 使用者指定的項目照免費幣處理：只通知不自動賣
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${usd.toFixed(1)}U）· 已售 ${sold ?? '?'} 份\n${c}\n交易 ${r.tx}\n已加入監控：3 倍回本、5 倍和 10 倍各賣一半、回落 60% 全賣`);
        } else {
          for (; n >= 1; n--) { const q = await call(c, '0x725c4058' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && price && ((Number(costWei) / 1e18) * 1.03) / price <= bal - PAID.keepBnb && Number(costWei) / 1e18 <= PAID.maxUsd) break; }
          if (n < 1) continue; // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
          const cu = Number(costWei) / 1e18, needBnb = (cu * 1.03) / price;
          if (!price || spent + needBnb > PAID.maxBnbPerDay || bal - needBnb < PAID.keepBnb) continue;
          const data = '0x94bf804d' + w(n) + wa('0x0000000000000000000000000000000000000000');
          let ub = big(await call(USDT, '0x70a08231' + wa(W.addr)));
          if (ub < costWei) {
            const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', needBnb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]);
            if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 100));
            for (let i = 0; i < 30 && ub < costWei; i++) { await sleep(3000); ub = big(await call(USDT, '0x70a08231' + wa(W.addr))); }
            if (ub < costWei) throw new Error('USDT 沒到帳');
          }
          await previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(costWei), 0n, (sim) => ((sim?.allowanceChanges || []).some((a) => String(a.spender).toLowerCase() !== c) ? '授權對象不對' : ''));
          const pool = tokAddr ? Number(await poolOut(costWei, USDT, tokAddr)) : 0;
          const r = await previewExec(W, c, data, 0n, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（第一原則：進度 ≥80% 照打）`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => String(b.contractAddress).toLowerCase() !== USDT) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 USDT 以外或超過報價';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          });
          S.paidSpend[W.name] = spent + needBnb; P.done[W.name] = 'minted';
          if (tokAddr) S.dyn.push({ sym, addr: tokAddr, cost: +cu.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${cu.toFixed(2)} USDT（由 BNB 換）· 已售 ${sold ?? '?'} 份\n${c}\n交易 ${r.tx}\n已加入監控：3 倍回本、5 倍和 10 倍各賣一半、回落 60% 全賣`);
        }
      } catch (e) { if (e.message.includes('已開池')) { P.done[W.name] = 'pool-cheaper'; log(`paid ${c} ${W.name} ${e.message}`); continue; } P.fail = (P.fail || 0) + 1; log(`paid ${c} ${W.name} ${e.message}`); if (P.fail >= 6) { P.done[W.name] = 'fail'; await tg(`⚠️ [${W.name}] 付費項目 ${sym} 自動打失敗，已放棄：${e.message.slice(0, 150)}\n${c}`); } }
    }
  }
}

async function loginCheck() {
  for (const W of WALLETS) {
    const r = await W.baw(['wallet', 'status'], 60000);
    if (r.j?.data?.status === 'CONNECTED') {
      // 開發者模式到期提醒（到期前 24 小時內提醒一次）
      const st = await W.baw(['wallet', 'settings'], 60000); const exp = Date.parse(st.j?.data?.devMode?.expiresAt || '');
      S.devAlert = S.devAlert || {};
      if (exp && exp - Date.now() < 24 * 3600e3 && S.devAlert[W.name] !== exp) { S.devAlert[W.name] = exp; await tg(`⏰ ${W.name} 的開發者模式將在 ${new Date(exp).toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' })} 到期\n到期後自動鑄造／自動賣出會停，請在那個帳號的幣安 App → Agentic Wallet → 設定 重新開啟開發者模式`); }
      if (st.j?.data?.devMode && st.j.data.devMode.enabled === false && S.devAlert[W.name + ':off'] !== 1) { S.devAlert[W.name + ':off'] = 1; await tg(`⚠️ ${W.name} 的開發者模式已關閉，自動操作會失敗，請在 App 重新開啟`); }
      if (st.j?.data?.devMode?.enabled) S.devAlert[W.name + ':off'] = 0;
      continue;
    }
    S.lastLoginAlert = S.lastLoginAlert && typeof S.lastLoginAlert === 'object' ? S.lastLoginAlert : {};
    if (Date.now() - (S.lastLoginAlert[W.name] || 0) < 6 * 3600e3) continue;
    S.lastLoginAlert[W.name] = Date.now();
    const si = await W.baw(['auth', 'signin'], 60000); const url = si.j?.data?.urlForWeb, code = si.j?.data?.pairingCode, id = si.j?.data?.qrCodeId;
    await tg(`🔑 ${W.name} 的 AI 錢包登入過期了，這個錢包的自動鑄造／自動賣出會暫停。\n${url ? '用「' + W.name + '」那個幣安帳號的手機點這個連結確認（約 5 分鐘內有效）：\n' + url + '\n配對碼 ' + code : '請執行 login 腳本重新登入'}`);
    if (id) { const v = await W.baw(['auth', 'verify', '--qrCodeId', id], 330000); if (v.j?.data?.status === 'SUCCESS') await tg(`✅ ${W.name} 重新登入成功`); }
  }
}


const ELEMENT_EX = '0xb3e3dfcb2d9f3dde16d78b9e6eb3538eb32b5ae1';
const T_721_FILLED = '0x9c248aa1a265aa616f707b979d57f4529bb63a4fc34dc7fc61fdddc18410f74e'; // Element ERC721SellOrderFilled
async function nftVolWatch() {
  S.nftCols = S.nftCols || {}; S.nftVol = S.nftVol || {};
  if (!S.nftColsBackfilled) { // 第一次：從日誌補回之前打到的 NFT 系列
    try { for (const l of readFileSync(LOG, 'utf8').split('\n')) { if (!l.includes('已自動鑄造') || !l.includes('NFT')) continue; const m = l.match(/\] (0x[a-fA-F0-9]{40}) /); if (m) S.nftCols[m[1].toLowerCase()] = 1; } } catch {}
    S.nftColsBackfilled = true;
  }
  const head = parseInt(await rpc('eth_blockNumber', []), 16), from = head - 96000; // 約 12 小時
  // 1) Element 成交（一次抓完再按系列分）
  const fills = {};
  for (let b = from; b <= head; b += 10000) {
    const L = await rpc('eth_getLogs', [{ address: ELEMENT_EX, topics: [T_721_FILLED], fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 9999, head).toString(16) }]).catch(() => []);
    for (const l of L || []) { const w = l.data.slice(2).match(/.{64}/g) || []; const col = '0x' + (w[7] || '').slice(24); if (!S.nftCols[col]) continue; const isBnb = (w[4] || '').endsWith('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'); const px = Number(BigInt('0x' + (w[5] || '0'))) / 1e18; (fills[col] = fills[col] || []).push(isBnb ? px : null); }
    await sleep(200);
  }
  // 2) 各系列轉手次數（不含新鑄造）＋我們持有幾張
  for (const col of Object.keys(S.nftCols)) {
    let moves = 0;
    for (let b = from; b <= head; b += 50000) { const L = await rpc('eth_getLogs', [{ address: col, topics: [T_TRANSFER], fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 49999, head).toString(16) }]).catch(() => []); for (const l of L || []) if (l.topics.length === 4 && !/^0x0+$/.test(l.topics[1])) moves++; }
    let held = 0; for (const W of WALLETS) { const r = await call(col, '0x70a08231' + wa(W.addr)); if (r && r.length >= 66) held += Number(BigInt(r.slice(0, 66))); }
    const f = fills[col] || [], prev = S.nftVol[col];
    const px = f.filter((x) => x != null), vol = px.reduce((a, b) => a + b, 0);
    const hot = held > 0 && px.length >= 3 && vol > 0 && (prev ? px.length >= 2 * (prev.f || 0) : px.length >= 5); // 只看真的有付錢的成交（使用者 15:22：轉來轉去不算）
    if (hot) {
      const name = tokStr(await call(col, '0x06fdde03')) || col.slice(0, 10);
      await tg(`🦋 NFT 成交量變多：${name}\n我們兩個錢包共持有 ${held} 張\n過去 12 小時 Element 成交 ${f.length} 筆${prev ? '（上次 ' + (prev.f || 0) + ' 筆）' : ''}${px.length ? `，成交價 ${Math.min(...px).toFixed(4)}～${Math.max(...px).toFixed(4)} BNB，合計 ${vol.toFixed(4)} BNB` : ''}\n轉手 ${moves} 次${prev ? '（上次 ' + (prev.t || 0) + ' 次）' : ''}\n${col}\nhttps://element.market/assets/bsc/${col}/1\n要掛單或賣手動處理`);
    }
    S.nftVol[col] = { f: f.length, t: moves, held, at: ts() };
    await sleep(150);
  }
  log(`NFT 成交量檢查完成：${Object.keys(S.nftCols).length} 個系列`);
}

// ── TG 指令：使用者直接在機器人打「賣 VARC」「賣 VARC 一半」「餘額」，幾秒內執行，不經過 Claude ──
async function tgSay(text) { if (!TG) return; log('TG回覆: ' + text.replace(/\n/g, ' | ')); try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {} }
function findTok(q, W) {
  q = q.toLowerCase();
  return TOKENS.concat(S.dyn || []).find((t) => (!t.only || t.only === W.addr) && (t.sym.toLowerCase() === q || t.addr === q));
}
async function cmdSell(q, half) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const jobs = WALLETS.map(async (W) => {
    const t0 = findTok(q, W); if (!t0) return `[${W.name}] 找不到 ${q}`;
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr))); if (bal === 0n) return `[${W.name}] 沒有 ${t0.sym}`;
    const key = W.addr === ME ? t0.sym : W.name + ':' + t0.sym;
    const st = (S.tokens[key] = S.tokens[key] || { hist: [], peak: 0, peakAt: 0, sold: 0 });
    const ok = await sell(t0, st, half ? bal / 2n : bal, half ? '你在 TG 指示賣一半' : '你在 TG 指示全部賣出', W);
    if (ok && !half) { st.stage = 9; st.done = true; }
    return ok ? null : `[${W.name}] ${t0.sym} 賣出失敗`;
  });
  const errs = (await Promise.all(jobs)).filter(Boolean); save();
  if (errs.length) await tgSay('⚠️ ' + errs.join('\n'));
  void head;
}
async function cmdBalance() {
  const lines = await Promise.all(WALLETS.map(async (W) => { const b = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18; return `${W.name}：${b.toFixed(5)} BNB`; }));
  await tgSay('💼 錢包餘額\n' + lines.join('\n'));
}
async function cmdHold() {
  const out = [];
  for (const W of WALLETS) for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr))); if (bal === 0n) continue;
    const v = await valueUsd(t0, bal).catch(() => null); const line = `[${W.name}] ${t0.sym}：${v == null ? '還沒有池子' : '約 ' + v.toFixed(2) + 'U'}`;
    if (!out.includes(line)) out.push(line);
  }
  await tgSay('📦 還沒賣的幣\n' + (out.length ? out.join('\n') : '沒有') + '\n（NFT 不在這裡，NFT 成交量變多會另外通知）');
}
async function cmdStats() {
  const free = new Set(); let paid = 0;
  try { for (const l of readFileSync(LOG, 'utf8').split('\n')) { if (l.includes('🛒')) paid++; if (!l.includes('已自動鑄造') || /重播0x(（| \||$)/.test(l)) continue; const m = l.match(/項目\s*([^\n（(|]+?)\s*現在開了/) || l.match(/\] (0x[a-fA-F0-9]{40}) /); if (m) free.add(m[1].toLowerCase()); } } catch {}
  const tr = S.trades || [], by = {};
  for (const x of tr) { const k = x.sym; by[k] = by[k] || { usd: 0, n: 0 }; by[k].usd += x.usd; by[k].n++; }
  const px = await bnbUsd().catch(() => 0); let tot = 0; for (const W of WALLETS) tot += Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
  const lines = Object.entries(by).map(([k, v]) => `${k}：賣 ${v.n} 筆，拿回約 ${v.usd.toFixed(2)}U`);
  await tgSay(`📊 戰績\n自動打的免費項目：約 ${free.size} 個\n付費打的：${paid} 筆\n${lines.length ? '有記錄的賣出：\n' + lines.join('\n') + '\n' : ''}兩個錢包現在共 ${tot.toFixed(4)} BNB（約 ${(tot * px).toFixed(2)}U）`);
}
async function tgCmdLoop() {
  if (!TG) return;
  if (S.tgOff == null) { try { const r = await (await fetch(`https://api.telegram.org/bot${TG.a}/getUpdates?timeout=0`)).json(); const u = r.result || []; S.tgOff = u.length ? u[u.length - 1].update_id + 1 : 0; save(); } catch { S.tgOff = 0; } }
  for (;;) {
    try {
      const r = await (await fetch(`https://api.telegram.org/bot${TG.a}/getUpdates?timeout=25&offset=${S.tgOff}`, { signal: AbortSignal.timeout(35000) })).json();
      for (const u of r.result || []) {
        S.tgOff = u.update_id + 1; save();
        const m = u.message; if (!m || String(m.chat?.id) !== String(TG.b) || !m.text) continue; // 只聽使用者本人
        if (Date.now() / 1000 - m.date > 120) continue; // 太舊的指令不執行
        const txt = m.text.trim().replace(/^\//, '');
        let mm;
        if ((mm = txt.match(/^(?:賣|卖|sell)\s*(\S+?)\s*(一半|半|half)?$/i)) || (mm = txt.match(/^(\S+?)\s*(?:全出|全賣|全卖)$/i))) {
          const half = !!mm[2]; await tgSay(`⚡ 收到，${mm[1]} 兩個錢包${half ? '各賣一半' : '全部賣出'}中…`);
          cmdSell(mm[1], half).catch((e) => tgSay('⚠️ 賣出出錯：' + e.message));
        } else if ((mm = txt.match(/^(\S+?)\s*(?:出一半|賣一半|卖一半)$/i))) {
          await tgSay(`⚡ 收到，${mm[1]} 兩個錢包各賣一半中…`); cmdSell(mm[1], true).catch((e) => tgSay('⚠️ 賣出出錯：' + e.message));
        } else if (/^(餘額|余额|錢包|钱包|balance)$/i.test(txt)) { cmdBalance().catch(() => {}); }
        else if (/^(持倉|持仓|holdings?)$/i.test(txt)) { cmdHold().catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(戰績|战绩|統計|统计|stats?)$/i.test(txt)) { cmdStats().catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(help|指令|說明|说明)$/i.test(txt)) await tgSay('可用指令：\n賣 VARC → 兩個錢包全賣\n賣 VARC 一半 → 各賣一半\n（也可打「VARC 全出」「VARC 出一半」）\n餘額 → 看兩個錢包 BNB\n持倉 → 還沒賣的幣和現值\n戰績 → 上線以來打了多少、賣了多少');
      }
    } catch { await sleep(3000); }
  }
}

let lastLoopAt = Date.now();
setInterval(() => { if (Date.now() - lastLoopAt > 8 * 60e3) { log('看門狗：主迴圈卡住超過 8 分鐘，自動重啟'); try { save(); } catch {} process.exit(1); } }, 30e3).unref();
async function main() {
  log('启动监测');
  tgCmdLoop().catch((e) => log('tgCmd ' + e.message));
  let lastHold = 0, lastLogin = 0;
  for (;;) {
    try { if (statSync(SELF).mtimeMs !== SELF_MT) { log('程序更新，重启'); save(); process.exit(0); } } catch {}
    if (existsSync(join(DIR, 'WATCH_STOP'))) { log('WATCH_STOP，退出'); save(); process.exit(0); }
    try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      await scanNew(head);
      if (Date.now() - lastHold > 5000) { lastHold = Date.now(); await holdings(head); } else if (Object.values(S.tokens).some((st) => st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done)) await holdings(head, true); // 速戰幣每秒看
      if (!globalThis._flapAt || Date.now() - globalThis._flapAt > 30e3) { globalThis._flapAt = Date.now(); await flapAgentWatch().catch((e) => log('flap ' + e.message)); }
      if (!globalThis._toshAt || Date.now() - globalThis._toshAt > 60e3) { globalThis._toshAt = Date.now(); await toshWatch().catch((e) => log('tosh ' + e.message)); }
      if (!globalThis._aidropAt || Date.now() - globalThis._aidropAt > 120e3) { globalThis._aidropAt = Date.now(); await aidropWatch(head); }
      if (!globalThis._paidBusy && (!globalThis._paidAt || Date.now() - globalThis._paidAt > 60e3)) { globalThis._paidAt = Date.now(); globalThis._paidBusy = true; paidLoop().catch((e) => log('paidLoop ' + e.message)).finally(() => { globalThis._paidBusy = false; }); } // 背景跑，不卡住掃描
      if (!globalThis._smartBusy && Date.now() - (S.smartAt || 0) > 6 * 3600e3) { S.smartAt = Date.now(); globalThis._smartBusy = true; buildSmart().catch((e) => log('smart ' + e.message)).finally(() => { globalThis._smartBusy = false; }); }
      if (!globalThis._nftBusy && Date.now() - (S.nftVolAt || 0) > 12 * 3600e3) { S.nftVolAt = Date.now(); globalThis._nftBusy = true; nftVolWatch().catch((e) => log('nftVol ' + e.message)).finally(() => { globalThis._nftBusy = false; }); } // 12 小時看一次 NFT 成交量（背景）
      if (Date.now() - lastLogin > 600e3) { lastLogin = Date.now(); loginCheck().catch(() => {}); }
      lastLoopAt = Date.now(); save(); writeFileSync(join(DIR, 'data', 'watch_heartbeat.txt'), ts() + ' 掃描落後 ' + (S.scanLag ?? '?') + ' 塊');
      if ((S.scanLag || 0) > 1500 && Date.now() - (S.lagAlert || 0) > 3600e3) { S.lagAlert = Date.now(); await tg(`⚠️ 新合約掃描落後 ${S.scanLag} 個區塊（約 ${Math.round(S.scanLag * 0.45 / 60)} 分鐘），可能是公用節點變慢，手動處理`); }
    } catch (e) { log('出错 ' + e.message); }
    await sleep(1000);
  }
}
process.on('uncaughtException', (e) => log('uncaught ' + e.message));
process.on('unhandledRejection', (e) => log('unhandled ' + (e?.message || e)));
main();
