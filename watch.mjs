// Agent ID Sniper — 幣安 Agentic Wallet（.ai Agent ID）專屬鑄造監控 + 自動鑄造 + 持倉自動止盈。
// 全部在本地跑：掃 BSC 新合約 → 模擬 → 用 baw CLI 自動打 → 開池後照規則自動賣 → Telegram 通知。不使用任何 AI。
// 停止：在同資料夾放 WATCH_STOP 檔。設定見 config.example.json。
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, existsSync, statSync, renameSync } from 'node:fs';
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
const isFreeMintNote = (t) => /^🆓/u.test(t) || (/^🆕/u.test(t) && t.includes('🤖 已自動鑄造'));
const important = (t) => !isFreeMintNote(t) && (/^(⏰|⚠️|🔑|💰|🔥|🚀|🦋|🏗|🛒)/u.test(t) || t.includes('不是免費')); 

const sendable = (t) => /^(💰|🛒|🔑|⏰|🦋)/u.test(t) || (CONFIG.notifyFree && isFreeMintNote(t)) /* 免費項目預設不發 TG，只算進戰績和每晚 9 點總結；config 設 notifyFree: true 會靜音發送 */ || (/^🚀/u.test(t) && (t.includes('開池') || t.includes('平台幣'))) || (/^🔥/u.test(t) && /\d+ 倍/.test(t) && !t.includes('搶打')) || (/^⚠️/u.test(t) && /(想賣但失敗|回調|回落|登入|開發者模式|打不了|自動打失敗|掃描落後|結果不明|BNB 快不夠|賣不出|貔貅|Flap)/.test(t));

const GROUP_ID = CONFIG.telegram?.groupChatId || ''; // 可選：也發到 TG 群（買入、開池、倍數、賣出）
const groupSent = new Map();
async function toGroup(text) { 
  if (!TG) return;
  let msg = '', key = '';
  const ca = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0] || '';
  
  if (/^🛒/u.test(text)) { const name = (text.match(/項目[：:]\s*([^\n（(|]+)/) || [])[1]?.trim() || ''; const pct = (text.match(/進度約?\s*(\d+)%/) || [])[1]; msg = `🎯 打了付费项目：${name || '新项目'}${pct ? `（铸造进度约 ${pct}%）` : ''}\n合约：${ca}`; key = 'mint:' + ca.toLowerCase(); }
  if (!msg || !ca) return;
  const now = Date.now(); if (groupSent.has(key) && now - groupSent.get(key) < 6 * 3600e3) return; groupSent.set(key, now);
  try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text: '📡 Agent ID 播报\n' + msg, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function freeProgWatch() { // 免費項目也看鑄造進度（已鑄造／總量），過 70% 播報到群
  S.freeTrack = S.freeTrack || {};
  for (const [c, F] of Object.entries(S.freeTrack)) {
    if (Date.now() - F.at > 72 * 3600e3 || F.done) { delete S.freeTrack[c]; continue; }
    const tsR = await call(c, '0x18160ddd'); if (!tsR || tsR.length < 66) { F.done = 1; continue; } const sup = Number(BigInt(tsR.slice(0, 66)));
    let max = 0; for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2']) { const r = await call(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x >= sup && x < 1e15) { max = x; break; } } }
    if (!max) { F.miss = (F.miss || 0) + 1; if (F.miss >= 3) F.done = 1; continue; } // 讀不到總量的就不追了
    const pct = sup / max, prev = F.p; F.p = pct;
    if (pct >= 0.7 && (prev != null ? prev < 0.7 : Date.now() - F.at < 3600e3)) { const nm = tokStr(await call(c, '0x06fdde03')) || ''; await groupProgress(c, nm, pct); }
    if (pct >= 1) F.done = 1;
    await sleep(100);
  }
}
async function groupProgress(c, name, pct) { // 任何項目（免費或付費、有沒有打都算）鑄造進度第一次超過 70% → 播報到群，同一個項目只發一次
  S.g70 = S.g70 || {}; if (!TG || !GROUP_ID || S.g70[c]) return;
  try { const d = S.deployer?.[c] || (await deployerOf(c)); if (d && (S.black?.[d] || S.paid?.[c]?.drain)) { S.g70[c] = 'skip'; return; } } catch {} /* 審查修正：黑名單/抽走過資金的開發者，不推給群 */
  S.g70[c] = ts();
  const text = `📡 Agent ID 播报\n🔥 ${name || '新项目'} 铸造进度已超过 70%（目前 ${Math.round(pct * 100)}%）\n合约：${c}`;
  log('群播報: ' + text.replace(/\n/g, ' | '));
  try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function riskNote(c) { /* 新功能：看合約有沒有「增發／暫停／黑名單／改稅」這類開發者權限，只提醒不擋 */
  try { const code = (await rpc('eth_getCode', [c, 'latest'])) || ''; if (code.length < 10) return '';
    const has = (sels) => sels.some((x) => code.includes('63' + x)); const f = [];
    if (has(['40c10f19'])) f.push('可增發');
    if (has(['8456cb59', '02329a29'])) f.push('可暫停交易');
    if (has(['f9f92be4', '44337ea1', '0ecb93c0', '1a895266'])) f.push('有黑名單');
    if (has(['8c0b5e22', 'c0246668', '5342acb4', 'aa4b6fca', '061c82d0'])) f.push('可改稅/限額');
    if (!f.length) return ''; const ow = await call(c, '0x8da5cb5b'); if (ow && BigInt(ow.slice(0, 66)) === 0n) return '';
    return '\n⚠️ 合約權限提醒：' + f.join('、') + '（開發者還沒放棄權限）';
  } catch { return ''; } }
async function honeypotCheck(W, t, st, bal) { /* 新功能：開池時模擬「把幣轉進池子」（賣出第一步），轉不過去很可能是貔貅 */
  if (st.hpChecked || !st.pair || !(bal > 0n)) return; st.hpChecked = 1;
  try { await rpc('eth_call', [{ from: W.addr, to: t.addr, data: '0xa9059cbb' + wa(st.pair) + w(bal / 100n || 1n) }, 'latest']); }
  catch (e) { await tg(`⚠️ [${W.name}] ${t.sym} 開池了，但模擬賣出失敗，可能是貔貅（只能買不能賣），自動賣出可能會失敗\n${t.addr}`); }
}
async function flapApprovalWatch() { /* 每 10 分鐘查一次錢包授權：有授權給 Flap 就立刻取消並通知（換幣路由可能自己產生授權） */
  for (const W of WALLETS) { const r = await W.baw(['approvals', 'list', '--limit', '100']); const L = r.j?.data?.list || [];
    for (const x of L) { const sp = String(x.spender || '').toLowerCase(); if (!FLAP_BLOCK.has(sp) && !/flap/i.test(String(x.spenderName || ''))) continue;
      const rv = await W.baw(['approvals', 'revoke', '--binanceChainId', '56', '--tokenContract', x.tokenContract, '--spender', x.spender, '--type', x.type || 'approve']);
      await tg(`⚠️ [${W.name}] 發現授權給 Flap（${x.tokenSymbol || x.tokenContract}），${rv.j?.success ? '已自動取消' : '自動取消失敗，請手動取消：' + (rv.j?.error?.message || rv.t).slice(0, 80)}`); } }
}
async function lowBnbWatch() { /* 新功能：BNB 快不夠付 gas 時提醒（每個錢包 6 小時最多一次） */
  S.lowBnbAt = S.lowBnbAt || {};
  for (const W of WALLETS) { const b = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
    if (b < PAID.keepBnb + 0.02 && Date.now() - (S.lowBnbAt[W.name] || 0) > 6 * 3600e3) { S.lowBnbAt[W.name] = Date.now(); await tg(`⚠️ [${W.name}] BNB 快不夠了：剩 ${b.toFixed(4)} BNB，可能付不出 gas，免費項目也會打不了，請補一點 BNB`); } }
}
function pruneState() { /* 審查修正：狀態檔定期瘦身，避免越來越大、越存越慢 */
  const cut = (o, max) => { const k = Object.keys(o || {}); if (k.length > max) for (const x of k.slice(0, k.length - max)) delete o[x]; };
  cut(S.seenMints, 30000); cut(S.g70, 3000); cut(S.deployer, 20000);
  if (S.trades?.length > 1000) S.trades = S.trades.slice(-1000);
  for (const st of Object.values(S.tokens || {})) if (st.holders) cut(st.holders, 20000);
}
async function dailyReport() { /* 新功能：每天晚上 9 點（台北）自動發戰績＋持倉 */
  const tp = new Date(Date.now() + 8 * 3600e3); const day = tp.toISOString().slice(0, 10);
  if (tp.getUTCHours() !== 21 || S.dailyAt === day) return; S.dailyAt = day; save();
  let um = 0; try { const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '/'); um = new Set(readFileSync(LOG, 'utf8').split('\n').filter((l) => l.startsWith('[' + today) && l.includes('] 打不了 ')).map((l) => (l.match(/0x[a-f0-9]{40}/) || [''])[0])).size; } catch {}
  await tgSay(`🌙 每日總結（晚上 9 點自動發）\n今天有 ${um} 個項目打不了（要官網簽名、白名單或模擬失敗），只記在紀錄裡`); await cmdStats().catch(() => {}); await cmdHold().catch(() => {});
}
async function lockNote(c, wAddr) { /* 買到的幣現在能不能轉：模擬轉 1 單位到黑洞地址，被擋就提醒（像 aiagentbsc 的白名單鎖）（使用者 10/30 21:44 要補的漏洞） */
  const toks = [...new Set([c, ...(S.dyn || []).filter((t) => t.only === wAddr).slice(-3).map((t) => t.addr)])];
  for (const t of toks) { const b = big(await call(t, '0x70a08231' + wa(wAddr))); if (!(b > 0n)) continue;
    try { await rpc('eth_call', [{ from: wAddr, to: t, data: '0xa9059cbb' + wa('0x000000000000000000000000000000000000dead') + w(1n) }, 'latest']); return ''; }
    catch (e) { return `\n⚠️ 這個幣現在轉不出去（${String(e.message).slice(0, 40)}）：可能要等開發者開放交易，也可能是貔貅`; } }
  return '';
}
async function tg(text) { if (/^🛒/u.test(text)) { const m = text.match(/\n(0x[a-fA-F0-9]{40})\n/); if (m) { text += await riskNote(m[1].toLowerCase()); const wn = (text.match(/^🛒 \[([^\]]+)\]/u) || [])[1]; const W = WALLETS.find((x) => x.name === wn); if (W) text += await lockNote(m[1].toLowerCase(), W.addr).catch(() => ''); } } log('TG: ' + text.replace(/\n/g, ' | ')); toGroup(text).catch(() => {}); if (!TG || (!CONFIG.notifyAll && !sendable(text))) return; try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text, disable_web_page_preview: true, disable_notification: !important(text) }), signal: AbortSignal.timeout(10000) }); } catch {} }

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
function keccak256(str) { /* 小型 keccak256（BigInt 版），算 Agent ID 編號用 */
  const M = (1n << 64n) - 1n, RC = [], R = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44], P = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
  let r = 1n; for (let i = 0; i < 24; i++) { let c = 0n; for (let j = 0; j < 7; j++) { r = ((r << 1n) ^ ((r >> 7n) * 0x71n)) & 0xffn; if (r & 2n) c ^= 1n << ((1n << BigInt(j)) - 1n); } RC.push(c); }
  const rot = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;
  const b = [...Buffer.from(str, 'utf8')]; b.push(1); while (b.length % 136) b.push(0); b[b.length - 1] |= 0x80;
  const s = Array(25).fill(0n);
  for (let o = 0; o < b.length; o += 136) {
    for (let i = 0; i < 17; i++) { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[o + i * 8 + k]); s[i] ^= v; }
    for (let rd = 0; rd < 24; rd++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) { const d = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
      let t = s[1]; for (let i = 0; i < 24; i++) { const j = P[i], u = s[j]; s[j] = rot(t, R[i]); t = u; }
      for (let y = 0; y < 25; y += 5) { const a = s.slice(y, y + 5); for (let x = 0; x < 5; x++) s[y + x] = a[x] ^ (~a[(x + 1) % 5] & M & a[(x + 2) % 5]); }
      s[0] ^= RC[rd];
    }
  }
  let h = ''; for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) h += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0'); return h;
}

/* 每個錢包自己的 Agent ID 編號 = keccak256(名稱去掉 .ai)；有些項目鑄造時要帶這個編號（像 SYNAPE 的 mint(agentTokenId)）（使用者 10/30 21:44 要補的漏洞） */
for (const W of WALLETS) W.agentId = keccak256(W.name.toLowerCase().replace(/\.ai$/, ''));

let S = { tokens: {}, lastBlock: 0, seenMints: {}, lastLoginAlert: 0 };
try { S = { ...S, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}
for (const k of Object.keys(S.tokens)) delete S.tokens[k].verified;
const save = () => { try { writeFileSync(STATE + '.tmp', JSON.stringify(S)); renameSync(STATE + '.tmp', STATE); } catch {} }; // 審查修正：先寫暫存檔再換名，當機也不會把狀態檔寫壞

// ---------- 持倉 ----------
async function findPair(t) {
  for (const q of [USDT, WBNB, USD1]) { const r = await call(FACTORY, '0xe6a43905' + wa(t.addr) + wa(q)); const p = r ? '0x' + r.slice(-40) : null; if (!p || /^0x0{40}$/.test(p)) continue; const rs = await call(p, '0x0902f1ac'); if (!rs || BigInt('0x' + rs.slice(2, 66)) === 0n || BigInt('0x' + rs.slice(66, 130)) === 0n) continue; /* 有池子但沒加流動性 = 還沒真的開盤 */ return { pair: p, quote: q }; }
  return null;
}
async function valueUsd(t, amt) { // 全部賣掉約可換多少 USDT
  if (amt <= 0n) return 0;
  let best = null; for (const path of [[t.addr, USDT], [t.addr, WBNB, USDT], [t.addr, USD1]]) { const r = await call(ROUTER, '0xd06ca61f' + w(amt) + w(64) + w(path.length) + path.map(wa).join('')); if (r) { const x = Number(BigInt('0x' + r.slice(-64))) / 1e18; if (best == null || x > best) best = x; } } // 審查修正：取所有池子裡最好的價格，避免被很小的池子誤判
  return best;
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
const decCache = new Map();
async function tokDec(a) { if (!decCache.has(a)) { const r = await call(a, '0x313ce567'); const d = r && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : 18; decCache.set(a, d > 0 && d <= 36 ? d : 18); } return decCache.get(a); }
async function sell(t, st, amt, why, W = WALLETS[0]) {
  const dec = await tokDec(t.addr); const qty = (Math.floor((Number(amt) / 10 ** dec) * 1e4) / 1e4).toFixed(4); // 依代幣小數位數算數量（審查修正：6／9 位小數的幣以前會算成 0）
  if (!(Number(qty) > 0)) return false;
  const bnb0 = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', t.addr, '--toToken', NATIVE_BNB]);
  log(`卖 ${t.sym} ${qty}: ${r.t.slice(0, 600)}`);
  if (!r.j?.success) { st.sellFail = (st.sellFail || 0) + 1; st.sellFailAt = Date.now(); const msg = (r.j?.error?.message || r.t).slice(0, 200); log(`[${W.name}] ${t.sym} 賣出失敗第 ${st.sellFail} 次：${msg.replace(/\n/g, ' ')}`);
    /* 使用者 10/31 00:35：一直吵。不到 3U 的小額幣賣不掉完全不通知，試 6 次就放棄；值錢的只在第 1 次通知 */
    const small = (st.curV ?? 99) < 3;
    if (small && st.sellFail >= 6) { st.stage = 9; st.gaveUp = ts(); log(`[${W.name}] ${t.sym} 只值約 ${(st.curV || 0).toFixed(2)}U，賣了 6 次都失敗，放棄不再賣`); }
    if (!small && st.sellFail === 1) await tg(`⚠️ [${W.name}] ${t.sym} 想賣但失敗（${why}）\n${msg}\n之後會自動重試，不再重複通知；賣掉時會發 💰 通知`);
    return false; }
  st.sellFail = 0;
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
async function holdW(W, head, onlyFast) { // 所有錢包同時跑（速戰：賣單不排隊）
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
      if (p) { st.pair = p.pair; st.openAt = st.openAt || Date.now(); st.fromBlock = head - 400; if (!first) await honeypotCheck(W, t, st, bal); if (!first) await tg(`🚀 ${t.sym} 開池了（PancakeSwap）\n池子 ${p.pair}\n開始追蹤價格，達到高點會自動賣`); }
      else { if (t0.deployer && t0.boughtAt && Date.now() - t0.boughtAt > 48 * 3600e3) blacklist(t0.deployer, `${t.sym} 打完 48 小時還沒開池`); continue; }
    }
    const v = await valueUsd(t, bal); if (v == null) continue; st.curV = v;
    // 用「每顆價格」算高點和倍數（審查修正：賣掉一部分後持倉變少，不會再被誤判成暴跌）
    const dec = await tokDec(t.addr); const balN = Number(bal) / 10 ** dec || 1e-18; const px = v / balN;
    if (!st.qty0 || balN > st.qty0 * 1.0001) st.qty0 = balN; // 原始持有量
    const vFull = px * st.qty0; // 如果還拿著全部，現在值多少（算 3／5／10 倍用）
    const from = Math.max(st.fromBlock || head - 20, head - 2000); const f = await flow(t, st, from, head); st.fromBlock = head + 1;
    const now = Date.now(); st.hist.push({ t: now, v, fresh: f.fresh, swaps: f.swaps }); st.hist = st.hist.filter((h) => now - h.t < 20 * 60e3);
    if (v > st.peak) { st.peak = v; st.peakAt = now; }
    if (px > (st.ppeak || 0)) { st.ppeak = px; st.ppeakAt = now; }
    const sum = (a, b, k) => st.hist.filter((h) => now - h.t >= a * 1000 && now - h.t < b * 1000).reduce((s, h) => s + h[k], 0);
    const fresh5 = sum(0, 300, 'fresh'), swaps5 = sum(0, 300, 'swaps'), swapsPrev5 = sum(300, 600, 'swaps');
    if (st.stage == null) st.stage = st.sold >= 2 ? 9 : st.sold === 1 ? 1 : 0; // 舊版狀態換算
    if (st.stage >= 9) { st.last = { v, at: ts() }; continue; }
    if (st.sellFail && now - (st.sellFailAt || 0) < Math.min(15, 2 ** (st.sellFail - 1)) * 60e3) { st.last = { v, at: ts() }; continue; } // 賣不掉：1、2、4…最多 15 分鐘後再試，不狂重試
    st.notified = st.notified || [];
    if (t.cost > 0 && !t.hold) for (const x of RULE.notifyX) if (vFull >= t.cost * x && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.sym} 到 ${x} 倍了！（成本 ${t.cost}U，現在持倉約 ${v.toFixed(2)}U）\n照規則：3 倍賣回本、5 倍和 10 倍各賣一半、從最高價回落 ${Math.round(RULE.crash * 100)}% 全賣（開池 ${RULE.fastMin} 分鐘內回落 ${Math.round(RULE.fastCrash * 100)}%）`); }
    if (t.sellNow) { if (!st.sellNowDone) { if (await sell(t, st, bal, '你指示全部賣出', W)) { st.sellNowDone = true; st.stage = 9; } } continue; }
    if (!(t.cost > 0) || t.hold) { // 免費的、或使用者說先別賣的
      if (!st.basePx) st.basePx = px; // 免費幣以開池後第一個價格當基準
      for (const x of RULE.notifyX) { const hit = t.hold ? vFull >= t.cost * x : px >= st.basePx * x; if (hit && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.hold ? '' : '免費幣 '}${t.sym} 漲到${t.hold ? '成本' : '開池價'}的 ${x} 倍！市值約 ${v.toFixed(2)}U\n${t.hold ? '你說先別賣，要賣在 TG 打「賣 ' + t.sym + '」' : '從最高價回落 50% 會自動全賣；想先賣在 TG 打「賣 ' + t.sym + '」'}`); } }
      if (st.openAt && now - st.openAt >= 180e3 && px > (st.fpp || 0)) st.fpp = px; // 開盤 3 分鐘後才開始算最高價
      if (!t.hold && st.fpp > 0 && px < st.fpp * (1 - RULE.drop) && v >= 0.3) { // 免費幣從最高價回落 50% 全賣
        if (await sell(t, st, bal, `免費幣從最高價回落 50%，全部賣出（約 ${v.toFixed(2)}U）`, W)) { st.stage = 9; continue; }
      }
      if (t.hold && px < st.ppeak * (1 - RULE.drop) && st.dropWarnedPeak !== st.ppeak) { st.dropWarnedPeak = st.ppeak; await tg(`⚠️ [${W.name}] ${t.sym} 從最高價回調 50%，現在約 ${v.toFixed(2)}U\n你說先別賣，不會自動賣，要賣在 TG 打「賣 ${t.sym}」`); }
      st.last = { v, at: ts() }; continue;
    }
    if (v < 0.3) { st.last = { v, at: ts() }; continue; } // 剩下不到 0.3U 的灰塵不賣（賣了不夠手續費）
    st.done2 = st.done2 || [];
    const age = now - (st.openAt || 0), fast = age < RULE.fastMin * 60e3;
    const crash = fast ? RULE.fastCrash : RULE.crash;
    if (st.ppeak > 0 && px < st.ppeak * (1 - crash)) {
      if (!st.done2.includes('back') && t0.deployer) blacklist(t0.deployer, `${t.sym} 還沒回本就崩`);
      if (await sell(t, st, bal, `${fast ? '速戰模式：' : ''}從最高價回落 ${Math.round(crash * 100)}%，全部賣出（約 ${v.toFixed(2)}U）`, W)) st.stage = 9;
    } else if (st.openAt && age > RULE.noPumpMin * 60e3 && st.ppeak * st.qty0 < t.cost * RULE.noPumpX && !st.done2.includes('back')) {
      if (await sell(t, st, bal, `開池 ${RULE.noPumpMin} 分鐘還沒到 ${RULE.noPumpX} 倍，判斷沒行情，全部賣出（約 ${v.toFixed(2)}U）`, W)) st.stage = 9;
    } else if (!st.done2.includes('back') && vFull >= t.cost * RULE.backX) {
      const pct = Math.min(100, Math.ceil((t.cost / v) * 100 * 1.03));
      if (await sell(t, st, (bal * BigInt(pct)) / 100n, `到 ${RULE.backX} 倍，賣 ${pct}% 拿回本錢 ${t.cost}U（持倉約 ${v.toFixed(2)}U）`, W)) st.done2.push('back');
    } else for (const x of RULE.halfX) {
      if (!st.done2.includes('h' + x) && vFull >= t.cost * x) { if (await sell(t, st, bal / 2n, `到 ${x} 倍，賣出一半（持倉約 ${v.toFixed(2)}U）`, W)) st.done2.push('h' + x); break; }
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
const CLAIM = new Set();
async function checkMinted(tok, m) {
  // 找出大家實際呼叫的合約（鑄造合約可能跟代幣合約不同）
  const txs = (await Promise.all(m.txs.slice(0, 6).map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter(Boolean);
  const cnt = {}; for (const t of txs) if (t.to) cnt[t.to.toLowerCase()] = (cnt[t.to.toLowerCase()] || 0) + 1;
  const target = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0]; if (!target) return;
  if (S.seenMints[target] || S.seenMints[tok] || CLAIM.has(target)) return; CLAIM.add(target); // 審查修正：同一個合約只讓一個流程處理，避免重複打
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
  if (INFRA.has(target) || INFRA.has(tok)) return; // Agent ID 登記合約本身不是項目
  S.seenMints[target] = ts(); S.seenMints[tok] = ts();
  const name = tokStr(await call(tok, '0x06fdde03')) || tokStr(await call(target, '0x06fdde03'));
  // 先試常見免費函式；不行就「照別人的呼叫內容重播」（不含別人地址的才重播）
  let minted = '';
  const sampleTx = txs.find((t) => t.to && t.to.toLowerCase() === target);
  for (const W of WALLETS) {
    let ff = await findFree(W.addr, target, code);
    if (!ff && sampleTx && sampleTx.input.length >= 10 && !badSel(sampleTx.input) && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase())) {
      for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from: W.addr, to: target, data: sampleTx.input, value: '0x' + v.toString(16) }, 'latest']); const nm = '重播' + sampleTx.input.slice(0, 10) + '@' + target.slice(2, 10); if (!CANDS.some((c) => c[0] === nm)) CANDS.push([nm, sampleTx.input]); ff = { n: nm, v }; break; } catch {} }
    }
    if (ff) minted += `[${W.name}] ` + queueMint(target, ff.n, W, ff.v) + '\n';
  }
  if (!minted) {
    S.paid = S.paid || {};
    const val = sampleTx ? BigInt(sampleTx.value || '0x0') : 0n;
    const noAddr = sampleTx && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase());
    S.paid[target] = { at: Date.now(), name, done: {}, wallets: m.to.size, ...((sampleTx?.input || '0x') === '0x' && val > 0n ? { recvValue: val.toString(), recvSeen: m.to.size } : {}), ...(noAddr && sampleTx.input !== '0x' && !badSel(sampleTx.input) ? { replay: { data: sampleTx.input, value: val.toString() } } : {}) };
  }
  await tg(`🔥 發現正在被鑄造的 Agent ID 項目${name ? '：' + name : ''}（3 分鐘內鑄給 ${m.to.size} 個錢包${share ? `，${Math.round(share * 100)}% 有 .ai 身份` : ''}）\n${target}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度超過 60%（或讀不到進度但很多人在打）且每個錢包 ≤20U 會自動打'}`);
}

async function hotScan() {
  for (const [c, h] of HOT) {
    if (INFRA.has(c) || CLAIM.has(c)) continue;
    if ((h.from.size < 12 && (h.smart?.size || 0) < 2) || S.seenMints[c] || hotChecked.has(c)) continue;
    CLAIM.add(c); hotChecked.set(c, Date.now()); if (hotChecked.size > 5000) hotChecked.delete(hotChecked.keys().next().value);
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
      if (!ff && topSel && topSel.length === 10 && !badSel(topSel)) for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from: W.addr, to: c, data: topSel, value: '0x' + v.toString(16) }, 'latest']); { const nm = '熱門函式' + topSel + '@' + c.slice(2, 10); if (!CANDS.some((x) => x[0] === nm)) CANDS.push([nm, topSel]); ff = { n: nm, v }; } break; } catch {} }
      if (ff) minted += `[${W.name}] ` + queueMint(c, ff.n, W, ff.v) + '\n';
    }
    if (!minted) {
      S.paid = S.paid || {};
      // 轉 BNB 就鑄的：取大家最常轉的金額當「一份的價格」（至少 10 筆一樣才算數）
      const top = [...(h.vals || new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
      S.paid[c] = { at: Date.now(), name, done: {}, wallets: h.from.size, ...(top && top[1] >= 2 ? { recvValue: top[0], recvSeen: top[1] } : {}) };
    }
    await tg(`🔥 發現正在被搶打的 Agent ID 項目${name ? '：' + name : ''}${viaAgents ? `（合約沒寫 Agent ID 檢查，但打它的錢包 ${Math.round(viaAgents * 100)}% 持有 .ai 身份，可能是後端簽名驗證）` : ''}（3 分鐘內 ${h.from.size} 個錢包${h.smart?.size ? '，其中聰明錢包 ' + h.smart.size + ' 個' : ''}）\n${c}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度超過 60%（或讀不到進度但很多人在打）且每個錢包 ≤20U 會自動打'}\nhttps://bscscan.com/address/${c}`);
  }
}

const BG = []; let bgRun = 0; // 背景工作佇列（最多同時 3 個）
function bgJob(fn) { BG.push(fn); pumpBG(); }
function pumpBG() { while (bgRun < 3 && BG.length) { const f = BG.shift(); bgRun++; f().catch((e) => log('bg ' + e.message)).finally(() => { bgRun--; pumpBG(); }); } }
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
        bgJob(async () => {
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
        await tg(`🆕 發現新的 Agent ID 專屬合約${name ? '：' + name : ''}\n${c}\n${ok.length ? '✅ 模擬免費可鑄：' + ok.join('、') + '\n' + minted : `⚪ 現在不是免費的（${pay}，或還沒開）→ 已加入追蹤：\n· 開放後若免費或手續費 ≤0.001 BNB → 自動打\n· 付費 → 進度超過 60%（或讀不到進度但很多人在打）且每個錢包 ≤20U → 自動打`}\nhttps://bscscan.com/address/${c}`);
        }); // 背景處理新合約（模擬、鑄造、通知），掃描不用等
      } catch {}
    }
  }
  
  if (!globalThis._hsBusy) { globalThis._hsBusy = true; hotScan().catch((e) => log('hotScan ' + e.message)).finally(() => { globalThis._hsBusy = false; }); }
  if (!globalThis._msBusy) { globalThis._msBusy = true; mintScan(done).catch((e) => log('mintScan ' + e.message)).finally(() => { globalThis._msBusy = false; }); }
  { /* 代理合約掃描：被限流就換節點；全部被限流先暫停 30 秒，之後從沒掃到的區塊補掃，不跳過 */
    S.proxyFrom = S.proxyFrom || S.lastBlock + 1; if (done - S.proxyFrom > 3000) S.proxyFrom = done - 3000;
    if (Date.now() > (globalThis._proxyPause || 0)) { const to = Math.min(done, S.proxyFrom + 500); try { await proxyScan(S.proxyFrom, to); S.proxyFrom = to + 1; globalThis._proxyFails = 0; } catch (e) { globalThis._proxyFails = (globalThis._proxyFails || 0) + 1; globalThis._proxyPause = Date.now() + 30e3; if (globalThis._proxyFails === 1 || globalThis._proxyFails % 20 === 0) log(`proxyScan 所有節點都被限流（第 ${globalThis._proxyFails} 次），暫停 30 秒後補掃：${e.message.slice(0, 80)}`); } }
  }
  S.lastBlock = done;
}

// ---------- 工厂合约建出来的代理合约（像 AIDROP 金库）：用「代理升级」事件抓 ----------
const T_BEACON_UP = '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e'; // BeaconUpgraded(address)
const T_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';  // Upgraded(address)
const implCache = new Map();
const VAULT_FACTORIES = ['0x90497450f2a706f1951b5bdda52b4e5d16f34c06']; // Flap 金庫工廠（AIDROP 就是它建的）
const LOG_NODES = ['https://bsc-rpc.publicnode.com', 'https://bsc.blockpi.network/v1/rpc/public', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://binance.llamarpc.com', 'https://bsc.publicnode.com'];
let logNi = 0; const logBad = new Map();
async function logsRpc(params) { /* 查事件用的多節點輪替：某個節點被限流就冷卻 2 分鐘換下一個 */
  let last; for (let i = 0; i < LOG_NODES.length; i++) { const u = LOG_NODES[(logNi + i) % LOG_NODES.length]; if ((logBad.get(u) || 0) > Date.now()) continue;
    try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params }), signal: AbortSignal.timeout(12000) })).json(); if (r.error) throw new Error(r.error.message); if (!Array.isArray(r.result)) throw new Error('bad result'); logNi = (logNi + i) % LOG_NODES.length; return r.result; }
    catch (e) { last = e; logBad.set(u, Date.now() + 120e3); } }
  throw last || new Error('所有節點冷卻中');
}
async function proxyScan(from, to) {
  if (to < from) return;
  // 公用節點不允許不帶地址的 getLogs，所以盯 Flap 金庫工廠：它每建一個新金庫就有事件，再從那筆交易收據找新代理合約
  const fl = await logsRpc([{ address: VAULT_FACTORIES, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
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
  for (const [n, d] of CANDS) { if (n.includes('@') && !n.endsWith('@' + c.slice(2, 10))) continue; if (n.includes('#') && !n.includes('#' + (WALLETS.find((x) => x.addr === from)?.name || '?') + '@')) continue; if (d.length < 10 || badSel(d) || !code.includes(d.slice(2, 10))) continue; /* 空呼叫（直接轉 0 BNB）不算鑄造 */ for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from, to: c, data: d, value: '0x' + v.toString(16) }, 'latest']); return { n, v }; } catch {} } }
  const W0 = WALLETS.find((x) => x.addr === from); /* 要帶自己 Agent ID 編號的鑄造：mint(編號)、claim(編號) */
  if (W0?.agentId) for (const sel of ['a0712d68', '379607f5', '6a627842']) { if (!code.includes(sel)) continue; const d = '0x' + sel + W0.agentId, n = `帶Agent編號${sel}#${W0.name}@${c.slice(2, 10)}`; for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from, to: c, data: d, value: '0x' + v.toString(16) }, 'latest']); if (!CANDS.some((x) => x[0] === n)) CANDS.push([n, d]); return { n, v }; } catch {} } }
  return null;
}
// 鑄造排隊：每個錢包一條隊伍在背景跑（交易要一筆一筆送），不卡住掃描
const MQ = new Map();

const BAD_SEL = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xa22cb465', '0x39509351', '0xd505accf', '0xf242432a', '0x2eb2c2d6']);
const badSel = (d) => BAD_SEL.has(String(d || '').slice(0, 10).toLowerCase());
const freeNoted = new Map(); // 免費 mint 通知：同一個項目等兩個錢包都打完，合成一則
function noteFree(c, W, name = '') { const first = !freeNoted.has(c); if (first) freeNoted.set(c, new Set()); freeNoted.get(c).add(W.name); if (first) setTimeout(async () => { const ok = freeNoted.get(c) || new Set(); freeNoted.delete(c); const nm = name || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10); await tg(`🆓 打了免費項目：${nm}（${WALLETS.map((x) => x.name + (ok.has(x.name) ? ' ✅' : ' ❌')).join('、')}）\n${c}`).catch(() => {}); }, 150e3); }
function queueMint(c, fname, W, v) {
  const prev = MQ.get(W.name) || Promise.resolve();
  const job = prev.then(() => autoMintMax(c, fname, W, v)).then(async (m) => { if (m.startsWith('🤖') && S.paid?.[c]) S.paid[c].done[W.name] = 'free'; /* 打到才算完成，沒打到（例如不夠熱門）之後再試 */ log(`[${W.name}] ${c} ${m.replace(/\n/g, ' | ')}`); if (m.startsWith('🤖')) { S.freeTrack = S.freeTrack || {}; S.freeTrack[c] = S.freeTrack[c] || { at: Date.now() }; } if (m.startsWith('🤖')) noteFree(c, W); }).catch((e) => log(`[${W.name}] 鑄造失敗 ${c} ${e.message}`));
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
  { const heat = Math.max(HOT.get(c)?.from.size || 0, S.paid?.[c]?.agents || 0); if (heat < 10) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; return `⏸ 免費，但最近只有 ${heat} 個錢包在打，不夠熱門，先追蹤，熱起來再打`; } } /* 使用者 10/31 16:08：就算免費的也要打熱門的（3 分鐘內 10 個以上錢包在打） */
  if (val > 0n) { const heat = Math.max(HOT.get(c)?.from.size || 0, S.paid?.[c]?.agents || 0); if (heat < 15) return `⏸ 要付手續費（${(Number(val) / 1e18).toFixed(4)} BNB），但最近只有 ${heat} 個錢包在打，不夠熱門，先不打`; } /* 使用者 10/31 16:04：省手續費，付手續費的「免費」項目要很多人在打才打（3 分鐘內 15 個以上） */
  if (val > 0n) { const dd = new Date().toDateString(); S.feeDay = S.feeDay || {}; if (S.feeDay.d !== dd) S.feeDay = { d: dd }; const used = S.feeDay[W.name] || 0; if (used + Number(val) / 1e18 > 0.003) return '⏸ 今天手續費型鑄造已達 0.003 BNB 上限，沒有鑄'; S.feeDay[W.name] = used + Number(val) / 1e18; }
  const d = Object.fromEntries(CANDS)[fname];
  const today = new Date().toDateString(); if (S.mintDay !== today) { S.mintDay = today; S.mintCount = 0; }
  S.mintCnt = S.mintCnt && S.mintCnt.d === today ? S.mintCnt : { d: today }; if ((S.mintCnt[W.name] || 0) >= 1000) return '⏸ 這個錢包今天自動鑄已達 1000 筆上限，沒有鑄';
  const bnb = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  if (bnb < 5n * 10n ** 14n) return '⚠️ BNB 不夠付 gas（< 0.0005），沒有鑄';
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', c, '--value', val.toString(), '--inputData', d]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) return '❌ 預演失敗，沒有鑄：' + (p.j?.error?.message || '').slice(0, 120);
  { const fg = flapGuard(c, d, sim); if (fg) return '⛔ ' + fg + '，沒有鑄'; }
  const losing = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) < 0 && !(String(b.contractAddress).toLowerCase().startsWith('0xeeee') && -Number(b.change) <= Number(val) * 1.01 && val > 0n));
  if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length || losing.length) return '⚠️ 預演顯示有授權或會扣你的資產，安全起見沒有鑄';
  if (!(sim?.balanceChanges || []).some((b) => String(b.owner).toLowerCase() === W.addr && (Number(b.change) > 0 || (/Erc721|Erc1155/i.test(b.tokenType || '') && !(Number(b.change) < 0))))) return '⚪ 預演顯示拿不到東西（可能鑄給別人或淨額為 0），沒有鑄'; 
  INFLIGHT++; let x; try { x = await W.baw(['contract-call', 'execute', '--requestId', rid]); } finally { INFLIGHT--; }
  if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) return '⚠️ 送出結果不明（逾時），先不重打';
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
  
  goPct: 0.6, earlyPct: 0.6, riseDelta: 0.02, maxUsd: 20, 
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
async function readLimit(W, c) { 
  const code = ((await codeOf(c)) || '').toLowerCase(); const has = (s) => code.includes(s); const num = (r) => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null); const me = wa(W.addr); const lim = [];
  for (const s of ['d872e413', 'b399b0bc', 'b0b5230f', '7aa9a9d8']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x < 1000000n) { lim.push(x); break; } }
  let per = null; for (const s of ['453c2310', 'b228d925', '0f2cdd6c', 'f516a2e6', '3c8463a1', 'a4183dbe', '6ac8c1b7']) if (has(s)) { const x = num(await call(c, '0x' + s)); if (x != null && x > 0n && x < 1000000n) { per = x; break; } }
  if (per == null) for (const s of ['1cee24f5', 'ef23b3a3']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x > 0n && x < 1000000n) { per = x; break; } }
  if (per != null) { let mine = 0n; for (const s of ['1e7269c5', '3cef28d2', 'dc33e681', 'fddcb5ea', 'f5eb42dc', '7b622c72']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x < 1000000n) { mine = x; break; } } lim.push(per > mine ? per - mine : 0n); }
  for (const s of ['f968adbe', 'f43a22dc', 'de7fcb1d']) if (has(s)) { const x = num(await call(c, '0x' + s)); if (x != null && x > 0n && x < 1000000n) { lim.push(x); break; } }
  return lim.length ? lim.reduce((a, b) => (b < a ? b : a)) : null;
}
async function fitShares(W, c, data, v) { // 份數：先讀項目方開放幾份；讀不到再自動降到 5、3、2、1 份試
  const ws = data.slice(10).match(/.{64}/g) || []; if (!ws.length) return data;
  let n0 = BigInt('0x' + ws[0]); if (n0 < 1n || n0 > 100n) return data;
  const lim = await readLimit(W, c).catch(() => null);
  if (lim != null) { if (lim === 0n) throw new Error('這個錢包的額度已經用完'); if (lim < n0) { log(`讀到項目方開放份數 ${lim}，照這個打：${c}`); n0 = lim; } }
  for (const n of [n0, ...[5n, 3n, 2n, 1n].filter((x) => x < n0)]) {
    const d2 = data.slice(0, 10) + w(n) + ws.slice(1).join('');
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d2, value: '0x' + BigInt(v || 0).toString(16) }, 'latest']); if (n !== n0) log(`份數降到 ${n} 份才打得了：${c}`); return d2; } catch {}
  }
  return data;
}
async function safeAddrs(W, c, data, v) { 
  let ws = data.slice(10).match(/.{64}/g) || []; const me = W.addr.slice(2).toLowerCase();
  if (W.agentId) { let sw = 0; for (let i = 0; i < ws.length; i++) { const x = ws[i].toLowerCase(); if (/^0{24}/.test(x) || BigInt('0x' + x) < 2n ** 128n || x === W.agentId) continue; const o = await call('0x' + REGISTRY, '0x6352211e' + x); if (o && BigInt(o.slice(0, 66)) > 0n && o.slice(26, 66).toLowerCase() !== me) { ws[i] = W.agentId; sw = 1; } } if (sw) { data = data.slice(0, 10) + ws.join(''); log(`照抄前把別人的 Agent ID 編號換成自己的：${c}`); } } /* 照抄的交易帶著別人的 Agent ID 編號 → 換成自己的 */
  const skip = new Set([me, c.slice(2).toLowerCase(), USDT.slice(2).toLowerCase(), WBNB.slice(2).toLowerCase()]);
  const idx = ws.map((x, i) => [x.toLowerCase(), i]).filter(([x]) => /^0{24}[0-9a-f]{40}$/.test(x) && x.slice(24, 32) !== '00000000' && !skip.has(x.slice(24))).map(([, i]) => i);
  if (!idx.length) return data;
  for (const r of [me.padStart(64, '0'), '0'.repeat(64)]) {
    const d2 = data.slice(0, 10) + ws.map((x, i) => (idx.includes(i) ? r : x)).join('');
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d2, value: '0x' + BigInt(v || 0).toString(16) }, 'latest']); log(`照抄前把別人的地址換成${r === '0'.repeat(64) ? '零地址' : '自己的地址'}：${c}`); return d2; } catch {}
  }
  throw new Error('交易裡有別人的地址，換成自己或零地址都打不了，安全起見不打');
}
async function revokeOnFail(W, token, spender, fn) { 
  try { return await fn(); } catch (e) { try { await previewExec(W, token, '0x095ea7b3' + wa(spender) + w(0), 0n, () => ''); log(`[${W.name}] 鑄造失敗，已取消對 ${spender} 的授權`); } catch (e2) { log(`[${W.name}] 取消授權失敗 ${e2.message}`); } throw e; }
}
/* 使用者 10/31 10:49：全部禁止授權給 Flap。Flap 的合約一律不互動、不授權 */
const FLAP_BLOCK = new Set(['0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0', '0x90497450f2a706f1951b5bdda52b4e5d16f34c06', '0x18aa6c93f1887a243fdc348c9a77f5136555174a', '0x8b4329947e34b6d56d71a3385cac122bade7d78d', '0x5dd913731c12ad8df3e574859fde45412bf4aad9']);
function flapGuard(to, data, sim) {
  if (FLAP_BLOCK.has(String(to).toLowerCase())) return '禁止跟 Flap 合約互動';
  const d = String(data || '').toLowerCase(); if (/^0x(095ea7b3|39509351)/.test(d) && FLAP_BLOCK.has('0x' + d.slice(34, 74))) return '禁止授權給 Flap';
  if ((sim?.allowanceChanges || []).some((a) => FLAP_BLOCK.has(String(a.spender).toLowerCase()))) return '會授權給 Flap，禁止';
  return '';
}
let INFLIGHT = 0; // 正在送出的交易數（重啟前要等它歸零，避免重打）
async function previewExec(W, to, data, valueWei, check, recheck = null) {
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', to, '--value', valueWei.toString(), '--inputData', data]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) throw new Error('預演失敗 ' + (p.j?.error?.message || p.t).slice(0, 120));
  const fg = flapGuard(to, data, sim); if (fg) throw new Error('預演不安全：' + fg);
  const why = check(sim); if (why) throw new Error('預演不安全：' + why);
  if (recheck) { const r2 = await recheck(); if (r2) throw new Error('送出前再確認不通過：' + r2); } // 送出前再確認價格（審查建議 5）
  INFLIGHT++; let x; try { x = await W.baw(['contract-call', 'execute', '--requestId', rid]); } finally { INFLIGHT--; }
  if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) throw new Error('結果不明：送出逾時，可能已上鏈，先不重打');
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
function noteDev(dep, c) { if (!dep) return; S.devs = S.devs || {}; const now = Date.now(); const arr = (S.devs[dep] || []).filter((x) => now - x.t < 86400e3 && x.c !== c); arr.push({ t: now, c }); S.devs[dep] = arr.slice(-30); if (Object.keys(S.devs).length > 5000) S.devs = {};
  (async () => { let n = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')); if (!n) { const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) n = tokStr(await call('0x' + tr.slice(26, 66), '0x95d89b41')); } const e = (S.devs[dep] || []).find((x) => x.c === c); if (e && n) e.n = n; })().catch(() => {}); }

const devKey = (x) => String(x.n || S.paid?.[x.c]?.name || x.c).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/^\$/, '').trim();
function isRepeatDev(dep) { return !!dep && new Set(((S.devs || {})[dep] || []).filter((x) => Date.now() - x.t < 86400e3).map(devKey)).size >= 3; }
function blacklist(dep, why) { if (!dep) return; S.black = S.black || {}; if (!S.black[dep]) { S.black[dep] = { at: ts(), why }; log(`黑名單：${dep}（${why}）`); } }

const heatTier = (P) => ((P.agents || 0) >= 200 || (P.burst || 0) >= 30 ? 2 : (P.agents || 0) >= 100 || (P.burst || 0) >= 15 ? 1 : 0);
function markUnmintable(c, P, sym, progress, why = '要官網簽名或白名單') { // 達到進場條件但我們打不了：標記不再重試，通知使用者一次
  if (P.unmintable) return; P.unmintable = ts(); P.unmintableAt = Date.now();
  log(`打不了 ${c}（${sym}）：${why}`);
  if (false && (heatTier(P) >= 1 || ((progress || 0) >= 0.4 && (progress || 0) < 0.95))) tg(`⚠️ ${sym || P.name || '新項目'} 達到進場條件（累計 ${P.agents || 0} 個代理人${progress > 0 ? '，進度約 ' + Math.round(progress * 100) + '%' : ''}），但工具打不了：${why}。要的話請手動\n${c}`).catch(() => {});
}
function noteFail(c, P, sym, progress) { P.cf = (P.cf || 0) + 1; if (P.cf >= 8) markUnmintable(c, P, sym, progress, '模擬鑄造一直失敗，可能已賣完、要官網簽名、白名單或已關閉'); } // 重試 4 輪（兩個錢包）都失敗就不再試
const agentCache = new Map(); // 地址 → 有沒有 .ai Agent ID
async function rpcBatch(reqs) { const out = []; for (let i = 0; i < reqs.length; i += 100) { try { const j = await (await fetch('https://bsc-rpc.publicnode.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs.slice(i, i + 100).map((r, k) => ({ jsonrpc: '2.0', id: i + k, ...r }))), signal: AbortSignal.timeout(20000) })).json(); for (const r of j || []) out[r.id] = r.result; } catch {} } return out; }
async function heatOf(c, P) { // 算熱度：最近約 2.5 小時有幾個不同的 Agent ID 錢包參與鑄造，其中最近 3 分鐘幾個
  const head = parseInt(await rpc('eth_blockNumber', []), 16); let tok = ''; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66).toLowerCase();
  const last = new Map(); const skip = new Set([c, tok, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
  const span = P.heatAt ? 6000 : 20000; // 第一次看約 2.5 小時，之後只看最近約 45 分鐘（累計數取最大值）
  for (let b = head - span; b <= head; b += 10000) {
    const L = await rpc('eth_getLogs', [{ address: tok ? [c, tok] : c, fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 9999, head).toString(16) }]).catch(() => []);
    for (const l of L || []) for (const t of (l.topics || []).slice(1)) { if (!/^0x0{24}[0-9a-f]{40}$/i.test(t) || t.slice(26, 34) === '00000000') continue; const a = ('0x' + t.slice(26)).toLowerCase(); if (skip.has(a)) continue; const bn = parseInt(l.blockNumber, 16); if (!last.has(a) || last.get(a) < bn) last.set(a, bn); }
  }
  const unknown = [...last.keys()].filter((a) => !agentCache.has(a)).slice(0, 400);
  if (unknown.length) { const res = await rpcBatch(unknown.map((a) => ({ method: 'eth_call', params: [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(a) }, 'latest'] }))); unknown.forEach((a, i) => { if (res[i] !== undefined) agentCache.set(a, !!res[i] && res[i].length >= 66 && BigInt(res[i].slice(0, 66)) > 0n); }); }
  let agents = 0, burst = 0; for (const [a, bn] of last) if (agentCache.get(a)) { agents++; if (bn >= head - 400) burst++; }
  P.agents = Math.max(P.agents || 0, agents); P.burst = burst; P.heatAt = Date.now();
}
const hk = (P) => (P.heatAt || 0) + (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 ? 0 : 540e3);
async function heatWatch() { // 背景：替追蹤中的付費項目算熱度，看不懂的合約順便學別人的打法（不拖慢 15 秒的快速檢查）
  const ents = Object.entries(S.paid || {}).filter(([c, P]) => !INFRA.has(c) && !P.unmintable && (P.progress || 0) < 0.999 && !WALLETS.every((W) => P.done?.[W.name]))
    .sort((a, b) => hk(a[1]) - hk(b[1])).slice(0, 8); // 快滿或很熱的約每分鐘更新，其他約 10 分鐘
  for (const [c, P] of ents) {
    try {
      await heatOf(c, P);
      if (P.needLearn && (!P.replay || Date.now() - (P.replay.learnedAt || 0) > 120e3) && (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 || (P.agents || 0) >= 20)) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = lr; }
    } catch (e) { log('heat ' + c + ' ' + e.message); }
  }
}
function freshDeadline(data) { /* 照抄的交易裡如果有「期限」（看起來像時間戳記的數字），換成 15 分鐘後，不然舊交易一定過期失敗（币安无忧 10/31） */
  const now = Math.floor(Date.now() / 1000); const ws = data.slice(10).match(/.{64}/g) || []; let ch = 0;
  const out = ws.map((x) => { const v = BigInt('0x' + x); if (v > BigInt(now - 30 * 86400) && v < BigInt(now + 30 * 86400)) { ch = 1; return (BigInt(now + 900)).toString(16).padStart(64, '0'); } return x; });
  return ch ? data.slice(0, 10) + out.join('') : data;
}
async function learnReplay(c) { // 學別人最近成功的鑄造：最常見的函式、要付多少 BNB／USDT、最近有幾個錢包在打
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const L = await rpc('eth_getLogs', [{ address: c, fromBlock: '0x' + (head - 1500).toString(16), toBlock: 'latest' }]).catch(() => []);
  const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-40);
  const txs = (await Promise.all(hs.map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter((t) => t && t.to && t.to.toLowerCase() === c && t.input && t.input.length >= 10 && !badSel(t.input) && !t.input.toLowerCase().includes(t.from.slice(2).toLowerCase()));
  if (!txs.length) return null;
  const cnt = {}; for (const t of txs) cnt[t.input.slice(0, 10)] = (cnt[t.input.slice(0, 10)] || 0) + 1;
  const sel = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
  const cands = txs.filter((t) => t.input.startsWith(sel)).reverse().sort((a, b) => a.input.length - b.input.length); // 優先學最簡單的那種（別人帶了自己的 NFT 編號等額外參數的，照抄會失敗）
  for (const pick of cands.slice(0, 3)) {
    const rc = await rpc('eth_getTransactionReceipt', [pick.hash]).catch(() => null); if (!rc || rc.status !== '0x1') continue;
    let payTok = '', payAmt = '0';
    for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics.length === 3 && ('0x' + l.topics[1].slice(26)).toLowerCase() === pick.from.toLowerCase()) { payTok = l.address.toLowerCase(); payAmt = BigInt(l.data).toString(); break; }
    const hot = new Set(txs.filter((t) => parseInt(t.blockNumber, 16) >= head - 400).map((t) => t.from.toLowerCase())).size;
    return { data: pick.input, value: BigInt(pick.value).toString(), payTok, payAmt, hot, learned: 1, learnedAt: Date.now() };
  }
  return null;
}
async function repeatDevOk(dep, c, P) {
  const mine = devKey({ c, n: P.name });
  const others = ((S.devs || {})[dep] || []).filter((x) => x.c !== c);
  if (others.some((x) => devKey(x) === mine)) return '同名重新部署';
  for (const x of others) { // 他之前的項目有沒有正常開盤（池子還有錢、沒被抽走）
    let tk = x.c; const tr = await call(x.c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tk = '0x' + tr.slice(26, 66);
    for (const q of [WBNB, USDT]) { const pr = await call(FACTORY, '0xe6a43905' + wa(tk) + wa(q)); if (!pr || !(BigInt(pr) > 0n)) continue; const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n && BigInt('0x' + rs.slice(66, 130)) > 0n) return '之前有項目正常開盤'; }
  }
  return '';
}
const memoC = new Map(); const cc = async (to, data, ttl = 600e3) => { const k = to + data, m = memoC.get(k); if (m && Date.now() - m.t < ttl) return m.v; const v = await call(to, data); memoC.set(k, { v, t: Date.now() }); if (memoC.size > 20000) memoC.clear(); return v; }; // 不常變的合約資料快取，加快檢查
const busyP = new Set(); // 同一個項目同時只處理一次（快速檢查和一般檢查分開跑，避免重複打）
async function paidLoop(mode = 'all') {
  if (S.umReset !== 3) { S.umReset = 3; for (const P of Object.values(S.paid || {})) { if (P.unmintable) { delete P.unmintable; P.fail = 0; P.cf = 0; if (P.replay?.learned) delete P.replay; } } } // 新版一次性：之前標記打不了的重新試
  S.paid = S.paid || {}; S.dyn = S.dyn || []; S.paidSpend = S.paidSpend || {};
  const today = new Date().toDateString(); if (S.paidSpend.day !== today) S.paidSpend = { day: today };
  let price = 0;
  if (!S.forceDone) S.forceDone = { '0xc7d563a7bd5af3de83567a67058b3eb9f285149e': 1 }; // VARC 早上已經打完
  for (const c of FORCE) if (S.forceDone[c] && S.paid[c]) delete S.paid[c];
  for (const c of FORCE) if (!S.paid[c] && !S.forceDone[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; // 審查修正：手動指定的項目打完就不再加回來重打
  if (!S.migrated2) { S.migrated2 = 1; for (const c of Object.keys(S.seenMints || {})) { if (S.paid[c]) continue; const cd = await codeOf(c); if ((cd.includes('e38fd349') && cd.includes('68bce8cd')) || (cd.includes('725c4058') && cd.includes('94bf804d'))) { S.paid[c] = { at: Date.now(), name: '', done: {} }; log('補登付費追蹤 ' + c); } } }
  // 進度 ≥40% 的（快滿的）每輪都看，不跟其他一百多個排隊；其餘輪流，每輪補到 16 個
  const all = Object.entries(S.paid);
  
  const hotP = all.filter(([c, P]) => FORCE.has(c) || (((P.progress || 0) >= 0.2 || heatTier(P) >= 1) && (P.progress || 0) < 0.999 && !P.unmintable)).filter(([c, P]) => !WALLETS.every((W) => P.done[W.name])).sort((a, b) => heatTier(b[1]) - heatTier(a[1]) || (b[1].progress || 0) - (a[1].progress || 0)).slice(0, 10);
  // 快速檢查（mode='hot'）每 15 秒只看快滿／很熱的；一般檢查（mode='rest'）另外在背景約每分鐘輪流看其他的，互不拖慢
  const rest = mode === 'hot' ? [] : all.filter((e) => !hotP.includes(e)).sort((a, b) => (a[1].lastTry || 0) - (b[1].lastTry || 0)).slice(0, 16);
  const ents = mode === 'rest' ? rest : mode === 'hot' ? hotP : hotP.concat(rest);
  for (const [c, P] of ents) {
    if (INFRA.has(c)) { delete S.paid[c]; continue; } // Agent ID 登記合約本身不是項目（註冊 .ai 身份），不打
    if (busyP.has(c)) continue; busyP.add(c); const tE = Date.now();
    try {
    P.lastTry = Date.now(); if (WALLETS.every((W) => P.done[W.name])) { if (FORCE.has(c)) { S.forceDone = S.forceDone || {}; S.forceDone[c] = 1; } delete S.paid[c]; continue; }
    if (Date.now() - P.at > PAID.maxAgeH * 3600e3) { delete S.paid[c]; continue; }
    const code = await codeOf(c);
    // 發現時還沒開的「免費」鑄造：之後每分鐘重試，一開就自動打
    if (Date.now() - (P.freeTryAt || 0) > 120e3) { P.freeTryAt = Date.now(); for (const W of WALLETS) { if (P.done[W.name]) continue; { const ff = await findFree(W.addr, c, code); if (!ff || P.qAt?.[W.name] > Date.now() - 110e3) continue; P.qAt = P.qAt || {}; P.qAt[W.name] = Date.now(); queueMint(c, ff.n, W, ff.v); log(`[${W.name}] 之前還沒開的 ${P.name || c} 現在開了（免費），排入鑄造`); } } }
    let kind = code.includes('e38fd349') && code.includes('68bce8cd') ? 'bnb' : code.includes('725c4058') && code.includes('94bf804d') ? 'usdt' : null;
    let unit = 0n; // 一般 NFT：mint(數量) 付「單價 × 數量」BNB（像 Sentient Syndicate 的 PRICE）
    if (!kind && code.includes('a0712d68')) for (const sel of ['8d859f3e', 'a035b1fe', '6817c76c', '13faede6', '817b1cd2']) { if (!code.includes(sel)) continue; const r = await cc(c, '0x' + sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { unit = BigInt(r.slice(0, 66)); kind = 'gen'; break; } }
    if (!kind && P.recvValue) kind = 'recv';
    if (P.replay && badSel(P.replay.data)) delete P.replay;
    if (!kind && P.replay) kind = 'replay'; // 少見的鑄造函式：照別人的呼叫內容與金額打
    
    if (!kind || kind === 'replay') P.needLearn = 1; // 看不懂的合約：交給背景的熱度監測去學別人的打法，這裡不等
    if (!kind) continue;
    if (P.unmintable && P.unmintableAt && Date.now() - P.unmintableAt > 30 * 60e3 && (P.umN || 0) < 2) { P.umN = (P.umN || 0) + 1; delete P.unmintable; P.fail = 0; P.cf = 0; } // 30 分鐘後再試，最多再試 2 次（避免付 USDT 的項目每半小時換一次 USDT 又失敗）
    if (P.unmintable && !FORCE.has(c)) continue;
    let soldR = await call(c, kind === 'bnb' ? '0xa2309ff8' : kind === 'gen' ? '0x18160ddd' : '0x192fc516');
    if (!(soldR && soldR.length >= 66) && (kind === 'replay' || kind === 'recv')) { if (P.soldSel) soldR = await call(c, P.soldSel); else for (const sel of ['0x02c7e7af', '0xa2309ff8', '0x9106d7ba', '0xf4514d2e', '0x505e05fd', '0x3a98ef39']) { const r = await cc(c, sel, 60e3); if (r && r.length >= 66) { soldR = r; P.soldSel = sel; break; } } }
    const sold = soldR && soldR.length >= 66 ? Number(BigInt(soldR.slice(0, 66))) : null;
    let cap = null; for (const sel of ['0xd8f93498', '0xcef6feda', '0x29b80536', '0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0x3a1d8d3a', '0xf1aee5a2', '0x85e3f997']) { const r = await cc(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && sold != null && x >= sold && x < 1e12) { cap = x; break; } } }
    let tokAddr0 = ''; { const tr0 = await cc(c, '0xfc0c546a', 3600e3); if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tokAddr0 = '0x' + tr0.slice(26, 66); }
    let progress = cap && sold != null ? sold / cap : 0, how = '已售／上限';
    if (!(progress > 0)) { const pr = await progressOf(c, code, tokAddr0); progress = pr.progress || 0; how = pr.how || ''; }
    /* 使用者 10/31 19:02：進度合理性檢查（币安人 把總量讀成 100 倍，進度 32% 被讀成 0.3%，別人打到我們沒打到）：讀到的進度很低、但已經很多人打 → 判定讀錯，改用庫存算法；還是不合理就當作讀不到，交給熱度規則 */
    if (progress > 0 && progress < 0.03 && ((P.agents || 0) >= 50 || (sold || 0) >= 1000 || (HOT.get(c)?.from.size || 0) >= 15)) {
      const pr = await progressOf(c, code, tokAddr0).catch(() => ({}));
      if (pr.progress >= 0.03) { progress = pr.progress; how = pr.how || '庫存'; }
      else { if (!P.progBad) { P.progBad = 1; log(`進度看起來讀錯了：${c} 讀到 ${(progress * 100).toFixed(2)}% 但已有 ${P.agents || 0} 個代理人在打，改用熱度規則判斷`); } progress = 0; how = '讀不到（數字不合理）'; }
    }
    const prevProg = P.progress; P.progress = progress;
    if (progress >= 0.7 && progress <= 1 && (prevProg != null ? prevProg < 0.7 : Date.now() - P.at < 6 * 3600e3)) groupProgress(c, P.name, progress).catch(() => {});
    { const now = Date.now(); P.ph = (P.ph || []).filter((x) => now - x.t < 15 * 60e3); if (!P.ph.length || now - P.ph[P.ph.length - 1].t > 10e3) P.ph.push({ t: now, p: progress }); }
    price = price || (await bnbUsd());
    const forced = FORCE.has(c);
    
    const tier = heatTier(P), needPct = tier >= 2 ? 0.3 : tier >= 1 ? 0.4 : PAID.goPct;
    const blindGo = !(progress > 0) && (tier >= 1 || (P.progBad && (sold || 0) >= 3000)) && (kind === 'replay' || P.progBad); /* 進度讀錯的項目：熱門，或已經被鑄了 3000 份以上，就照熱度規則跟打 */
    if (!forced && !(progress >= needPct || blindGo)) continue;
    if (!forced && !P.goLogged) { P.goLogged = 1; log(`進場 ${c}：${['一般', '熱', '超熱'][tier]}（累計 ${P.agents || 0} 個代理人、3 分鐘 ${P.burst || 0} 個），進度 ${progress > 0 ? Math.round(progress * 100) + '%' : '讀不到'}`); }
    // 防釣魚：① 同款合約 24 小時內被部署 3 次以上（批量發盤）不打 ② 進度要是很多人打出來的（至少 20 個不同錢包），不是項目方自己刷的
    if (!forced) { const dep = P.deployer !== undefined ? P.deployer : await deployerOf(c); P.deployer = dep;
      if (dep && !(S.devs?.[dep] || []).some((x) => x.c === c)) noteDev(dep, c);
      if (dep && S.black?.[dep]) { if (!P.blackLogged) { P.blackLogged = 1; log(`跳過 ${c}：部署者 ${dep} 在黑名單（${S.black[dep].why}）`); } continue; }
      if (dep && P.fresh == null) P.fresh = await freshWallet(dep);
      if (P.fresh) { if (!P.freshLogged) { P.freshLogged = 1; log(`跳過 ${c}：部署者 ${dep} 是剛建立的新錢包`); } continue; }
      // 錢流：合約裡幾乎沒留 BNB、也還沒開池 → 錢多半直接流進項目方錢包，要求更多人打過（40 個）才算可信
      if (P.drain == null) { const cb = Number(BigInt((await rpc('eth_getBalance', [c, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18; const pr = tokAddr0 || c; const pair = await call(FACTORY, '0xe6a43905' + wa(pr) + wa(WBNB)); P.drain = cb < 0.01 && !(pair && BigInt(pair) > 0n); }
      
      P.needW = 0;
      if (isRepeatDev(dep)) {
        if (P.repeatOk == null || Date.now() - (P.repeatAt || 0) > 600e3) { P.repeatOk = await repeatDevOk(dep, c, P); P.repeatAt = Date.now(); }
        if (!P.repeatOk) { if (P.drain) { if (!P.devLogged) { P.devLogged = 1; log(`跳過 ${c}：重複 DEV ${dep}，沒有開盤紀錄，而且錢直接流走`); } continue; } P.needW = 40; }
        else if (!P.devLogged) { P.devLogged = 1; log(`重複 DEV ${dep} 但照打 ${c}（${P.repeatOk}）`); }
      }
    }
    // 使用者定：只打新的 → 兩天前就部署的老合約不打
    if (!forced) { if (P.old == null) { const head = parseInt(await rpc('eth_blockNumber', []), 16); const o = await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x'); P.old = !!o && o.length > 2; } if (P.old) { for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'old'; continue; } }
    // 已經開池交易的項目不再自動鑄造（鑄造≈用市價買，不划算）
    if (!forced) { const tk = tokAddr0 || c; let opened = false; for (const q of [WBNB, USDT]) { const pr = await cc(FACTORY, '0xe6a43905' + wa(tk) + wa(q), 60e3); if (pr && BigInt(pr) > 0n) { const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n) { opened = true; break; } } } if (opened) { for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'pool-open'; log(`跳過 ${c}：已經開池交易，不再鑄造`); continue; } }
    if (!forced && isSerial(code)) { if (!P.serialLogged) { P.serialLogged = 1; log(`跳過 ${c}：同款合約 24 小時內部署 3 次以上，疑似批量發盤`); } continue; }
    if (!forced) { const need = Math.max(P.drain ? 40 : 20, P.needW || 0); const seen = Math.max(P.wallets || 0, HOT.get(c)?.from.size || 0, P.agents || 0); /* 熱度算到的 Agent ID 錢包數也算（USDT 鑄造、幣先鎖住的項目沒有轉帳紀錄可數） */ if (seen < need) { if (Date.now() - (P.wAt || 0) < 60e3) continue; P.wAt = Date.now(); const r = await rpc('eth_getLogs', [{ address: tokAddr0 || c, fromBlock: '0x' + (parseInt(await rpc('eth_blockNumber', []), 16) - 3000).toString(16), toBlock: 'latest', topics: [T_TRANSFER] }]).catch(() => []); const uniq = new Set((r || []).map((l) => l.topics[2])).size; P.wallets = Math.max(P.wallets || 0, uniq); if (uniq < need) continue; } } // 還沒到 80%（或讀不到進度）→ 先不打，之後每分鐘再看
    const limitUsd = Infinity;
    let tokAddr = ''; const tr = await cc(c, '0xfc0c546a', 3600e3); if (tr && tr.length >= 66) tokAddr = '0x' + tr.slice(26, 66);
    const sym = tokAddr ? tokStr(await cc(tokAddr, '0x95d89b41', 3600e3)) || P.name || c.slice(0, 8) : P.name || c.slice(0, 8);
    await Promise.all(WALLETS.map(async (W) => { 
      if (P.done[W.name]) return;
      try {
        price = price || (await bnbUsd());
        const spent = S.paidSpend[W.name] || 0;
        const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
        let n = 10, costWei = 0n;
        if (kind === 'replay' && P.replay.payTok) { // 付 USDT 的鑄造（像 BITO）：換 USDT → 授權 → 照別人的方式打，份數放大到預算內最多 10 份
          if (P.replay.payTok !== USDT) { if (!P.payTokLogged) { P.payTokLogged = 1; log(`跳過 ${c}：要付的代幣不是 USDT（${P.replay.payTok}）`); } return; }
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = { ...P.replay, ...lr }; }
          let data = freshDeadline(P.replay.data), need = BigInt(P.replay.payAmt || '0'); const ws = data.slice(10).match(/.{64}/g) || [];
          if (ws.length === 3 && need > 0n) { const n0 = BigInt('0x' + ws[0]), mx = BigInt('0x' + ws[2]); if (n0 > 0n && n0 <= 100n && mx >= need && mx <= (need * 12n) / 10n) { const unit = need / n0; let nn = 10n; while (nn > 1n && Number(unit * nn) / 1e18 > PAID.maxUsd) nn--; const mp = (unit * nn * 105n) / 100n; data = data.slice(0, 10) + w(nn) + ws[1] + w(mp); need = mp; } }
          if (!(need > 0n) || Number(need) / 1e18 > PAID.maxUsd * 1.06) return;
          let ub = big(await call(USDT, '0x70a08231' + wa(W.addr)));
          if (ub < need) { const nb = ((Number(need - ub) / 1e18) * 1.04) / price; if (nb > bal - PAID.keepBnb) return; const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', nb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]); if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 100)); for (let i = 0; i < 30 && ub < need; i++) { await sleep(3000); ub = big(await call(USDT, '0x70a08231' + wa(W.addr))); } if (ub < need) throw new Error('USDT 沒到帳'); }
          await previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(need), 0n, (sim) => ((sim?.allowanceChanges || []).some((a) => String(a.spender).toLowerCase() !== c) ? '授權對象不對' : ''));
          const v = BigInt(P.replay.value || '0'); if (v > 0n && ((Number(v) / 1e18) * 1.005 > bal - PAID.keepBnb || (Number(v) / 1e18) * price > 2)) return; /* 審查修正：付 USDT 的同時若還要附 BNB，也要算進預算 */
          const r = await revokeOnFail(W, USDT, c, async () => { try { data = await safeAddrs(W, c, data, v); data = await fitShares(W, c, data, v); } catch (e) { markUnmintable(c, P, sym, progress); throw e; } return previewExec(W, c, data, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.authorityChanges?.length) return '有權限變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => { const a = String(b.contractAddress).toLowerCase(); return a !== USDT && !a.startsWith('0xeeee'); })) return '會扣到 USDT/BNB 以外的資產';
            if (out.filter((b) => String(b.contractAddress).toLowerCase() === USDT).reduce((a, b) => a - Number(b.change), 0) > Number(need) * 1.01) return '扣的 USDT 超過預算'; return '';
          }); });
          const paidU = (r.sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress).toLowerCase() === USDT && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0) / 1e18; const usd = paidU > 0 ? paidU : Number(need) / 1e18; S.paidSpend[W.name] = spent + usd / price; P.done[W.name] = 'minted'; /* 記實際扣掉的 USDT */
          if (paidU > 0 && paidU < (Number(need) / 1e18) * 0.99) previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(0n), 0n, () => '').catch(() => {}); /* 授權沒用完就收回 */
          if (tokAddr && !S.dyn.some((t) => t.addr === tokAddr.toLowerCase() && t.only === W.addr)) S.dyn.push({ sym, addr: tokAddr.toLowerCase(), cost: +usd.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的方式，付 USDT）\n花約 ${usd.toFixed(2)} USDT · ${progress > 0 ? '進度約 ' + Math.round(progress * 100) + '%' : '最近 ' + (P.replay.hot || 0) + ' 個錢包在打'}\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'replay') {
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = { ...P.replay, ...lr }; } /* 用最新的別人交易（價格參數要新） */
          const v = BigInt(P.replay.value || '0'); const vb = Number(v) / 1e18;
          if (!price || vb * price > PAID.maxUsd || vb * 1.005 > bal - PAID.keepBnb) return;
          let rdata = freshDeadline(P.replay.data); try { rdata = await safeAddrs(W, c, rdata, v); rdata = await fitShares(W, c, rdata, v); } catch { markUnmintable(c, P, sym, progress); return; } /* 審查修正：付 BNB 的照抄也要換掉別人的地址、自動調份數 */
          try { await rpc('eth_call', [{ from: W.addr, to: c, data: rdata, value: '0x' + v.toString(16) }, 'latest']); } catch { markUnmintable(c, P, sym, progress); return; }
          const r = await previewExec(W, c, rdata, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          if (!(v > 0n)) { noteFree(c, W, sym); return; } 
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的鑄造方式）\n花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'recv') {
          const v = BigInt(P.recvValue); const vb = Number(v) / 1e18;
          if (!price || vb * price > PAID.maxUsd || vb * 1.005 > bal - PAID.keepBnb) return;
          try { await rpc('eth_call', [{ from: W.addr, to: c, value: '0x' + v.toString(16) }, 'latest']); } catch { noteFail(c, P, sym, progress); return; } // 不能鑄（沒資格、已打過、額度滿）
          const r = await previewExec(W, c, '0x', v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          });
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          const ta = tokAddr0 || c; if (!S.dyn.some((t) => t.addr === ta && t.only === W.addr)) S.dyn.push({ sym, addr: ta, cost: +(vb * price).toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          await tg(`🛒 [${W.name}] 自動打了「轉 BNB 鑄造」項目：${sym}\n轉 ${vb} BNB（約 ${(vb * price).toFixed(1)}U，${P.recvSeen} 個錢包都轉這個金額）· 進度約 ${Math.round(progress * 100)}%（${how}）\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'gen') {
          let data = '';
          for (; n >= 1; n--) { costWei = unit * BigInt(n); if ((Number(costWei) / 1e18) * 1.005 > bal - PAID.keepBnb || !price || (Number(costWei) / 1e18) * price > PAID.maxUsd) continue; data = '0xa0712d68' + w(n); try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + costWei.toString(16) }, 'latest']); break; } catch {} }
          if (n < 1) { noteFail(c, P, sym, progress); return; }
          const r = await previewExec(W, c, data, costWei, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 BNB 以外或超過價格';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          const vb = Number(costWei) / 1e18; S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%（${sold ?? '?'}／${cap ?? '?'}）\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'bnb') {
          for (; n >= 1; n--) { const q = await call(c, '0x68bce8cd' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && (Number(costWei) / 1e18) * 1.005 <= bal - PAID.keepBnb && price && (Number(costWei) / 1e18) * price <= PAID.maxUsd) break; } // 買得起的最多份數（留 gas）
          if (n < 1) return; // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
          const v = (costWei * 1005n) / 1000n, vb = Number(v) / 1e18;
          if (spent + vb > PAID.maxBnbPerDay || bal - vb < PAID.keepBnb) return;
          const data = '0xe38fd349' + w(n) + wa('0x0000000000000000000000000000000000000000') + w(v);
          try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + v.toString(16) }, 'latest']); } catch { noteFail(c, P, sym, progress); return; } // 還沒開或沒資格
          const pool = tokAddr ? Number(await poolOut(v, WBNB, tokAddr)) : 0;
          const r = await previewExec(W, c, data, v, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（第一原則：進度 ≥80% 照打）`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外的資產或超過報價';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          }, async () => { const q2 = await call(c, '0x68bce8cd' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return c2 > (costWei * 105n) / 100n ? '價格剛剛漲了超過 5%' : ''; }); /* 新功能：送出前再查一次價格 */
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          const usd = vb * price; if (tokAddr && !S.dyn.some((x) => x.addr === tokAddr.toLowerCase() && x.only === W.addr)) S.dyn.push({ sym, addr: tokAddr, cost: +usd.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now(), ...(FORCE.has(c) ? { hold: true } : {}) }); // 使用者指定的項目照免費幣處理：只通知不自動賣
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${usd.toFixed(1)}U）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：3 倍回本、5 倍和 10 倍各賣一半、回落 60% 全賣`);
        } else {
          for (; n >= 1; n--) { const q = await call(c, '0x725c4058' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && price && ((Number(costWei) / 1e18) * 1.03) / price <= bal - PAID.keepBnb && Number(costWei) / 1e18 <= PAID.maxUsd) break; }
          if (n < 1) return; // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
          const cu = Number(costWei) / 1e18, needBnb = (cu * 1.03) / price;
          if (!price || spent + needBnb > PAID.maxBnbPerDay || bal - needBnb < PAID.keepBnb) return;
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
          const r = await revokeOnFail(W, USDT, c, () => previewExec(W, c, data, 0n, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（第一原則：進度 ≥80% 照打）`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => String(b.contractAddress).toLowerCase() !== USDT) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 USDT 以外或超過報價';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          }, async () => { const q2 = await call(c, '0x725c4058' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return c2 > (costWei * 105n) / 100n ? '價格剛剛漲了超過 5%' : ''; })); /* 新功能：送出前再查一次價格 */
          S.paidSpend[W.name] = spent + needBnb; P.done[W.name] = 'minted';
          if (tokAddr && !S.dyn.some((x) => x.addr === tokAddr.toLowerCase() && x.only === W.addr)) S.dyn.push({ sym, addr: tokAddr, cost: +cu.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}\n${n} 份，花 ${cu.toFixed(2)} USDT（由 BNB 換）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：3 倍回本、5 倍和 10 倍各賣一半、回落 60% 全賣`);
        }
      } catch (e) { if (e.message.includes('結果不明')) { P.done[W.name] = 'unknown'; log(`paid ${c} ${W.name} ${e.message}`); await tg(`⚠️ [${W.name}] ${sym} 送出結果不明（逾時），為避免重打已停止，請到錢包確認有沒有打到\n${c}`); return; } if (e.message.includes('已開池')) { P.done[W.name] = 'pool-cheaper'; log(`paid ${c} ${W.name} ${e.message}`); return; } P.fail = (P.fail || 0) + 1; log(`paid ${c} ${W.name} ${e.message}`); if (kind === 'replay' && P.fail >= 2) { markUnmintable(c, P, sym, progress, '照別人的方式預演一直失敗'); return; } if (P.fail >= 6) { P.done[W.name] = 'fail'; await tg(`⚠️ [${W.name}] 付費項目 ${sym} 自動打失敗，已放棄：${e.message.slice(0, 150)}\n${c}`); } }
    }));
    } finally { busyP.delete(c); const dt = Date.now() - tE; if (dt > 10e3) log(`檢查 ${c} 花了 ${Math.round(dt / 1000)} 秒（${mode}）`); }
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
      await tg(`🦋 NFT 成交量變多：${name}\n錢包共持有 ${held} 張\n過去 12 小時 Element 成交 ${f.length} 筆${prev ? '（上次 ' + (prev.f || 0) + ' 筆）' : ''}${px.length ? `，成交價 ${Math.min(...px).toFixed(4)}～${Math.max(...px).toFixed(4)} BNB，合計 ${vol.toFixed(4)} BNB` : ''}\n轉手 ${moves} 次${prev ? '（上次 ' + (prev.t || 0) + ' 次）' : ''}\n${col}\nhttps://element.market/assets/bsc/${col}/1\n要掛單或賣手動處理`);
    }
    S.nftVol[col] = { f: f.length, t: moves, held, at: ts() };
    await sleep(150);
  }
  log(`NFT 成交量檢查完成：${Object.keys(S.nftCols).length} 個系列`);
}


async function manualMints() {
  const f = join(DIR, 'data', 'manual_mint.json'); if (!existsSync(f)) return;
  let jobs = []; try { jobs = JSON.parse(readFileSync(f, 'utf8')); } catch { return; } if (!jobs.length) return;
  writeFileSync(f, '[]');
  for (const J of jobs) {
    const res = await Promise.all(WALLETS.map(async (W) => {
      let ok = 0, err = '';
      if (J.approvals) { /* 列出錢包所有授權，存到 data/approvals_錢包.json（使用者 10/31 10:34：Flap 出事，要取消授權） */
        const r = await W.baw(['approvals', 'list', '--limit', '100']); writeFileSync(join(DIR, 'data', `approvals_${W.name}.json`), r.t || ''); return `[${W.name}] 已列出授權`;
      }
      if (J.revokeAll) { /* 取消指定的授權：[{token, spender, type}] */
        const out = []; for (const x of J.revokeAll) { const r = await W.baw(['approvals', 'revoke', '--binanceChainId', '56', '--tokenContract', x.token, '--spender', x.spender, '--type', x.type || 'approve']); out.push(`${x.token.slice(0, 8)}→${x.spender.slice(0, 8)} ${r.j?.success ? '✅' : '❌ ' + (r.j?.error?.message || r.t).slice(0, 80)}`); }
        writeFileSync(join(DIR, 'data', `revoke_${W.name}.txt`), out.join('\n')); return `[${W.name}] 取消授權：${out.join('；')}`;
      }
      if (J.swapBack) { // 把代幣換回 BNB，並（可選）取消授權
        try {
          const out = [];
          if (J.revoke) { await previewExec(W, J.swapBack, '0x095ea7b3' + wa(J.revoke) + w(0), 0n, () => ''); out.push('已取消授權'); }
          const bal = big(await call(J.swapBack, '0x70a08231' + wa(W.addr)));
          if (bal > 10n ** 16n) { const qty = (Number(bal / 10n ** 14n) / 1e4).toFixed(4); const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', J.swapBack, '--toToken', NATIVE_BNB]); out.push(sw.j?.success ? `已把 ${qty} 換回 BNB` : '換 BNB 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 80)); }
          return `[${W.name}] ${out.join('，') || '沒有需要處理的'}`;
        } catch (e) { return `[${W.name}] ❌ ${e.message.slice(0, 100)}`; }
      }
      if (J.usdt) { // USDT 型：BNB 換 USDT → 授權 → 鑄造（J.data 固定）
        try {
          const need = BigInt(Math.round(J.usdt * 1e6)) * 10n ** 12n; let ub = big(await call(USDT, '0x70a08231' + wa(W.addr)));
          if (ub < need) { const px = await bnbUsd(); const nb = ((Number(need - ub) / 1e18) * 1.04) / px; const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', nb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]); if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 80)); for (let k = 0; k < 30 && ub < need; k++) { await sleep(3000); ub = big(await call(USDT, '0x70a08231' + wa(W.addr))); } if (ub < need) throw new Error('USDT 沒到帳'); }
          await previewExec(W, USDT, '0x095ea7b3' + wa(J.c) + w(need), 0n, (sim) => ((sim?.allowanceChanges || []).some((x) => String(x.spender).toLowerCase() !== J.c) ? '授權對象不對' : ''));
          const r = await revokeOnFail(W, USDT, J.c, () => previewExec(W, J.c, J.data, 0n, (sim) => { const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr); if (mine.some((b) => Number(b.change) < 0 && String(b.contractAddress).toLowerCase() !== USDT)) return '會扣到 USDT 以外的資產'; if (-mine.filter((b) => Number(b.change) < 0).reduce((x, b) => x + Number(b.change), 0) > Number(need) * 1.01) return '扣款超過預期'; return ''; }));
          ok = 1; S.paidSpend = S.paidSpend || {}; if (J.tok) { S.dyn = S.dyn || []; if (!S.dyn.some((t) => t.addr === J.tok && t.only === W.addr)) S.dyn.push({ sym: J.name || 'TOKEN', addr: J.tok, cost: J.usdt, only: W.addr, boughtAt: Date.now() }); }
          return `[${W.name}] ✅ 打到（花約 ${J.usdt}U）交易 ${r.tx}`;
        } catch (e) { return `[${W.name}] ❌ 沒打到（${e.message.slice(0, 100)}）`; }
      }
      for (let i = 0; i < (J.n || 1); i++) {
        const data = J.randArg ? J.sel + w(BigInt(Math.floor(Math.random() * 65536))) : J.data;
        try {
          await previewExec(W, J.c, data, BigInt(J.value || 0), (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            if (mine.some((b) => Number(b.change) < 0 && !String(b.contractAddress).toLowerCase().startsWith('0xeeee'))) return '會扣到其他資產';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          ok++;
        } catch (e) { err = e.message.slice(0, 80); break; }
      }
      if (ok) { S.nftCols = S.nftCols || {}; S.nftCols[J.c] = 1; S.freeTrack = S.freeTrack || {}; S.freeTrack[J.c] = S.freeTrack[J.c] || { at: Date.now() }; }
      return ok ? `[${W.name}] ✅ 打到 ${ok} 份${err ? '（已達這個項目每個錢包的上限）' : ''}` : `[${W.name}] ❌ 沒打到（${/reverted/.test(err) ? '合約不讓這個錢包打，可能已打過、名額滿或需要資格' : err}）`;
    }));
    log(`手動補打 ${J.name || J.c}：${res.join('；')}`);
    await tgSay(`🛠 ${J.swapBack ? '換回 BNB' : '補打'} ${J.name || J.c || ''}\n${res.join('\n')}`);
  }
}
// ── TG 指令：使用者直接在機器人打「賣 XXX」「賣 XXX 一半」「餘額」，幾秒內執行，不經過 Claude ──
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
  // 免費項目：所有「已自動鑄造」的記錄都算（含一發現就馬上打的），用合約地址去重；「現在開了」那種用名稱對回合約；扣掉早上 0 BNB bug 的假鑄造
  const free = new Set(), bog = new Set(), paidC = new Set(); let paid = 0; const n2a = {};
  try {
    const lines = readFileSync(LOG, 'utf8').split('\n');
    for (const l of lines) { const m = l.match(/(?:專屬合約|項目)：([^|（(\n]+?)\s*(?:（[^|]*）)?\s*\|\s*(0x[a-fA-F0-9]{40})/); if (m && !n2a[m[1].trim().toLowerCase()]) n2a[m[1].trim().toLowerCase()] = m[2].toLowerCase(); }
    for (const l of lines) {
      if (l.includes('🛒')) { paid++; const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/); if (c) paidC.add(c[1].toLowerCase()); }
      if (!l.includes('已自動鑄造')) continue;
      const nm = l.match(/項目\s*([^\n（(|]+?)\s*現在開了/); let key = '';
      if (nm) key = n2a[nm[1].trim().toLowerCase()] || 'N:' + nm[1].trim().toLowerCase();
      else { const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/); if (c) key = c[1].toLowerCase(); }
      if (!key) continue;
      (/重播0x(（| \||$)/.test(l) ? bog : free).add(key);
    }
    for (const k of bog) free.delete(k);
  } catch {}
  const tr = S.trades || [], by = {};
  for (const x of tr) { const k = x.sym; by[k] = by[k] || { usd: 0, n: 0 }; by[k].usd += x.usd; by[k].n++; }
  const px = await bnbUsd().catch(() => 0); let tot = 0; for (const W of WALLETS) tot += Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
  const lines = Object.entries(by).map(([k, v]) => `${k}：賣 ${v.n} 筆，拿回約 ${v.usd.toFixed(2)}U`);
  await tgSay(`📊 戰績\n自動打的免費項目：${free.size} 個\n付費打的：${paidC.size} 個項目（${paid} 筆）\n${lines.length ? '有記錄的賣出：\n' + lines.join('\n') + '\n' : ''}錢包現在共 ${tot.toFixed(4)} BNB（約 ${(tot * px).toFixed(2)}U）`);
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
          const half = !!mm[2]; await tgSay(`⚡ 收到，${mm[1]} 所有錢包${half ? '各賣一半' : '全部賣出'}中…`);
          cmdSell(mm[1], half).catch((e) => tgSay('⚠️ 賣出出錯：' + e.message));
        } else if ((mm = txt.match(/^(\S+?)\s*(?:出一半|賣一半|卖一半)$/i))) {
          await tgSay(`⚡ 收到，${mm[1]} 所有錢包各賣一半中…`); cmdSell(mm[1], true).catch((e) => tgSay('⚠️ 賣出出錯：' + e.message));
        } else if (/^(餘額|余额|錢包|钱包|balance)$/i.test(txt)) { cmdBalance().catch(() => {}); }
        else if (/^(持倉|持仓|holdings?)$/i.test(txt)) { cmdHold().catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(戰績|战绩|統計|统计|stats?)$/i.test(txt)) { cmdStats().catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(help|指令|說明|说明)$/i.test(txt)) await tgSay('可用指令：\n賣 XXX → 所有錢包全賣\n賣 XXX 一半 → 各賣一半\n（也可打「XXX 全出」「XXX 出一半」）\n餘額 → 看各錢包 BNB\n持倉 → 還沒賣的幣和現值\n戰績 → 上線以來打了多少、賣了多少');
      }
    } catch { await sleep(3000); }
  }
}

let lastLoopAt = Date.now();
setInterval(() => { if (Date.now() - lastLoopAt > (INFLIGHT > 0 ? 11 : 8) * 60e3) { log('看門狗：主迴圈卡住超過 8 分鐘，自動重啟'); try { save(); } catch {} process.exit(1); } }, 30e3).unref();
async function main() {
  log('启动监测');
  tgCmdLoop().catch((e) => log('tgCmd ' + e.message));
  let lastHold = 0, lastLogin = 0;
  for (;;) {
    try { if (statSync(SELF).mtimeMs !== SELF_MT) { if (INFLIGHT > 0 && !globalThis._waitSince) globalThis._waitSince = Date.now(); if (INFLIGHT === 0 || Date.now() - (globalThis._waitSince || 0) > 240e3) { log('程序更新，重启'); save(); process.exit(0); } } } catch {} // 有交易正在送出就先等它送完（最多 4 分鐘）
    if (existsSync(join(DIR, 'WATCH_STOP'))) { log('WATCH_STOP，退出'); save(); process.exit(0); }
    try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const tS = Date.now(); await scanNew(head); if (Date.now() - tS > 20e3) log(`掃描一輪花了 ${Math.round((Date.now() - tS) / 1000)} 秒`);
      { const fast = Object.values(S.tokens).some((st) => st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done); const full = Date.now() - lastHold > 5000; if (!globalThis._holdBusy && (fast || full)) { if (full) lastHold = Date.now(); globalThis._holdBusy = true; const tH = Date.now(); holdings(head, !full).catch((e) => log('holdings ' + e.message)).finally(() => { globalThis._holdBusy = false; if (Date.now() - tH > 20e3) log(`持倉檢查花了 ${Math.round((Date.now() - tH) / 1000)} 秒`); }); } } /* 持倉檢查放背景，同時只跑一個，避免重複賣 */
      if (!globalThis._flapAt || Date.now() - globalThis._flapAt > 30e3) { globalThis._flapAt = Date.now(); if (!globalThis._flapBusy) { globalThis._flapBusy = true; flapAgentWatch().catch((e) => log('flap ' + e.message)).finally(() => { globalThis._flapBusy = false; }); } }
      if (!globalThis._toshAt || Date.now() - globalThis._toshAt > 60e3) { globalThis._toshAt = Date.now(); if (!globalThis._toshBusy) { globalThis._toshBusy = true; toshWatch().catch((e) => log('tosh ' + e.message)).finally(() => { globalThis._toshBusy = false; }); } }
      if (!globalThis._miscAt || Date.now() - globalThis._miscAt > 600e3) { globalThis._miscAt = Date.now(); lowBnbWatch().catch(() => {}); flapApprovalWatch().catch((e) => log('flapApproval ' + e.message)); } /* 每 10 分鐘看 BNB 夠不夠 */
      dailyReport().catch((e) => log('daily ' + e.message));
      if (!globalThis._pruneAt || Date.now() - globalThis._pruneAt > 3600e3) { globalThis._pruneAt = Date.now(); pruneState(); }
      if (!globalThis._aidropAt || Date.now() - globalThis._aidropAt > 120e3) { globalThis._aidropAt = Date.now(); const tA = Date.now(); await aidropWatch(head); if (Date.now() - tA > 20e3) log(`aidrop 檢查花了 ${Math.round((Date.now() - tA) / 1000)} 秒`); }
      if (!globalThis._paidBusy && (!globalThis._paidAt || Date.now() - globalThis._paidAt > 15e3)) { globalThis._paidAt = Date.now(); globalThis._paidBusy = true; paidLoop('hot').catch((e) => log('paidLoop ' + e.message)).finally(() => { globalThis._paidBusy = false; globalThis._paidDur = Math.round((Date.now() - globalThis._paidAt) / 1000); }); } // 快速檢查：每 15 秒
      if (!globalThis._restBusy && (!globalThis._restAt || Date.now() - globalThis._restAt > 60e3)) { globalThis._restAt = Date.now(); globalThis._restBusy = true; paidLoop('rest').catch((e) => log('paidRest ' + e.message)).finally(() => { globalThis._restBusy = false; }); } // 一般檢查：約每分鐘 // 背景跑，不卡住掃描
      if (!globalThis._smartBusy && Date.now() - (S.smartAt || 0) > 6 * 3600e3) { S.smartAt = Date.now(); globalThis._smartBusy = true; buildSmart().catch((e) => log('smart ' + e.message)).finally(() => { globalThis._smartBusy = false; }); }
      if (!globalThis._mmBusy && existsSync(join(DIR, 'data', 'manual_mint.json'))) { globalThis._mmBusy = true; manualMints().catch((e) => log('manual ' + e.message)).finally(() => { globalThis._mmBusy = false; }); }
      if (!globalThis._heatBusy && Date.now() - (globalThis._heatAt || 0) > 20e3) { globalThis._heatAt = Date.now(); globalThis._heatBusy = true; heatWatch().catch((e) => log('heatWatch ' + e.message)).finally(() => { globalThis._heatBusy = false; }); } // 熱度監測（背景）
      if (!globalThis._fpBusy && Date.now() - (globalThis._fpAt || 0) > 300e3) { globalThis._fpAt = Date.now(); globalThis._fpBusy = true; freeProgWatch().catch((e) => log('freeProg ' + e.message)).finally(() => { globalThis._fpBusy = false; }); } // 免費項目進度，每 5 分鐘
      if (!globalThis._nftBusy && Date.now() - (S.nftVolAt || 0) > 12 * 3600e3) { S.nftVolAt = Date.now(); globalThis._nftBusy = true; nftVolWatch().catch((e) => log('nftVol ' + e.message)).finally(() => { globalThis._nftBusy = false; }); } // 12 小時看一次 NFT 成交量（背景）
      if (Date.now() - lastLogin > 600e3) { lastLogin = Date.now(); loginCheck().catch(() => {}); }
      lastLoopAt = Date.now(); save(); writeFileSync(join(DIR, 'data', 'watch_heartbeat.txt'), ts() + ' 掃描落後 ' + (S.scanLag ?? '?') + ' 塊 · 付費檢查一輪 ' + (globalThis._paidDur ?? '?') + ' 秒');
      if ((S.scanLag || 0) > 400 && Date.now() - (S.lagAlert || 0) > 3600e3) { S.lagAlert = Date.now(); await tg(`⚠️ 新合約掃描落後 ${S.scanLag} 個區塊（約 ${Math.round(S.scanLag * 0.45 / 60)} 分鐘），可能是公用節點變慢，手動處理`); }
    } catch (e) { log('出错 ' + e.message); }
    await sleep(1000);
  }
}
process.on('uncaughtException', (e) => log('uncaught ' + e.message));
process.on('unhandledRejection', (e) => log('unhandled ' + (e?.message || e)));
main();
