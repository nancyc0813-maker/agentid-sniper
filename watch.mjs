// Agent ID Sniper — 幣安 Agentic Wallet（.ai Agent ID）專屬鑄造監控 + 自動鑄造 + 持倉自動止盈。
// 全部在本地跑：掃 BSC 新合約 → 模擬 → 用 baw CLI 自動打 → 開池後照規則自動賣 → Telegram 通知。不使用任何 AI。
// 停止：在同資料夾放 WATCH_STOP 檔。設定見 config.example.json。
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync, readFileSync, existsSync, statSync, renameSync, copyFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url), SELF_MT = statSync(SELF).mtimeMs;
const LOG = join(DIR, 'data', 'watch.log'), STATE = join(DIR, 'data', 'watch_state.json');
if (process.argv.includes('--tg-login')) { /* 選用功能：TG 群組監控的一次性登入（金鑰、手機、登入碼都由使用者自己在這個視窗輸入，只存在本機 data/tg_user.json） */
  const { createRequire } = await import('node:module'); const req = createRequire(import.meta.url); const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout }); const ask = (q) => new Promise((r) => rl.question(q, (x) => r(x.trim())));
  try { req.resolve('telegram'); } catch { console.log('第一次使用，正在安裝 TG 套件（約 20MB）…'); (await import('node:child_process')).execSync('npm i telegram@2.26.22 --no-audit --no-fund', { cwd: DIR, stdio: 'inherit', shell: true }); }
  const { TelegramClient } = req('telegram'); const { StringSession } = req('telegram/sessions');
  console.log('=== TG 群組監控：一次性登入（只讀你加入的群，不會發任何訊息）===\n先到 my.telegram.org 網站 → API development tools 建立一個 App（平台選 Desktop），就會看到 api_id 和 api_hash\n');
  const apiId = Number(await ask('api_id（一串數字）：')), apiHash = await ask('api_hash（一串英文數字）：');
  if (!apiId || !/^[0-9a-f]{32}$/i.test(apiHash)) { console.log('格式不對，請重新執行'); process.exit(1); }
  const cl = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
  await cl.start({ phoneNumber: () => ask('手機號碼（含國碼、去掉開頭的 0，例如 +886912345678）：'), phoneCode: () => ask('登入碼（在 TG App 裡官方「Telegram」帳號傳給你的訊息）：'), password: () => ask('兩步驟驗證密碼（沒設定就直接按 Enter）：'), onError: (e) => console.log('錯誤：', e.message) });
  mkdirSync(join(DIR, 'data'), { recursive: true }); writeFileSync(join(DIR, 'data', 'tg_user.json'), JSON.stringify({ apiId, apiHash, session: cl.session.save() }));
  console.log('\n✅ 登入成功，工具會自動讀你加入的群組（只讀不發）。這個視窗可以關掉了。\n⚠️ data/tg_user.json 等於你的 TG 登入，不要傳給別人；不想用了就刪掉這個檔案。'); await cl.disconnect(); rl.close(); process.exit(0);
}
{ /* 審查 11/1：同時跑兩份會重複鑄造、重複賣、互相覆蓋紀錄 → 只允許一份在跑 */ const lk = join(DIR, 'data', 'watch.lock'); try { const old = existsSync(lk) ? Number(readFileSync(lk, 'utf8')) : 0; if (old && old !== process.pid) { let alive = false; try { process.kill(old, 0); alive = true; } catch {} if (alive) { console.log(`已經有一份在執行（PID ${old}），這份不重複啟動`); process.exit(0); } } writeFileSync(lk, String(process.pid)); process.on('exit', () => { try { if (Number(readFileSync(lk, 'utf8')) === process.pid) unlinkSync(lk); } catch {} }); } catch {} }
const ts = () => new Date().toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' });
const log = (s) => { try { appendFileSync(LOG, `[${ts()}] ${s}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const USDT = '0x55d398326f99059ff775485246999027b3197955', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';
const NATIVE_BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // 賣出一律換回 BNB
const ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e', FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const REGISTRY = '60b9262456de011f7d15a54cdd8c48baaa8b022f'; // 幣安 Agent ID 登記合約：合約碼裡出現它 = 只限 Agent ID
const INFRA = new Set(['0x' + REGISTRY]); // Agent ID 登記合約本身不是鑄造項目（用户反馈 v2.4.4：开源版漏了这一行，ReferenceError: INFRA is not defined）
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

// 手動追蹤的持倉（config.json 的 tokens）。cost = 每個錢包的成本（U）；both = 每個錢包都有這個成本；hold = 不自動賣只通知；sellNow = 立刻全部賣出
const TOKENS = (CONFIG.tokens || []).map((t) => ({ ...t, addr: t.addr.toLowerCase() }));
// 賣出規則（付費幣到價就執行；免費幣只通知），可在 config.json 的 rules 覆寫
const ruleTxt = () => `${RULE.backX} 倍回本、${(RULE.steps || []).map(([x, p]) => `${x} 倍賣 ${p}%`).join('、')}；回本前從最高回落 ${Math.round(RULE.crash * 100)}% 全賣，回本後回落 ${Math.round((RULE.crashAfterBack || RULE.crash) * 100)}% 才賣${RULE.moonPct ? `，並留 ${RULE.moonPct}% 長抱只通知` : ''}`;
const RULE = {
  // 使用者 11/1 00:30 改的付費幣規則（到價就執行）：2 倍 → 賣回本錢；10 倍 → 賣剩下的 30%；20 倍 → 再賣剩下的 50%；其餘不動，從最高點回落 40% → 全部賣
  backX: 2, steps: [[10, 30], [20, 50]], crash: 0.4,
  crashAfterBack: 0.6, moonPct: 20, moonNotifyX: [50, 100], // 使用者 11/1 13:54：回本後回落門檻放寬到 60%；回本後留 20% 長抱，不自動賣，只在 50／100 倍通知
  fastMin: 30, fastCrash: 0.4,  // 開池 30 分鐘內檢查得比較密（回落門檻一樣 40%）
  stallSec: 300, drop: 0.5, // 免費幣：從最高回落 50% 全賣（不變）
  notifyX: [5, 10, 20],
  ...(CONFIG.rules || {}),
};

let TG = null;
{ const a = CONFIG.telegram?.botToken || process.env.TG_BOT_TOKEN, b = CONFIG.telegram?.chatId || process.env.TG_CHAT_ID; if (a && b) TG = { a, b }; }
// 使用者定：只有要買賣、要使用者決定的才響鈴；其他（自動鑄、收到幣、登入成功…）靜音送達
const isFreeMintNote = (t) => /^🆓/u.test(t) || (/^🆕/u.test(t) && t.includes('🤖 已自動鑄造'));
const important = (t) => !isFreeMintNote(t) && (/^(⏰|⚠️|🔑|💰|🔥|🚀|🦋|🏗|🛒)/u.test(t) || t.includes('不是免費')); 

const sendable = (t) => (!GROUP_ID && /^(🛒|🚀)/u.test(t)) || /^(💰|🔑|⏰|🦋)/u.test(t) /* 使用者 10/31 05:11：免費項目不發個人 TG；10/31 21:17：打到項目（🛒）和開盤（🚀）只發大群，不發個人 TG（一直響） */ || (/^🚀/u.test(t) && t.includes('平台幣')) || (/^🔥/u.test(t) && /\d+ 倍/.test(t) && !t.includes('搶打')) || (/^⚠️/u.test(t) && /(想賣但失敗|回調|回落|登入|開發者模式|打不了|自動打失敗|掃描落後|結果不明|BNB 快不夠|賣不出|貔貅|Flap)/.test(t));

const GROUP_ID = CONFIG.telegram?.groupChatId || ''; // 可選：也發到 TG 群（買入、開池、倍數、賣出）
const groupSent = new Map();
async function toGroup(text) { 
  if (!TG || !GROUP_ID) return;
  let msg = '', key = '';
  const ca = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0] || '';
  
  if (/^🛒/u.test(text)) { const name = (text.match(/項目[：:]\s*([^\n（(|]+)/) || [])[1]?.trim() || ''; const pct = (text.match(/進度約?\s*(\d+)%/) || [])[1]; msg = `🎯 打了付费项目：${name || '新项目'}${pct ? `（铸造进度约 ${pct}%）` : ''}\n合约：${ca}`; key = 'mint:' + ca.toLowerCase(); }
  /* 使用者 10/31 20:48：打到什麼都在大群通知（免費也發），開盤也通知 */
  if (!msg && /^🆓/u.test(text)) { const name = (text.match(/項目[：:]\s*([^\n（(]+)/) || [])[1]?.trim() || ''; msg = `🎁 打了免费项目：${name || '新项目'}\n合约：${ca}`; key = 'free:' + ca.toLowerCase(); }
  if (!msg && /^🚀/u.test(text) && text.includes('開池')) { const sym = (text.match(/^🚀\s*(\S+)/u) || [])[1] || ''; const tok = (text.match(/合約 (0x[a-fA-F0-9]{40})/) || [])[1] || ca; msg = `🚀 ${sym} 开盘了${(text.match(/開池了（([^）]+)）/) || [])[1] ? '（' + text.match(/開池了（([^）]+)）/)[1].replace('配對', '配对') + '）' : ''}\n合约：${tok}`; key = 'open:' + tok.toLowerCase(); }
  if (!msg && /^⚠️ 很熱門但工具打不了/u.test(text)) { const m = text.match(/打不了：(.+?)（(\d+) 個錢包在打(?:，進度約 (\d+)%)?）/u); msg = `🔥 很热门但雷达打不了：${m?.[1] || '新项目'}${m ? `（${m[2]} 个钱包在打${m[3] ? `，进度约 ${m[3]}%` : ''}）` : ''}\n要的话请自己到官网手动打\n合约：${ca}`; key = 'hot:' + ca.toLowerCase(); }
  if (!msg || !ca) return;
  { const cl = ca.toLowerCase(); S.grpOnce = S.grpOnce || {}; const gk = (key.startsWith('open:') || key.startsWith('hot:')) ? key : cl; if (S.grpOnce[gk]) return; S.grpOnce[gk] = 1; } /* 同一個合約群裡只播一次（打到／70% 擇一，開盤另外播） */
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
  S.g70[c] = 'wait'; await sleep(90e3); /* 使用者 10/31 21:18：同一個項目群裡只播一次——先等 90 秒，期間如果我們打到了，就只發「打了」那則 */
  if (S.grpOnce?.[c]) { S.g70[c] = 'merged'; return; }
  { /* 使用者 11/1 19:47：大群播報要先過安全檢查——Zora 這種大量部署、自己灌進度的騙局不能推給群友 */
    const sd = await serialDev(c).catch(() => ''); if (sd) { S.g70[c] = 'skip-serial'; log(`群播報略過 ${name || c}：${sd}`); return; }
    const ao = await agentOnly(c).catch(() => ''); if (!ao) { S.g70[c] = 'skip-notagent'; log(`群播報略過 ${name || c}：不是 Agent ID 專屬項目`); return; }
    const P = S.paid?.[c]; if (P) { if (!P.heatAt || Date.now() - P.heatAt > 120e3) await heatOf(c, P).catch(() => {}); }
    const ag = P?.agents || 0; if (ag < AG_MIN) { S.g70[c] = 'skip-agents'; log(`群播報略過 ${name || c}：只有 ${ag} 個 Agent ID 錢包在打（要 ${AG_MIN} 個以上）`); return; }
  }
  S.g70[c] = ts(); S.grpOnce = S.grpOnce || {}; S.grpOnce[c] = 1;
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
  if (st.hpChecked || !st.pair || !/^0x[0-9a-f]{40}$/.test(st.pair) || !(bal > 0n)) return; st.hpChecked = 1;
  try { await rpc('eth_call', [{ from: W.addr, to: t.addr, data: '0xa9059cbb' + wa(st.pair) + w(bal / 100n || 1n) }, 'latest']); }
  catch (e) { await tg(`⚠️ [${W.name}] ${t.sym} 開池了，但模擬賣出失敗，可能是貔貅（只能買不能賣），自動賣出可能會失敗\n${t.addr}`); }
}
async function approvalPatrol() { /* 11/2 BDOG 被盗事件后加的「授权巡逻」：每 10 分钟看两个钱包的授权，无限额度给不认识的合约 → 自动取消并通知 */
  S.apSeen = S.apSeen || {};
  for (const W of WALLETS) { const r = await W.baw(['approvals', 'list', '--limit', '100']); const L = r.j?.data?.list || []; if (!r.j?.success) continue;
    for (const x of L) { const sp = String(x.spender || '').toLowerCase(), tk = String(x.tokenContract || '').toLowerCase(), nm = String(x.spenderName || x.spenderLabel || ''), amt = String(x.amount ?? x.allowance ?? x.value ?? '');
      const known = /pancake|binance|1inch|okx|uniswap|permit2|router|aggregator|kyber|paraswap|0x ?protocol/i.test(nm);
      const unlimited = /unlimit|infinite|max/i.test(amt) || amt.replace(/\D/g, '').length >= 30 || x.isUnlimited === true;
      const key = W.addr + sp + tk; if (known) continue;
      if (unlimited) { const rv = await W.baw(['approvals', 'revoke', '--binanceChainId', String(x.binanceChainId || x.chainId || 56), '--tokenContract', x.tokenContract, '--spender', x.spender, '--type', x.type || 'approve']); const ok = !!rv.j?.success; log(`[授权巡逻][${W.name}] 无限授权 ${x.tokenSymbol || tk} → ${nm || sp}：${ok ? '已取消' : '取消失败'}`); if (!S.apSeen[key]) { S.apSeen[key] = Date.now(); await tg(`⚠️ [${W.name}] 发现无限额度授权：${x.tokenSymbol || tk} → ${nm || sp}\n${ok ? '✅ 已自动取消' : '❌ 自动取消失败，请到 revoke.cash 手动取消'}`).catch(() => {}); } }
      else if (!S.apSeen[key]) { S.apSeen[key] = Date.now(); await tg(`⚠️ [${W.name}] 有一笔授权给不认识的合约：${x.tokenSymbol || tk} → ${nm || sp}（额度 ${amt || '?'}）\n如果不是你做的，请到 revoke.cash 取消`).catch(() => {}); }
    } }
  save();
}
async function flapApprovalWatch() { if (!FLAP_BAN) return; /* 每 10 分鐘查一次錢包授權：有授權給 Flap 就立刻取消並通知（換幣路由可能自己產生授權） */
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
  cut(S.seenMints, 30000); cut(S.g70, 3000); cut(S.grpOnce, 5000); cut(S.missed, 500); cut(S.deployer, 20000);
  if (S.trades?.length > 1000) S.trades = S.trades.slice(-1000);
  for (const st of Object.values(S.tokens || {})) if (st.holders) cut(st.holders, 20000);
}
async function dailyReport() { /* 新功能：每天晚上 9 點（台北）自動發戰績＋持倉 */
  const tp = new Date(Date.now() + 8 * 3600e3); const day = tp.toISOString().slice(0, 10);
  if (tp.getUTCHours() !== 21 || S.dailyAt === day) return; S.dailyAt = day; save();
  let um = 0; try { const today = ts().split(/\s/)[0]; /* 審查 11/1：日誌日期是 2026/11/1（沒有補 0），以前比對不到 */ um = new Set(readFileSync(LOG, 'utf8').split('\n').filter((l) => l.startsWith('[' + today) && l.includes('] 打不了 ')).map((l) => (l.match(/0x[a-f0-9]{40}/) || [''])[0])).size; } catch {}
  const today2 = ts().split(/\s/)[0]; const ms = Object.entries(S.missed || {}).filter(([, m]) => String(m.at).startsWith(today2)).slice(-8);
  const missTxt = ms.length ? `\n今天快賣完卻沒打到的 ${ms.length} 個：\n` + ms.map(([c, m]) => `· ${m.name}：${m.why}`).join('\n') : '\n今天沒有錯過快賣完的項目';
  await tgSay(`🌙 每日總結（晚上 9 點自動發）${missTxt}\n今天有 ${um} 個項目打不了（要官網簽名、白名單或模擬失敗），只記在紀錄裡${UPD.on ? `\n\n官方群：${UPD.group}` : ''}`); await cmdStats().catch(() => {}); /* 持倉總結改由 holdReport 在 1 點／13 點發 */
}
async function lockNote(c, wAddr) { /* 買到的幣現在能不能轉：模擬轉 1 單位到黑洞地址，被擋就提醒（像 aiagentbsc 的白名單鎖）（使用者 10/30 21:44 要補的漏洞） */
  const toks = [...new Set([c, ...(S.dyn || []).filter((t) => t.only === wAddr).slice(-3).map((t) => t.addr)])];
  for (const t of toks) { const dR = await call(t, '0x313ce567'); if (!(dR && dR.length >= 66)) continue; /* NFT 沒有小數位數，不能用轉代幣的方式測（以前 NFT 會誤報轉不出去） */ const b = big(await call(t, '0x70a08231' + wa(wAddr))); if (!(b > 0n)) continue;
    try { await rpc('eth_call', [{ from: wAddr, to: t, data: '0xa9059cbb' + wa('0x000000000000000000000000000000000000dead') + w(1n) }, 'latest']); return ''; }
    catch (e) { return `\n⚠️ 這個幣現在轉不出去（${String(e.message).slice(0, 40)}）：可能要等開發者開放交易，也可能是貔貅`; } }
  return '';
}
async function tg(text) { if (/^🛒/u.test(text)) { const m = text.match(/\n(0x[a-fA-F0-9]{40})\n/); if (m) { text += await riskNote(m[1].toLowerCase()); const wn = (text.match(/^🛒 \[([^\]]+)\]/u) || [])[1]; const W = WALLETS.find((x) => x.name === wn); if (W) text += await lockNote(m[1].toLowerCase(), W.addr).catch(() => ''); } } log('TG: ' + text.replace(/\n/g, ' | ')); toGroup(text).catch(() => {}); if (!TG || (!CONFIG.notifyAll && !sendable(text))) return; try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text, disable_web_page_preview: true, disable_notification: !important(text) }), signal: AbortSignal.timeout(10000) }); } catch {} }

const RPCS = Array.isArray(CONFIG.rpcs) && CONFIG.rpcs.length ? CONFIG.rpcs : ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://binance.llamarpc.com']; // 可在 config.json 的 rpcs 换成自己的节点（公共节点常被限流）
let ri = 0;
async function rpc(method, params) {
  let last; for (let i = 0; i < RPCS.length; i++) { const u = RPCS[(ri + i) % RPCS.length]; try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) })).json(); if (r.error) throw new Error(r.error.message); ri = (ri + i) % RPCS.length; return r.result; } catch (e) { last = e; } }
  throw last;
}
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const wa = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const big = (h) => (h && h !== '0x' ? BigInt(h.slice(0, 66)) : 0n);
async function usdtFree(W) { const b = (await usdtFree(W)); if (W !== WALLETS[0]) return b; const r = BigInt(Math.floor((globalThis.PLUG_RESERVE_FN?.() || 0) * 1e6)) * 10n ** 12n; return b > r ? b - r : 0n; } /* 11/2：扣掉外挂今天还要用的 USDT，雷达铸造不会吃掉外挂的本金（不够就照旧把 BNB 换成 USDT） */
const parseOut = (res) => (e, so, se) => { const t = String(so || se || e?.message || ''); let j = null; try { j = JSON.parse(t.slice(t.indexOf('{'))); } catch {} res({ t, j }); };
// 每個錢包一個 baw（幣安 Agentic Wallet CLI）。第二個以後的錢包用獨立的 BINANCE_BAW_DIR / BINANCE_INSTANCE_ID（見 README）
function makeBaw(wc) {
  if (!wc.bawDir) return (args, timeout = 180000) => new Promise((res) => execFile('baw', [...args, '--json'], { shell: true, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res)));
  const env = { ...process.env, BINANCE_BAW_DIR: join(DIR, wc.bawDir), BINANCE_INSTANCE_ID: wc.instanceId || wc.name };
  const bin = join(DIR, wc.bawPkg || 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js');
  return (args, timeout = 180000) => new Promise((res) => execFile(process.execPath, [bin, ...args, '--json'], { env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res)));
}
/* 罗宾猫雷达 11/2（她：要能加钱包、删钱包）：雷达「设定 → 钱包」新增／移除的钱包存在 data/radar_wallets_cfg.json；每个新钱包用自己的登入资料夹（data/baw_xxx），互不影响 */
const WCFG = (() => { try { return JSON.parse(readFileSync(join(DIR, 'data', 'radar_wallets_cfg.json'), 'utf8')); } catch { return { add: [], hidden: [] }; } })();
const BAW_BIN = join(DIR, 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js');
const bawFor = (w) => { const env = { ...process.env, BINANCE_BAW_DIR: join(DIR, 'data', w.bawDir), BINANCE_INSTANCE_ID: w.instanceId }; return (args, timeout = 180000) => existsSync(BAW_BIN) ? new Promise((res) => execFile(process.execPath, [BAW_BIN, ...args, '--json'], { env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res))) : new Promise((res) => execFile('baw', [...args, '--json'], { shell: true, env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res))); };
const wHidden = new Set((WCFG.hidden || []).map((a) => String(a).toLowerCase()));
const WALLETS = (CONFIG.wallets || []).map((wc) => ({ name: wc.name, addr: wc.address.toLowerCase(), baw: makeBaw(wc) }));
for (const w of WCFG.add || []) { if (/^0x[0-9a-fA-F]{40}$/.test(w.address) && !WALLETS.some((x) => x.addr === w.address.toLowerCase())) WALLETS.push({ name: String(w.name).slice(0, 30), addr: w.address.toLowerCase(), baw: bawFor(w), added: 1 }); }
{ const keep = WALLETS.filter((w) => !wHidden.has(w.addr)); if (keep.length) WALLETS.splice(0, WALLETS.length, ...keep); } /* 至少留一个钱包 */
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
const XQ = ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', '0x205812cdbed920aff76c6580abd681a46d11efc7', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1']; /* 使用者 10/31 19:49：币安无忧 的池子是跟 BNCB（Flap 系報價幣）配對，以前只看 BNB/USDT/USD1 漏掉了 */
const dsCache = new Map();
async function dexScreener(addr) { /* 使用者 10/31 19:55：不管跟什麼幣配對、在哪個 DEX（V2／V3／其他），都要查得到開盤——用 DexScreener 當保險（60 秒快取） */
  const k = dsCache.get(addr); if (k && Date.now() - k.t < 60e3) return k.v;
  let v = null; try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr, { signal: AbortSignal.timeout(10000) })).json(); const ps = (j.pairs || []).filter((p) => p.chainId === 'bsc' && String(p.baseToken?.address || '').toLowerCase() === addr && (p.liquidity?.usd || 0) > 50); if (ps.length) { ps.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)); const p = ps[0]; v = { pair: String(p.pairAddress).toLowerCase(), dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('') : ''), quote: p.quoteToken?.symbol || '', px: Number(p.priceUsd) || 0, liq: p.liquidity?.usd || 0 }; } } catch {}
  if (!v) v = await geckoPool(addr); /* 除錯 11/1：NOV 的池子開在 PancakeSwap Infinity，DexScreener 一直沒收錄，工具以為沒開盤、也讀不到價格 → 再用 GeckoTerminal 查（Infinity、Uniswap v4、V3 都有） */
  dsCache.set(addr, { t: Date.now(), v }); return v;
}
async function geckoPool(addr) {
  try {
    const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${addr}/pools`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })).json();
    const ps = (j.data || []).map((p) => { const a = p.attributes || {}, base = String(p.relationships?.base_token?.data?.id || '').toLowerCase().endsWith(addr); return { id: String(a.address || '').toLowerCase(), name: a.name || '', dex: String(p.relationships?.dex?.data?.id || 'gecko'), px: Number(base ? a.base_token_price_usd : a.quote_token_price_usd) || 0, liq: Number(a.reserve_in_usd) || 0 }; }).filter((x) => x.px > 0 && x.liq > 50).sort((x, y) => y.liq - x.liq);
    if (!ps.length) return null; const p = ps[0];
    return { pair: /^0x[0-9a-f]{40}$/.test(p.id) ? p.id : 'gt:' + p.id, dex: p.dex, quote: (p.name.split('/')[1] || '').trim().split(' ')[0], px: p.px, liq: p.liq };
  } catch { return null; }
}
async function poolOpen(tk) { /* 有沒有已經開池（任何配對、任何 DEX）：V2 常見報價幣＋DexScreener（審查修正） */
  for (const q of [WBNB, USDT, USD1, ...XQ]) { const pr = await cc(FACTORY, '0xe6a43905' + wa(tk) + wa(q), 60e3); if (pr && BigInt(pr) > 0n) { const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n) return true; } }
  return !!(await dexScreener(tk));
}
async function findPair(t) {
  for (const q of [USDT, WBNB, USD1, ...XQ]) { const r = await call(FACTORY, '0xe6a43905' + wa(t.addr) + wa(q)); const p = r ? '0x' + r.slice(-40) : null; if (!p || /^0x0{40}$/.test(p)) continue; const rs = await call(p, '0x0902f1ac'); if (!rs || BigInt('0x' + rs.slice(2, 66)) === 0n || BigInt('0x' + rs.slice(66, 130)) === 0n) continue; /* 有池子但沒加流動性 = 還沒真的開盤 */ return { pair: p, quote: q }; }
  { const d = await dexScreener(t.addr); if (d) return { pair: d.pair, ds: 1, dex: d.dex, quote: d.quote }; } /* V2 的 BNB/USDT/USD1/Flap 報價幣都沒有 → 用 DexScreener 找任何池子 */
  return null;
}
async function valueUsd(t, amt) { // 全部賣掉約可換多少 USDT
  if (amt <= 0n) return 0;
  let best = null; for (const path of [[t.addr, USDT], [t.addr, WBNB, USDT], [t.addr, USD1], ...XQ.flatMap((q) => [[t.addr, q, WBNB, USDT], [t.addr, q, USDT]])]) { const r = await call(ROUTER, '0xd06ca61f' + w(amt) + w(64) + w(path.length) + path.map(wa).join('')); if (r) { const x = Number(BigInt('0x' + r.slice(-64))) / 1e18; if (best == null || x > best) best = x; } } // 審查修正：取所有池子裡最好的價格，避免被很小的池子誤判
  if (best != null && best > 0) { const d = await dexScreener(t.addr); if (d?.px && d.liq > 2000) { const dec = await tokDec(t.addr).catch(() => 18); const dv = Math.min((Number(amt) / 10 ** dec) * d.px * 0.97, d.liq * 0.3); if (dv > best * 1.5) best = dv; } } /* 審查修正：有很小的 V2 池子、但真正的大池子在別處時，用大池子的價格，避免誤判成暴跌而賣掉 */
  if (best == null) { const d = await dexScreener(t.addr); if (d?.px) { const dec = await tokDec(t.addr).catch(() => 18); best = Math.min((Number(amt) / 10 ** dec) * d.px * 0.97, d.liq * 0.3); } /* 小池子：最多估到池子流動性的 3 成，避免高估 */ } /* 路由算不出來（V3／其他 DEX／其他報價幣）→ 用 DexScreener 價格估，打 97 折當滑價 */
  return best;
}
async function flow(t, st, from, to) { // 新錢包數、成交筆數
  try {
    const tr = await rpc('eth_getLogs', [{ address: t.addr, topics: [T_TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    st.holders = st.holders || {}; let fresh = 0;
    for (const l of tr) { const toA = '0x' + l.topics[2].slice(26); if (!st.holders[toA]) { st.holders[toA] = 1; fresh++; } }
    let swaps = 0; if (st.pair && /^0x[0-9a-f]{40}$/.test(st.pair)) swaps = (await rpc('eth_getLogs', [{ address: st.pair, topics: [T_SWAP], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])).length;
    return { fresh, swaps };
  } catch { return { fresh: 0, swaps: 0 }; }
}
const decCache = new Map();
async function tokDec(a) { if (!decCache.has(a)) { const r = await call(a, '0x313ce567'); const d = r && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : 18; decCache.set(a, d > 0 && d <= 36 ? d : 18); } return decCache.get(a); }
function trackFromSim(W, sim, sym, costUsd) { /* 打到的代幣自動加入持倉監控（以前照抄型付費、手動補打不會加，像 币安无忧 就沒被追蹤）（使用者 10/31 20:13） */
  { /* 使用者 11/1 18:15：付了錢成本卻記成 0（SENSEI 這次）→ 用模擬裡實際付出的 BNB／USDT 補算，並發警告 */
    const paidBnb = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && Number(b.change) < 0).reduce((x, b) => x - Number(b.change), 0) / 1e18;
    const paidU = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress || '').toLowerCase() === USDT && Number(b.change) < 0).reduce((x, b) => x - Number(b.change), 0) / 1e18;
    if (!(costUsd > 0) && (paidBnb > 0 || paidU > 0)) { const px = S.lastBnbUsd || 600; costUsd = paidBnb * px + paidU; tg(`⚠️ [${W.name}] ${noLink(sym || '')} 有付錢（${paidBnb > 0 ? paidBnb.toFixed(4) + ' BNB ' : ''}${paidU > 0 ? paidU.toFixed(2) + ' USDT' : ''}）但當下讀不到價格，成本已改用估算 ${costUsd.toFixed(2)}U 記錄，照付費幣規則賣`).catch(() => {}); }
  }
  try { for (const b of sim?.balanceChanges || []) { if (String(b.owner).toLowerCase() !== W.addr || !(Number(b.change) > 0)) continue; const a = String(b.contractAddress || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || a.startsWith('0xeeee') || a === USDT || a === WBNB) continue; if (String(b.tokenType || '') !== 'Erc20') continue; /* 只追蹤 ERC20 代幣，NFT 不追 */
    S.dyn = S.dyn || []; { const ex = S.dyn.find((t) => t.addr === a && t.only === W.addr); if (ex && (costUsd || 0) > 0) { ex.cost = +((ex.cost || 0) + costUsd).toFixed(2); log(`[${W.name}] ${ex.sym} 加碼，成本累加到約 ${ex.cost}U`); } /* v2.7.9：同一个币再买，成本要累加，不然倍数算错、会提早出本 */ } if (!S.dyn.some((t) => t.addr === a && t.only === W.addr)) { S.dyn.push({ sym: sym || a.slice(0, 8), addr: a, cost: +(costUsd || 0).toFixed(2), only: W.addr, boughtAt: Date.now() }); log(`[${W.name}] ${sym || a} 加入持倉監控（成本約 ${(costUsd || 0).toFixed(2)}U）`); } } } catch {}
}
const SELLING = new Set();
async function sell(t, st, amt, why, W = WALLETS[0]) {
  const sk = W.name + '|' + t.addr; if (SELLING.has(sk)) return false; SELLING.add(sk); INFLIGHT++; try { return await sellInner(t, st, amt, why, W); } finally { INFLIGHT--; SELLING.delete(sk); } /* 除錯 11/1：01:17 CENSUS 賣單送出後剛好程序更新重啟，等成交、發 💰、記帳的步驟被砍掉；賣出也算「交易進行中」，重啟要等它做完 */ /* 審查修正：同一個幣同時只賣一次（TG 指令和自動賣不會撞） */
}
async function sellInner(t, st, amt, why, W) {
  { const live = (S.dyn || []).find((x) => x.addr === t.addr && x.only === W.addr); if (live?.hold && !/指示/.test(why)) { log(`${t.sym} 設定為等使用者通知，不自動賣（${why}）`); return false; } } /* 審查修正：以最新設定為準，避免背景用舊清單賣掉（币安无忧 19:56） */
  const dec = await tokDec(t.addr); { const ph = globalThis.PLUG_HELD?.(t.addr) || 0; if (ph > 0 && W === WALLETS[0]) { const sub = BigInt(Math.floor(ph * 10 ** Math.min(dec, 15))) * 10n ** BigInt(Math.max(0, dec - 15)); amt = BigInt(amt) > sub ? BigInt(amt) - sub : 0n; } } /* 11/2：扣掉外挂自己的部位，雷达不会卖到外挂的币 */ const qty = (Math.floor((Number(amt) / 10 ** dec) * 1e4) / 1e4).toFixed(4); // 依代幣小數位數算數量（審查修正：6／9 位小數的幣以前會算成 0）
  if (!(Number(qty) > 0)) return false;
  const bnb0 = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', t.addr, '--toToken', NATIVE_BNB]);
  log(`卖 ${t.sym} ${qty}: ${r.t.slice(0, 600)}`);
  if (!r.j?.success) { st.sellFail = (st.sellFail || 0) + 1; st.sellFailAt = Date.now(); const msg = (r.j?.error?.message || r.t).slice(0, 200); globalThis.LAST_SELL_ERR = msg; log(`[${W.name}] ${t.sym} 賣出失敗第 ${st.sellFail} 次：${msg.replace(/\n/g, ' ')}`);
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

async function openWatch(head) { /* v2.8.0：还没开盘的持仓独立每 15 秒查一次，不跟旧持仓排队（以前开盘要等好几分钟才发现） */
  for (const W of WALLETS) for (const t0 of (S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue; if (!(Date.now() - (t0.boughtAt || 0) < 72 * 3600e3)) continue;
    const t = { ...t0, cost: (t0.only || t0.both || W.addr === ME) ? t0.cost : 0 };
    const dupSym = TOKENS.concat(S.dyn || []).filter((x) => (!x.only || x.only === W.addr) && x.sym === t.sym && x.addr !== t.addr).length > 0;
    const key = (W.addr === ME ? t.sym : W.name + ':' + t.sym) + (dupSym ? '#' + t.addr.slice(2, 8) : '');
    const st = S.tokens[key]; if (!st || st.pair || st.done || !st.checked) continue;
    const p = await findPair(t).catch(() => null); if (!p || st.pair) continue;
    st.pair = p.pair; if (p.ds) { st.pairDs = 1; st.pairInfo = `${p.dex}，跟 ${p.quote} 配對`; } st.openAt = st.openAt || Date.now(); st.fromBlock = head - 400;
    const balR = await call(t.addr, '0x70a08231' + wa(W.addr)).catch(() => null); const bal = balR ? big(balR) : 0n;
    if (bal > 0n) await honeypotCheck(W, t, st, bal).catch(() => {});
    await tg(`🚀 ${t.sym} 開池了（${st.pairInfo || 'PancakeSwap'}）\n合約 ${t.addr}\n池子 ${p.pair}\n開始追蹤價格，達到高點會自動賣`);
  }
}
async function holdings(head, onlyFast = false) {
  await Promise.all(WALLETS.map((W) => holdW(W, head, onlyFast).catch((e) => log('holdings ' + W.name + ' ' + e.message))));
}
async function holdW(W, head, onlyFast) { // 所有錢包同時跑（速戰：賣單不排隊）
  for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    const t = { ...t0, cost: (t0.only || t0.both || W.addr === ME) ? t0.cost : 0 };
    const dupSym = TOKENS.concat(S.dyn || []).filter((x) => (!x.only || x.only === W.addr) && x.sym === t.sym && x.addr !== t.addr).length > 0; /* 審查修正：不同幣同名（像兩個 555、兩個 CIOW）以前共用同一份紀錄，餘額來回跳 */
    const key = (W.addr === ME ? t.sym : W.name + ':' + t.sym) + (dupSym ? '#' + t.addr.slice(2, 8) : '');
    const st = (S.tokens[key] = S.tokens[key] || { hist: [], peak: 0, peakAt: 0, sold: 0 });
    if (onlyFast && !(st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done)) continue;
    if (!onlyFast && st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done && st.pair) continue; /* v2.8.2：刚开盘 30 分钟内的只交给密集检查，完整检查跳过，避免重复部分卖出 */
    if (!onlyFast && st.done && st.doneAt && Date.now() - st.doneAt < 30 * 60e3) continue; /* v2.8.0：卖完（余额 0）的旧持仓 30 分钟才重查一次，整轮更快 */
    const balR = await call(t.addr, '0x70a08231' + wa(W.addr)); if (balR == null) continue; /* 查詢失敗不當成 0（以前會一直誤報「收到幣」） */ const bal = big(balR);
    const prevBal = BigInt(st.lastBal || '0'); st.lastBal = bal.toString();
    if (bal > prevBal && st.balInit) { const v0 = await valueUsd(t, bal - prevBal); await tg(`🎁 [${W.name}] 收到 ${t.sym} ${(Number(bal - prevBal) / 1e18).toLocaleString()} 顆${v0 != null ? '，約值 ' + v0.toFixed(2) + 'U' : '（還沒有池子可以報價）'}\n會自動追蹤，到高點就賣`); }
    st.balInit = true;
    if (bal === 0n) { st.done = true; st.doneAt = Date.now(); continue; }
    if (st.pair && !st.verified && !st.pairDs) { const rs = await call(st.pair, '0x0902f1ac'); if (rs == null) { /* 查詢失敗：先不判斷 */ } else if (BigInt('0x' + rs.slice(2, 66)) === 0n) { delete st.pair; st.checked = true; } if (rs != null) st.verified = true; } // 舊版誤判的空池子清掉
    if (!st.pair) {
      const p = await findPair(t);
      const first = !st.checked; st.checked = true;
      if (p) { st.pair = p.pair; if (p.ds) { st.pairDs = 1; st.pairInfo = `${p.dex}，跟 ${p.quote} 配對`; } st.openAt = st.openAt || Date.now(); st.fromBlock = head - 400; if (!first) await honeypotCheck(W, t, st, bal); if (!first) await tg(`🚀 ${t.sym} 開池了（${st.pairInfo || 'PancakeSwap'}）\n合約 ${t.addr}\n池子 ${p.pair}\n開始追蹤價格，達到高點會自動賣`); }
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
    if (st.sellFail && now - (st.sellFailAt || 0) < Math.min(2, 2 ** (st.sellFail - 1)) * 60e3) { st.last = { v, at: ts() }; continue; } // 賣不掉：1、2、4…最多 15 分鐘後再試，不狂重試
    st.notified = st.notified || [];
    if (t.cost > 0 && !t.hold && !t.custom) for (const x of RULE.notifyX) if (vFull >= t.cost * x && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.sym} 到 ${x} 倍了！（成本 ${t.cost}U，現在持倉約 ${v.toFixed(2)}U）\n照規則：${ruleTxt()}`); }
    if (t.sellNow) { if (!st.sellNowDone) { if (await sell(t, st, bal, '你指示全部賣出', W)) { st.sellNowDone = true; st.stage = 9; } } continue; }
    if (!(t.cost > 0) || t.hold) { // 免費的、或使用者說先別賣的
      if (!st.basePx) st.basePx = px; // 免費幣以開池後第一個價格當基準
      for (const x of RULE.notifyX) { const hit = t.hold && t.cost > 0 ? vFull >= t.cost * x : px >= st.basePx * x; /* 審查 11/1：成本 0 的 hold 幣會一次誤報 5／10／20 倍 */ if (hit && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.hold ? '' : '免費幣 '}${t.sym} 漲到${t.hold ? '成本' : '開池價'}的 ${x} 倍！市值約 ${v.toFixed(2)}U\n${t.hold ? '你說先別賣，要賣在 TG 打「賣 ' + t.sym + '」' : '從最高價回落 50% 會自動全賣；想先賣在 TG 打「賣 ' + t.sym + '」'}`); } }
      if (st.openAt && now - st.openAt >= 180e3 && px > (st.fpp || 0)) st.fpp = px; // 開盤 3 分鐘後才開始算最高價
      const dropNow = !t.hold && st.fpp > 0 && px < st.fpp * (1 - RULE.drop) && v >= 0.3; st.dropHit = dropNow ? (st.dropHit || 0) + 1 : 0; /* 審查 11/1：連續 2 次才算，避免價格來源跳動假崩盤 */
      if (dropNow && st.dropHit >= 2) { // 免費幣從最高價回落 50% 全賣
        if (await sell(t, st, bal, `免費幣從最高價回落 50%，全部賣出（約 ${v.toFixed(2)}U）`, W)) { st.stage = 9; continue; }
      }
      if (t.hold && px < st.ppeak * (1 - RULE.drop) && st.dropWarnedPeak !== st.ppeak) { st.dropWarnedPeak = st.ppeak; await tg(`⚠️ [${W.name}] ${t.sym} 從最高價回調 50%，現在約 ${v.toFixed(2)}U\n你說先別賣，不會自動賣，要賣在 TG 打「賣 ${t.sym}」`); }
      st.last = { v, at: ts() }; continue;
    }
    if (v < 0.3) { st.last = { v, at: ts() }; continue; } // 剩下不到 0.3U 的灰塵不賣（賣了不夠手續費）
    st.done2 = st.done2 || [];
    const backDone = st.done2.includes('back');
    if (backDone && st.moonPend && RULE.moonPct) { st.moon = ((bal * BigInt(RULE.moonPct)) / 100n).toString(); delete st.moonPend; log(`[${W.name}] ${t.sym} 回本後留 ${RULE.moonPct}% 長抱（不自動賣，50／100 倍通知）`); }
    const moon = backDone && st.moon ? BigInt(st.moon) : 0n; const freeAmt = bal > moon ? bal - moon : 0n;
    if (moon > 0n && freeAmt * 50n <= moon) { /* 只剩長抱那份：不自動賣，到 50／100 倍通知 */
      for (const x of RULE.moonNotifyX || []) if (vFull >= t.cost * x && !st.done2.includes('m' + x)) { st.done2.push('m' + x); await tg(`🔥 [${W.name}] ${t.sym} 長抱那份到 ${x} 倍了！（成本 ${t.cost}U，現在約 ${v.toFixed(2)}U）\n照設定不自動賣，要賣在 TG 打「賣 ${t.sym}」或「賣 ${t.sym} 一半」`); }
      st.last = { v, at: ts() }; continue;
    }
    const crash = backDone ? (RULE.crashAfterBack || RULE.crash) : RULE.crash; /* 使用者 11/1 13:54：回本前回落 40% 全賣；回本後放寬到 60% */
    const crashNow = st.ppeak > 0 && px < st.ppeak * (1 - crash); st.crashHit = crashNow ? (st.crashHit || 0) + 1 : 0; /* 審查 11/1：價格來源偶爾跳到很小的池子會假崩盤 → 要連續 2 次都低於門檻才全賣 */
    if (crashNow && st.crashHit >= 2) {
      if (await sell(t, st, moon > 0n ? freeAmt : bal, `從最高價回落 ${Math.round(crash * 100)}%，${moon > 0n ? `賣出長抱以外的部分（留 ${RULE.moonPct}% 長抱）` : '全部賣出'}（約 ${v.toFixed(2)}U）`, W)) { if (!(moon > 0n)) st.stage = 9; }
    } else if (!backDone && vFull >= t.cost * RULE.backX) {
      const pct = Math.min(100, Math.ceil((t.cost / v) * 100 * 1.03));
      if (await sell(t, st, (bal * BigInt(pct)) / 100n, `到 ${RULE.backX} 倍，賣 ${pct}% 拿回本錢 ${t.cost}U（持倉約 ${v.toFixed(2)}U）`, W)) { st.done2.push('back'); if (pct < 100) st.moonPend = 1; }
    } else for (const [x, pc] of RULE.steps) {
      if (!st.done2.includes('s' + x) && !(x === 10 && st.done2.includes('h10')) && vFull >= t.cost * x) { if (await sell(t, st, ((moon > 0n ? freeAmt : bal) * BigInt(pc)) / 100n, `到 ${x} 倍，賣出 ${pc}%${moon > 0n ? '（長抱那份不動）' : ''}（持倉約 ${v.toFixed(2)}U）`, W)) st.done2.push('s' + x); break; }
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
const noLink = (x) => String(x || '').replace(/https?:\/\/\S+|www\.\S+|\b[\w-]+\.(xyz|com|io|org|net|app|online|fun|site|top|cc|me|link|vip|pro|club|live|info)\b\S*/gi, '[連結已移除]').slice(0, 160); /* 逆向檢查 11/1：銘文內容、代幣名稱是項目方自己寫的，可能夾帶釣魚連結，發到使用者 TG 前先拿掉 */
const INSC = new Map(); /* 使用者 11/1 17:08：一切以熱門為主——銘文玩法（像 agentrybaw inscribe：交易資料寫 data:,{...}）沒有鑄造紀錄，以前完全看不到；改成也統計「很多錢包在寫同一個銘文」 */
const AGH = new Map(); /* 11/1 22:21 AI 熱門代幣：每個合約 20 分鐘內有哪些錢包在互動（授權、轉帳不算；透過 PancakeSwap 買進的算在買到的代幣上） */
const AG_SKIP = new Set(['0x55d398326f99059ff775485246999027b3197955', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x10ed43c718714eb63d5aa57b78b54704e256024e', '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', '0x1a0a18ac4becddbd6389559687d1a73d8927e416', '0xca11bde05977b3631167028862be2a173976ca11', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', '0xe9e7cea3dedca5984780bafc599bd69add087d56', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', '0x2170ed0880ac9a755fd29b2688956bd959f933f8', '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82']); /* USDT、WBNB、路由、Multicall、BUSD、FDUSD、USDC、BTCB、ETH、CAKE */
function agNote(t) { try {
  if (!t.to || !t.from) return; const inp = (t.input || '0x').toLowerCase(); const sel = inp.slice(0, 10); const from = t.from.toLowerCase(); let tok = t.to.toLowerCase();
  if (/^0x(a9059cbb|095ea7b3|23b872dd|d0e30db0|2e1a7d4d)/.test(sel)) return;
  const pw = { '0x7ff36ab5': 1, '0xb6f9de95': 1, '0xfb3bdb41': 1, '0x38ed1739': 2, '0x5c11d795': 2, '0x8803dbee': 2 }[sel];
  if (pw) { const off = parseInt(inp.slice(10 + pw * 64, 10 + pw * 64 + 64), 16) * 2; const n = parseInt(inp.slice(10 + off, 10 + off + 64), 16); if (!(n >= 2 && n <= 5)) return; tok = '0x' + inp.slice(10 + off + 64 * n + 24, 10 + off + 64 * n + 64); }
  if (AG_SKIP.has(tok) || INFRA.has(tok)) return;
  let m = AGH.get(tok); if (!m) { if (AGH.size > 30000) return; m = new Map(); AGH.set(tok, m); } m.set(from, Date.now());
} catch {} }
function countHot(txs) {
  for (const t of txs) agNote(t);
  const now = Date.now(); if (!SMART.size && S.smart?.length) SMART = new Set(S.smart);
  for (const t of txs) {
    { const inp = (t.input || '').toLowerCase(); if (inp.startsWith('0x646174613a') && inp.length < 4000) { let txt = ''; try { txt = Buffer.from(inp.slice(2), 'hex').toString('utf8'); } catch {} const tick = (txt.match(/"tick"\s*:\s*"([^"]{1,40})"/i) || [])[1]; const p = (txt.match(/"p"\s*:\s*"([^"]{1,30})"/i) || [])[1] || ''; const k = tick ? `${p}:${tick}`.toLowerCase() : 'to:' + String(t.to || '').toLowerCase(); let h = INSC.get(k); if (!h || now - h.at > 180e3) { h = { from: new Set(), at: now, to: String(t.to || '').toLowerCase(), sample: txt.slice(0, 160) }; INSC.set(k, h); } h.from.add(String(t.from).toLowerCase()); if (INSC.size > 5000) for (const [kk, hh] of INSC) if (now - hh.at > 180e3) INSC.delete(kk); continue; } }
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
async function fullCode(c, code) { /* 審查修正（FAGENT 漏掉的原因）：代理合約一律追到背後的真正程式——EIP-1967、Beacon 槽位、程式裡寫死的 Beacon／實作地址、最小代理（EIP-1167） */
  code = String(code || '').toLowerCase(); if (code.length < 4 || code.length >= 4000 || code.includes(REGISTRY)) return code;
  const add = async (a) => { const x = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase(); code += x; return x; };
  try { const impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']); if (impl && BigInt(impl) !== 0n) await add('0x' + impl.slice(-40)); } catch {}
  try { const bc = await rpc('eth_getStorageAt', [c, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', 'latest']); if (bc && BigInt(bc) !== 0n) { const r = await call('0x' + bc.slice(-40), '0x5c60da1b'); if (r && BigInt(r) !== 0n) await add('0x' + r.slice(-40)); } } catch {}
  const emb0 = []; { const h = code.replace(/^0x/, '').slice(0, 1200); const m1167 = h.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af4/); if (m1167) emb0.push('0x' + m1167[1]); for (let i = 0; i + 42 <= h.length; i += 2) { const op = h.slice(i, i + 2); if (op === '73') { emb0.push('0x' + h.slice(i + 2, i + 42)); i += 40; } else if (op === '7f') { const wv = h.slice(i + 2, i + 66); if (/^0{24}/.test(wv)) emb0.push('0x' + wv.slice(24)); i += 64; } else { const n = parseInt(op, 16); if (n >= 0x60 && n <= 0x7f) i += (n - 0x5f) * 2; } } } /* 除錯 11/1：以前用字串比對會從錯的位置切（最小代理 363d3d37… 裡的「37 3d」被當成 73），抓不到 bibiai 的實作合約 → 誤判沒有退款機制；改成照位元組逐一解析 */
  const emb = [...new Set(emb0)].filter((a) => !/^0x0{40}$/.test(a) && a.length === 42).slice(0, 3);
  for (const a of emb) { if (code.includes(REGISTRY)) break; const r = await call(a, '0x5c60da1b'); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) !== 0n) await add('0x' + r.slice(-40)); else await add(a); }
  return code;
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
  code = await fullCode(target, code);
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
  await tg(`🔥 發現正在被鑄造的 Agent ID 項目${name ? '：' + name : ''}（3 分鐘內鑄給 ${m.to.size} 個錢包${share ? `，${Math.round(share * 100)}% 有 .ai 身份` : ''}）\n${target}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度和 Agent ID 錢包數都達到門檻且每個錢包 ≤20U 會自動打'}`);
}

async function inscScan() { /* 熱門銘文：3 分鐘內 12 個以上錢包、六成以上持有 Agent ID → 通知使用者（銘文不自動打，格式各家不同、風險高） */
  S.inscNoted = S.inscNoted || {};
  for (const [k, h] of INSC) {
    if (h.from.size < 12 || S.inscNoted[k]) continue;
    const sample = [...h.from].slice(0, 16); let n = 0; for (const a of sample) { const r = await call('0x' + REGISTRY, '0x70a08231' + wa(a)); if (r && BigInt(r.slice(0, 66)) > 0n) n++; }
    S.inscNoted[k] = ts(); const ks = Object.keys(S.inscNoted); if (ks.length > 2000) delete S.inscNoted[ks[0]];
    if (n < 8 || n / sample.length < 0.6) { log(`銘文 ${k} 3 分鐘 ${h.from.size} 個錢包在寫，但持有 Agent ID 的只有 ${n}/${sample.length}，不通知`); continue; }
    log(`🔥 熱門銘文：${k}（3 分鐘 ${h.from.size} 個錢包，${Math.round((n / sample.length) * 100)}% 持有 Agent ID）`);
    await tg(`🔥 熱門 Agent ID 銘文：${k.replace(/^to:/, '送到 ')}\n3 分鐘內 ${h.from.size} 個錢包在寫，其中 ${Math.round((n / sample.length) * 100)}% 持有 Agent ID\n內容範例：${noLink(h.sample)}\n銘文工具不會自動打，要的話請自己手動`);
  }
}
async function hotScan() {
  inscScan().catch((e) => log('inscScan ' + e.message));
  for (const [c, h] of HOT) {
    if (INFRA.has(c) || CLAIM.has(c)) continue;
    if ((h.from.size < 12 && (h.smart?.size || 0) < 2) || S.seenMints[c] || hotChecked.has(c)) continue;
    CLAIM.add(c); hotChecked.set(c, Date.now()); if (hotChecked.size > 5000) hotChecked.delete(hotChecked.keys().next().value);
    let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase();
    code = await fullCode(c, code);
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
    await tg(`🔥 發現正在被搶打的 Agent ID 項目${name ? '：' + name : ''}${viaAgents ? `（合約沒寫 Agent ID 檢查，但打它的錢包 ${Math.round(viaAgents * 100)}% 持有 .ai 身份，可能是後端簽名驗證）` : ''}（3 分鐘內 ${h.from.size} 個錢包${h.smart?.size ? '，其中聰明錢包 ' + h.smart.size + ' 個' : ''}）\n${c}\n${minted || '⚪ 不是免費的 → 已加入追蹤：進度和 Agent ID 錢包數都達到門檻且每個錢包 ≤20U 會自動打'}\nhttps://bscscan.com/address/${c}`);
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
        code = await fullCode(c, code); /* 代理合約（各種寫法）都追到背後真正的程式 */
        if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
        S.seenMints[c] = ts(); noteDeploy(code); S.deployer = S.deployer || {}; S.deployer[c] = (tx.from || '').toLowerCase(); S.depFrom = S.depFrom || {}; S.depFrom[c] = S.deployer[c]; noteDev(S.deployer[c], c);
        bgJob(async () => {
        const ok = [];
        let feeV = 0n; { const ff = await findFree(ME, c, code); if (ff) { ok.push(ff.n); feeV = ff.v || 0n; } }
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
        await tg(`🆕 發現新的 Agent ID 專屬合約${name ? '：' + name : ''}\n${c}\n${ok.length ? (feeV > 0n ? `⚠️ 模擬可以鑄，但要付 ${Number(feeV) / 1e18} BNB 手續費 → 照規則當「付費項目」處理（不是免費）` : '✅ 模擬確認：免費可鑄') + `（函數 ${ok.join('、')}）\n我們的處理：\n` + (minted || '（還沒動作）\n') : `⚪ 現在不是免費的（${pay}，或還沒開）→ 已加入追蹤：\n· 免費 → 進度和 Agent ID 錢包數都達到門檻 → 自動打\n· 要付任何手續費 → 當付費：另外還要合約有保本機制（或讀不到進度但很多人在打）且每個錢包 ≤20U → 自動打`}\nhttps://bscscan.com/address/${c}`);
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
const capOf = (c) => (FORCE.has(c) && Number(S.forceUsd?.[c]) > 0 ? Number(S.forceUsd[c]) : PAID.maxUsd); /* 雷达 11/2：强制打可以当场填这次最多付多少 U */
async function findFree(from, c, code) {
  for (const [n, d] of CANDS) { if (n.includes('@') && !n.endsWith('@' + c.slice(2, 10))) continue; if (n.includes('#') && !n.includes('#' + (WALLETS.find((x) => x.addr === from)?.name || '?') + '@')) continue; if (d.length < 10 || badSel(d) || !code.includes(d.slice(2, 10))) continue; /* 空呼叫（直接轉 0 BNB）不算鑄造 */ const dd = /重播|熱門函式/.test(n) ? freshDeadline(d) : d; for (const v of NEAR_FREE) { try { await rpc('eth_call', [{ from, to: c, data: dd, value: '0x' + v.toString(16) }, 'latest']); return { n, v }; } catch {} } }
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
const MQK = new Set(); /* 審查修正：同一個合約＋錢包同時只排一個鑄造工作，避免重複打 */
function queueMint(c, fname, W, v) {
  const qk = c + '|' + W.name; if (MQK.has(qk)) return '⏳ 已在排隊中'; if (S.paid?.[c]?.done?.[W.name] && S.paid[c].done[W.name] !== 'pool-open') return '✅ 這個錢包已經打過';
  MQK.add(qk);
  const prev = MQ.get(W.name) || Promise.resolve();
  const job = prev.then(() => autoMintMax(c, fname, W, v)).finally(() => MQK.delete(qk)).then(async (m) => { if (m.startsWith('🤖') || m.includes('結果不明')) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; S.paid[c].done[W.name] = m.startsWith('🤖') ? 'free' : 'unknown'; } else if (!m.startsWith('⏸') && !m.startsWith('✅')) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; } /* 審查 11/1：第一次就失敗（預演失敗、BNB 不夠…）的以前不會再追蹤 */ log(`[${W.name}] ${c} ${m.replace(/\n/g, ' | ')}`); if (m.startsWith('🤖')) { S.freeTrack = S.freeTrack || {}; S.freeTrack[c] = S.freeTrack[c] || { at: Date.now() }; } if (m.startsWith('🤖')) noteFree(c, W); }).catch((e) => log(`[${W.name}] 鑄造失敗 ${c} ${e.message}`));
  MQ.set(W.name, job);
  return '⏳ 已排入檢查（照規則決定打不打，結果會再通知）';
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
const fpCache = new Map();
async function freeProgress(c) { /* 免費項目的進度：已鑄造／總量；讀不到回傳 null（30 秒快取） */
  const k = fpCache.get(c); if (k && Date.now() - k.t < 30e3) return k.p;
  let p = null; const decR = await call(c, '0x313ce567'); const isErc20 = !!(decR && decR.length >= 66 && BigInt(decR.slice(0, 66)) > 0n && BigInt(decR.slice(0, 66)) <= 36n); /* ERC20 常常一開始就全部發行，用「已發行÷總量」會誤判成 100% */
  const tmR = isErc20 ? null : await call(c, '0xa2309ff8'); /* 除錯 11/1：先看「實際鑄出數」totalMinted；totalSupply 會含項目方預留，SmokeeAgent 才鑄 72 個卻讀成 100% */
  const tsR = isErc20 ? null : (tmR && tmR.length >= 66 ? tmR : await call(c, '0x18160ddd'));
  if (tsR && tsR.length >= 66) { const sup = Number(BigInt(tsR.slice(0, 66))); for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2', '0x0f2cdd6c', '0xa0e23ebd']) { const r = await call(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x >= sup && x < 1e15) { p = sup / x; break; } } } }
  if (p == null) { const code = (await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || ''; const pr = await progressOf(c, code.toLowerCase(), '').catch(() => ({})); if (pr.progress > 0) p = pr.progress; }
  fpCache.set(c, { t: Date.now(), p }); return p;
}
async function progressSweep() { /* 使用者 10/31 23:21 查 Pulsepanther 沒打到：追蹤名單 500 多個，一般檢查每輪只看 16 個、一個要 10~30 秒，低進度的項目要 2~3 小時才回頭看一次，10% 直接漲到 100% 都沒發現。改成每分鐘用輕量方式只讀進度（最多 80 個、6 個同時），進度過 45% 就會進快速名單，每 15 秒檢查 */
  const now = Date.now(); const list = Object.entries(S.paid || {}).filter(([c, P]) => !P.unmintable && (P.progress || 0) < 0.999 && now - (P.at || 0) < 172800e3 /* v2.7.7：两天内的项目都监测 */ && !WALLETS.every((W) => P.done?.[W.name])).sort((x, y) => (x[1].sweepAt || 0) - (y[1].sweepAt || 0)).slice(0, 80);
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const [c, P] = list[i++]; try { if (P.progAt && Date.now() - P.progAt < 180e3) { P.sweepAt = Date.now(); continue; } /* 除錯：正式檢查 3 分鐘內剛讀過的不覆蓋（避免讀法不同把已賣完的又拉回快速名單、佔名額） */ let fp = null; if (P.soldSel) { /* 除錯 11/1：bibiai AGENT ID 用「已售／總量」才讀得到（已售 a2309ff8、總量 a0e23ebd），一般免費讀法讀不到 → 卡在 0% 兩小時沒回頭看，漲到 92% 都不知道 */ const sr = await call(c, P.soldSel); const sold = sr && sr.length >= 66 ? Number(BigInt(sr.slice(0, 66))) : null; if (sold > 0) { if (P.capSel === undefined) P.capSel = (await findCapSel(c, await fullCode(c, await codeOf(c)).catch(() => ''), sold).catch(() => '')) || ''; if (P.capSel) { const cr = await call(c, '0x' + P.capSel); const cap = cr && cr.length >= 66 ? Number(BigInt(cr.slice(0, 66))) : 0; if (cap >= sold && cap > 0) fp = sold / cap; } } }
      if (fp == null) fp = await freeProgress(c); P.sweepAt = Date.now(); if (fp != null && fp > 0) { if (fp >= 0.45 && (P.progress || 0) < 0.45 && !P.swLog) { P.swLog = 1; log(`進度掃描：${P.name || c} 進度 ${Math.round(fp * 100)}%，移到快速檢查`); } P.progress = fp >= 0.999 && !P.progAt ? 1 : Math.min(fp, 0.99); /* 審查 11/1：免費合約正式檢查不會讀進度，賣完的會永遠卡 99% 佔快速名單 → 直接記 100% */ /* 100% 交給快速檢查用正式讀法確認，避免讀錯就永遠不看 */ } } catch {} } }));
}
async function autoMint(c, fname, W = WALLETS[0], val = 0n) {
  /* 使用者 10/31 19:21：新規則——不管免費還是付費，進度超過 50% 就打，之前的規矩（重複 DEV、黑名單、熱度、手續費上限…）全部不看；只保留貔貅類安全檢查（每筆都模擬、不能授權、不能扣到預期外的資產、Flap 禁止）。讀不到進度的才用熱度判斷 */
  { const sd = await serialDev(c); if (sd) { S.paid = S.paid || {}; if (S.paid[c]) { S.paid[c].serialLog = 1; S.paid[c].lastReason = sd + '，照規則不打'; } return `⛔ ${sd}，照規則不打`; } } /* 除錯 11/1：被「大量部署者」擋掉的，以前錯過名單會誤寫成「還沒找到能打的方式」 */
  if (val > 0n) { /* 使用者 11/1 14:16：「付手續費的免費」一律當付費——今天被這種小項目掏了約 0.195 BNB；要付錢就必須有保本（退款）機制才打 */
    if (!(await walletLimit(c))) return `⏸ 要付 ${Number(val) / 1e18} BNB 手續費（當付費），但合約沒有每個錢包上限的規定，照規則不打`; /* 使用者 11/1 17:54 */
    if (await isNft(c).catch(() => false)) { const fpN = await freeProgress(c); const agN = S.paid?.[c]?.agents || 0; if (!(fpN >= Math.max(GO_PCT, 0.7)) || agN < Math.max(AG_MIN, 150)) return '⏸ NFT 要進度 70%、150 個錢包以上才打'; if (!(await walletLimit(c, true))) return '⏸ NFT 一定要有「每個錢包上限」，照規則不打'; const nw = await nftStrict(c); if (nw) return '⏸ ' + nw + '，照規則不打'; }
  }
  const fp = await freeProgress(c);
  const agentsN = S.paid?.[c]?.agents || 0; /* 審查 11/1：只算 Agent ID 錢包 */ /* 使用者 10/31 19:45：免費也一樣——進度過 60% 才打；讀不到進度要 100 個以上錢包在打 */
  if (fp != null && fp < GO_PCT) { /* 使用者 11/1 02:37：門檻 60% */ S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; return `⏸ 進度 ${Math.floor(fp * 100)}%，還沒到 ${Math.round(GO_PCT * 100)}%，先追蹤，到了就打`; }
  if (fp != null && agentsN < AG_MIN) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; return `⏸ 進度 ${Math.floor(fp * 100)}% 夠了，但只有 ${agentsN} 個 Agent ID 錢包在打（要 ${AG_MIN} 個以上，防項目方自己灌進度），先追蹤`; }
  if (fp != null && !(S.xHits || {})[c]) globalThis.xCheck?.(c, S.paid?.[c]?.name || '').catch(() => {}); /* 通過鏈上條件的免費項目：背景去 X 查一下（只記錄／提醒，不擋） */
  if (fp == null && agentsN >= AG_MIN) { let tk = c; const tr0 = await call(c, '0xfc0c546a'); if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tk = '0x' + tr0.slice(26, 66); if (await poolOpen(tk)) return '⏸ 讀不到進度、已經開池，不鑄造（鑄造通常比市價貴）'; }
  if (fp == null && agentsN < AG_MIN) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; return `⏸ 讀不到進度，目前 ${agentsN} 個錢包在打，要 ${AG_MIN} 個以上才打，先追蹤`; }
  if (val === 0n && await othersPay(c).catch(() => 0)) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; const P0 = S.paid[c]; P0.needLearn = 1; P0.freePhase = 1; if (P0.done) for (const W0 of WALLETS) if (P0.done[W0.name] === 'free-notify') delete P0.done[W0.name]; return '💱 第一份免費、大家都在付費打 → 改用付費規則（照抄別人的付費打法）'; } /* 使用者 11/1 18:50 */
  if (val === 0n) { await freeNotify(c, S.paid?.[c]?.name || '', fp, agentsN); return '🔔 免費項目達到條件，已通知（照規則不自動打）'; }
  if (val > 0n && (Number(val) / 1e18) * ((await bnbUsd().catch(() => 0)) || 700) > capOf(c)) return `⏸ 手續費超過 ${capOf(c)}U 上限，沒有鑄`;
  let d = Object.fromEntries(CANDS)[fname]; if (d && /重播|熱門函式/.test(fname)) d = freshDeadline(d); /* 照抄的免費鑄造也換新期限 */
  const today = new Date().toDateString(); if (S.mintDay !== today) { S.mintDay = today; S.mintCount = 0; }
  S.mintCnt = S.mintCnt && S.mintCnt.d === today ? S.mintCnt : { d: today }; if ((S.mintCnt[W.name] || 0) >= 1000) return '⏸ 這個錢包今天自動鑄已達 1000 筆上限，沒有鑄';
  const bnb = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  if (bnb < 5n * 10n ** 14n) return '⚠️ BNB 不夠付 gas（< 0.0005），沒有鑄';
  { const rb = await riskBlock(W, c, val, d, val === 0n); if (rb) return '⏸ 風控：' + rb + '，沒有鑄'; }
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', c, '--value', val.toString(), '--inputData', d]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) return '❌ 預演失敗，沒有鑄：' + (p.j?.error?.message || '').slice(0, 120);
  { const fg = flapGuard(c, d, sim); if (fg) return '⛔ ' + fg + '，沒有鑄'; }
  const losing = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) < 0 && !(String(b.contractAddress).toLowerCase().startsWith('0xeeee') && -Number(b.change) <= Number(val) && val > 0n)); /* 風控：扣的 BNB 不能比說好的多 */
  if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length || losing.length) return '⚠️ 預演顯示有授權或會扣你的資產，安全起見沒有鑄';
  { const dr = await drainCheck(c, val, d); if (dr) return '⛔ ' + dr + '，沒有鑄'; }
  if (!(sim?.balanceChanges || []).some((b) => String(b.owner).toLowerCase() === W.addr && (Number(b.change) > 0 || (/Erc721|Erc1155/i.test(b.tokenType || '') && !(Number(b.change) < 0))))) return '⚪ 預演顯示拿不到東西（可能鑄給別人或淨額為 0），沒有鑄'; 
  for (let i = 0; i < 30 && (globalThis.PLUG_INFLIGHT || 0) > 0 && W === WALLETS[0]; i++) await sleep(500); /* 外挂正在用同一个钱包送交易 → 最多等 15 秒 */ INFLIGHT++; let x; try { x = await W.baw(['contract-call', 'execute', '--requestId', rid]); } finally { INFLIGHT--; }
  if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) return '⚠️ 送出結果不明（逾時），先不重打';
  if (!x.j?.success) return '❌ 送出失敗：' + (x.j?.error?.message || x.t).slice(0, 120);
  S.mintCount++; S.mintCnt[W.name] = (S.mintCnt[W.name] || 0) + 1; riskAfter(W, c, x.j.data?.txHash || '', val, val === 0n);
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
  
  goPct: 0.8, earlyPct: 0.8, riseDelta: 0.02, maxUsd: Math.min(Number(CONFIG.paid?.maxUsd) || 20, 20), 
  dayUsd: 60,              // 每个钱包每天付费总额最多 60U
  maxBnbPerDay: CONFIG.paid?.maxBnbPerDay ?? 1e9,        // 使用者說不管怎樣就打 → 不設每日上限（只受錢包餘額限制）
  minSold: 30,              // 至少已經有 30 份被別人鑄過才跟（避開沒人理的／陷阱合約）
  maxAgeH: 168,              // 發現後 48 小時內還沒開就放棄
  keepBnb: CONFIG.paid?.keepBnb ?? 0.006,           // 錢包至少留這麼多 BNB 當 gas
};
const codeCache = new Map();
async function codeOf(a) { if (!codeCache.has(a)) codeCache.set(a, ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase()); return codeCache.get(a); }
async function bnbUsd() {
  const p = await call(FACTORY, '0xe6a43905' + wa(WBNB) + wa(USDT)); const pair = '0x' + (p || '').slice(26); const r = await call(pair, '0x0902f1ac'); const t0 = await call(pair, '0x0dfe1681');
  if (!r || !t0) return S.lastBnbUsd || 0; const a = BigInt(r.slice(0, 66)), b = BigInt('0x' + r.slice(66, 130)); const px = t0.slice(26) === WBNB.slice(2) ? Number(b) / Number(a) : Number(a) / Number(b); if (px > 50 && px < 100000) S.lastBnbUsd = px; return px || S.lastBnbUsd || 0; /* 除錯 11/1：SENSEI 補打時節點剛好沒回 → BNB 價格 0 → 錢包成本記成 0U，被當成免費幣、2 倍沒賣回本；改成用上一次的價格 */
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
  const nOrig = BigInt('0x' + ws[0]);
  for (const n of [n0, ...[5n, 3n, 2n, 1n].filter((x) => x < n0)]) {
    const d2 = data.slice(0, 10) + w(n) + ws.slice(1).join(''); const vv = (BigInt(v || 0) * n) / nOrig; /* 審查 11/1：份數降了，付的錢也要按比例降（以前照付原本的金額） */
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d2, value: '0x' + vv.toString(16) }, 'latest']); if (n !== n0) log(`份數降到 ${n} 份才打得了：${c}`); return d2; } catch {}
  }
  return data;
}
const REFUND_SELS = ['590e1ae3', 'b5545a3c', '278ecde1', '5b7baf64', '110f8874', '16bfe25c', '38e771ab', 'b2d5ae44', 'fa89401a', 'bffa55d5', '68ec0d99', '74c1b1c9', 'b30196e5', 'c033a490', '4c4a386f', 'd233e4eb']; // 退款相關函式：refund()、claimRefund()、refundOpen()、refundable(address)…
const scaleV = (d0, d1, v) => { /* 份數從 d0 的第一個參數變成 d1 的，金額按比例調整 */ try { const a = BigInt('0x' + d0.slice(10, 74)), b = BigInt('0x' + d1.slice(10, 74)); if (a >= 1n && a <= 100n && b >= 1n && b < a) return (BigInt(v) * b) / a; } catch {} return BigInt(v); };
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
const FLAP_BAN = false; /* 使用者 10/31 19:26：現在可以跟 Flap 互動了（要再禁止就改成 true） */
function flapGuard(to, data, sim) {
  if (!FLAP_BAN) return '';
  if (FLAP_BLOCK.has(String(to).toLowerCase())) return '禁止跟 Flap 合約互動';
  const d = String(data || '').toLowerCase(); if (/^0x(095ea7b3|39509351)/.test(d) && FLAP_BLOCK.has('0x' + d.slice(34, 74))) return '禁止授權給 Flap';
  if ((sim?.allowanceChanges || []).some((a) => FLAP_BLOCK.has(String(a.spender).toLowerCase()))) return '會授權給 Flap，禁止';
  return '';
}
let INFLIGHT = 0; // 正在送出的交易數（重啟前要等它歸零，避免重打）
/* 11/2 她：发射平台曲线上的币也要能直接卖。Aizo：直接呼叫代币合约 burn(数量, 最少拿回, 期限) 换回 BNB（看过链上真实成交确认的作法）。
   先用 eth_call 问「卖这些能拿回多少 BNB」，最少拿回设 97%，再走同一套预演防盗检查才送出 */
const CURVES = { '0xb995508476dec1ff929d91a6f0400892ae2a71c9': { name: 'Aizo', sel: '0xb8192205' } };
async function curveQuote(c, W, amt) { const dl = Math.floor(Date.now() / 1000) + 600; const r = await rpc('eth_call', [{ from: W.addr, to: c, data: CURVES[c].sel + w(amt) + w(0) + w(dl) }, 'latest']); return big(r); }
async function curveSell(c, W, amt) { if (!(amt > 0n)) return false; const q = await curveQuote(c, W, amt); if (!(q > 0n)) throw new Error('曲线报价是 0'); const minOut = (q * 97n) / 100n; const dl = Math.floor(Date.now() / 1000) + 600;
  const data = CURVES[c].sel + w(amt) + w(minOut) + w(dl);
  await previewExec(W, c, data, 0n, (sim) => { if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '会授权或交出钱包权限'; const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr); if (mine.some((b) => !String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && String(b.contractAddress).toLowerCase() !== c && Number(b.change) < 0)) return '会扣你别的币'; if (!mine.some((b) => String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && Number(b.change) > 0)) return '预演看不到拿回 BNB'; return ''; }, null, { manual: true });
  log(`[${W.name}] ${CURVES[c].name} 曲线卖出：约拿回 ${(Number(q) / 1e18).toFixed(5)} BNB`); return true; }
async function previewExec(W, to, data, valueWei, check, recheck = null, opts = {}) {
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', to, '--value', valueWei.toString(), '--inputData', data]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) throw new Error('預演失敗 ' + (p.j?.error?.message || p.t).slice(0, 120));
  const fg = flapGuard(to, data, sim); if (fg) throw new Error('預演不安全：' + fg);
  const why = check(sim); if (why) throw new Error('預演不安全：' + why);
  if (!opts.manual && !opts.noDrain) { const dr = await drainCheck(to, valueWei, data); if (dr) throw new Error('預演不安全：' + dr); }
  { const outBnb = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0); if (outBnb > Number(valueWei) * 1.0000001 + 1) throw new Error('預演不安全：會扣的 BNB 比說好的多（風控）'); }
  if (recheck) { const r2 = await recheck(); if (r2) throw new Error('送出前再確認不通過：' + r2); } // 送出前再確認價格（審查建議 5）
  for (let i = 0; i < 30 && (globalThis.PLUG_INFLIGHT || 0) > 0 && W === WALLETS[0]; i++) await sleep(500); /* 外挂正在用同一个钱包送交易 → 最多等 15 秒 */ INFLIGHT++; let x; try { x = await W.baw(['contract-call', 'execute', '--requestId', rid]); } finally { INFLIGHT--; }
  if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) throw new Error('結果不明：送出逾時，可能已上鏈，先不重打');
  if (!x.j?.success) throw new Error('送出失敗 ' + (x.j?.error?.message || x.t).slice(0, 120));
  riskAfter(W, to, x.j.data?.txHash || '', 0n, false, false);
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
  const init = BigInt(pg.init);
  /* 除錯 11/1（FIST）：一開始就全部發行、合約裡還放了一大筆要加池子的幣 → 用「剩餘÷初始」會嚴重低估（讀成 34%，實際已 90%+）。有總份數（例如 14444 份）時，改用「已發出 ÷ 每份數量 ÷ 總份數」 */
  if (pg.cap == null) { pg.cap = 0; for (const s of CAP_SELS) { if (!code.includes(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x >= 100 && x <= 1e7) { pg.cap = x; break; } } } }
  if (pg.cap && !pg.unit) { try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const L = await logsRpc([{ address: pg.tok, fromBlock: '0x' + (head - 3000).toString(16), toBlock: '0x' + head.toString(16), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(24) + c.slice(2)] }]).catch(() => []); const cnt = {}; for (const l of L || []) { const v = l.data; cnt[v] = (cnt[v] || 0) + 1; } const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]; if (top && top[1] >= 3) pg.unit = BigInt(top[0]).toString(); } catch {} }
  if (pg.cap && pg.unit && BigInt(pg.unit) > 0n) { const soldN = Number((init - now) / BigInt(pg.unit)); return { progress: Math.min(1, soldN / pg.cap), sold: soldN, cap: pg.cap, how: '已發出份數／總份數' }; }
  return { progress: Number(init - now) / Number(init), sold, cap, how: '鑄造池剩餘' };
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
const DEV_MAX = 10;
const FIXED_THR = existsSync(join(DIR, 'data', 'fixed_thr.txt')); /* 使用者自己電腦放這個檔：固定 80%／150 */
if (!FIXED_THR && !(S.thr && S.thr.v === 3)) { S.thr = { v: 3, go: +(0.6 + Math.random() * 0.1).toFixed(3), ag: 100 + Math.floor(Math.random() * 31) }; save(); } /* 使用者 11/1 17:54：進度 60% 就可以打 → 開源版隨機範圍改成 60～70%、錢包 100～130 */ /* 使用者 11/1 17:18：錢包數改成只算送出交易的錢包後，150～200 幾乎達不到 → 隨機範圍改成進度 70～80%、錢包 100～130 個（舊的門檻會重新產生一次） */ /* 逆向防護 11/1：開源後壞人照門檻量身做項目（中午那批剛好卡 60%、0.001 BNB）；每個人安裝時隨機產生自己的門檻（進度 70～80%、錢包 100～130），壞人猜不到 */
let AG_MIN = FIXED_THR ? 100 : S.thr.ag; /* 使用者 11/1 17:02：改成 100 個（錢包數改成只算送出交易的錢包後，150 太難達到） */ /* 使用者 11/1 14:59：改成 150 個 */ /* 使用者 11/1 14:48：進度夠還不行，也要很多 Agent ID 錢包在打才打（防項目方自己灌進度） */
let GO_PCT = FIXED_THR ? 0.6 : S.thr.go; /* 使用者 11/1 17:54：進度改成 60% */ /* 使用者 11/1 17:02：進度改成 70% */
setTimeout(() => log(`進場門檻：進度 ${Math.round(GO_PCT * 1000) / 10}%、${AG_MIN} 個以上 Agent ID 錢包在打${FIXED_THR ? '（固定）' : '（每個人安裝時隨機產生，壞人猜不到）'}`), 3000); /* 使用者 11/1 14:39：免費、付費都要進度超過 80% 才打（付費還要保本） */ // 使用者 11/1 14:21：同一個部署者 24 小時內部署 ≥10 個項目就不打（大量部署收手續費的那種）
// ---------- 風控（使用者 11/1 14:46：防項目方換招一點點掏 BNB） ----------
const RISK = { dayBnb: 0.01, freePerDay: 20, gasMax: 0.0003, gasMaxPaid: 0.001, revMax: 2 }; // 每錢包每天手續費＋gas 上限、免費每天最多幾個、單筆 gas 上限、同合約上鏈失敗幾次就停
function riskDay() { const d = new Date().toDateString(); if (!S.risk || S.risk.d !== d) S.risk = { d, spend: {}, free: {}, warned: {}, rev: (S.risk && S.risk.rev) || {} }; return S.risk; }
const UPG_SLOTS = ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a8ce03b6d4d6b6bbc', '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036a5a723fd8ee048ed3f8c3'];
async function upgradeable(c) { /* 可升級代理合約：項目方事後能把程式（包括保本機制）整個換掉 */ S.upg = S.upg || {}; if (S.upg[c] != null) return !!S.upg[c]; let u = 0; for (const sl of UPG_SLOTS) { const v = await rpc('eth_getStorageAt', [c, sl, 'latest']).catch(() => null); if (v && /[1-9a-f]/i.test(v.slice(2))) { u = 1; break; } } S.upg[c] = u; return !!u; }
async function drainCheck(c, valueWei, data = '') { /* 使用者 11/1 15:59：付費的錢要留在合約裡（開池當流動性／打不滿能退款）。模擬只看得到自己錢包的變化，所以改看合約裡實際剩多少 BNB：進度都 80% 了合約裡卻幾乎沒錢＝錢被轉走，退款是假的，不打 */
  if (!(BigInt(valueWei || 0) > 0n)) return '';
  S.drainC = S.drainC || {}; const k = S.drainC[c]; if (k && Date.now() - k.t < 60e3) return k.r; /* 網友 AI 建議 11/1：快取從 10 分鐘縮到 1 分鐘，打之前等於重查 */
  let tok = ''; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66);
  let bal = 0; for (const a of [c, tok].filter(Boolean)) bal += Number(BigInt((await rpc('eth_getBalance', [a, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18;
  if (bal < 0.01) { /* v2.7.8：有的合约收到 BNB 会换成 USDT／WBNB 存着，不是被转走；只多算这两种公认的币（假不了），门槛一样 0.01 BNB，其他安全规矩不动 */ const px = await bnbUsd().catch(() => 0) || S.lastBnbUsd || 0; for (const a of [c, tok].filter(Boolean)) { const wb = await call(WBNB, '0x70a08231' + wa(a)).catch(() => null); if (wb && wb.length >= 66) bal += Number(BigInt(wb.slice(0, 66))) / 1e18; const us = await call(USDT, '0x70a08231' + wa(a)).catch(() => null); if (us && us.length >= 66 && px > 50) bal += Number(BigInt(us.slice(0, 66))) / 1e18 / px; } }
  const pair = await call(FACTORY, '0xe6a43905' + wa(tok || c) + wa(WBNB)).catch(() => null); const hasPool = !!(pair && pair.length >= 66 && BigInt(pair.slice(0, 66)) > 0n);
  let r = bal < 0.01 && !hasPool ? `合約裡只剩 ${bal.toFixed(4)} BNB（含換成 USDT／WBNB 的部分），付的錢被轉走了（退款／開池可能是假的）` : '';
  if (false && !r && !hasPool) { /* 使用者 11/1 17:54：保本檢查不要這麼嚴，只保留「錢幾乎被轉光」這條 */ let sold = Number(S.paid?.[c]?._sold || 0); if (sold > 1e7) sold = 0; /* 份數才算，代幣數量（有 18 位小數）不算 */ const a1 = /^0x[0-9a-f]{8}([0-9a-f]{64})/i.exec(data || ''); let units = a1 ? Number(BigInt('0x' + a1[1])) : 1; if (!(units >= 1 && units <= 1000)) units = 1; const unitB = Number(valueWei) / 1e18 / units; const expect = sold * unitB; if (sold > 0 && expect > 0.05 && bal < expect * 0.5) r = `合約裡只有 ${bal.toFixed(3)} BNB，不到已賣出金額（約 ${expect.toFixed(3)} BNB）的一半，錢可能被轉走了`; }
  S.drainC[c] = { t: Date.now(), r }; return r;
}
async function ownerHeavy(c, name) { /* 使用者 11/1 15:59：項目方自己留太多幣（>30%）開池後能砸盤 → 先只警告不擋，觀察準不準 */
  S.ownW = S.ownW || {}; if (S.ownW[c]) return; S.ownW[c] = 1;
  let tok = c; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66);
  const ts0 = big(await call(tok, '0x18160ddd')); if (!(ts0 > 0n)) return;
  const who = new Set(); const ow = await call(c, '0x8da5cb5b'); if (ow && ow.length >= 66 && BigInt(ow.slice(0, 66)) > 0n) who.add('0x' + ow.slice(26, 66).toLowerCase()); const dep = (S.depFrom || {})[c]; if (dep) who.add(dep.toLowerCase());
  for (const a of who) { const code = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '0x')) || '0x'); if (code.length > 2) continue; const b = big(await call(tok, '0x70a08231' + wa(a))); const pct = Number((b * 10000n) / ts0) / 100; if (pct > 30) { log(`⚠️ ${name || c}：項目方錢包 ${a.slice(0, 10)}… 持有 ${pct}% 的幣`); await tg(`⚠️ ${name || c} 達到進場條件，但項目方錢包自己持有 ${pct}% 的幣，開池後可能被砸盤（目前只警告、照規則還是會打）\n${c}`); return; } }
}
// ---------- TG 群組監控（選用，預設關閉；使用者 11/1 16:21）：用自己的 TG 帳號在本機「只讀」自己加入的群組；免費、不花 AI 用量 ----------
// 要用的人自己執行 tg_login.bat（或 node watch.mjs --tg-login）登入一次；沒登入就完全不跑；只抓訊息裡的合約地址、統計幾個群在討論，不存訊息內容；打不打還是照鏈上規則
// ---------- 群裡傳的熱門網址（使用者 11/1 17:47：大家越來越多是丟網址、不丟合約）----------
const URL_SKIP = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.(org|me)|binance\.(com|info)|github\.com|dexscreener\.com|bscscan\.com|etherscan\.io|youtube\.com|youtu\.be|google\.com|gmgn\.ai|geckoterminal\.com|coingecko\.com|coinmarketcap\.com|four\.meme|pancakeswap\.finance|medium\.com|discord\.(gg|com)|instagram\.com|tiktok\.com|okx\.com|bitget\.com|debank\.com|dextools\.io|ave\.ai|mirror\.xyz|notion\.(so|site)|gitbook\.io|docs\.google\.com|linktr\.ee|bit\.ly|tinyurl\.com|facebook\.com|reddit\.com|weibo\.com|bilibili\.com|apple\.com|claude\.ai|openai\.com|chatgpt\.com|pump\.fun|flap\.sh|axiom\.trade|bullx\.io|photon-sol\.tinyastro\.io|poocoin\.app|birdeye\.so|solscan\.io|basescan\.org|arbiscan\.io|tronscan\.org|dexview\.com|web3\.okx\.com|debot\.ai|xxyy\.io|binance\.us|bnbchain\.org)$/i; /* 逆向檢查 11/1：交易／瀏覽器類網站是一個網址底下有成千上萬個幣，整個網域合在一起算會誤報熱門 */
/* 使用者 11/1 20:16：重點群（data/tg_vip.txt 一行一個群名關鍵字）：只要重點群提到合約／網址，不用等 3 個群就進入檢查；安全檢查（Agent ID 專屬、連續部署者、進度、錢包數）一樣要過
   逆向檢查：群裡任何人都能發言，騙子可以在重點群貼假合約 → 只跳過「幾個群在討論」這一關，其他規則不變；每小時最多 30 個，防洗版拖慢工具 */
const VIP_IDS = new Set(); const vipOk = () => { const h = Math.floor(Date.now() / 3600e3); if (S.vipHr?.h !== h) S.vipHr = { h, n: 0 }; if (S.vipHr.n >= 30) return false; S.vipHr.n++; return true; };
function loadVip(dialogs) { VIP_IDS.clear(); const f = join(DIR, 'data', 'tg_vip.txt'); if (!existsSync(f)) return; const kw = readFileSync(f, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#')); for (const d of dialogs) { const t = String(d.title || d.name || ''); if (kw.some((k) => t.includes(k))) VIP_IDS.add(String(d.id)); } }
function noteUrls(t, m, chatId) {
  const urls = [...(t.match(/https?:\/\/[^\s<>"'）)】]+/gi) || [])]; for (const e of m.entities || []) if (e.url) urls.push(e.url);
  for (const d of t.match(/\b[a-z0-9][a-z0-9-]{1,40}\.(xyz|fun|online|io|app|site|ai|top|meme|vip|pro|club|live|link|cc|me|world|tech|finance|money|gg|lol|wtf|bot|agent|net|org|com)\b/gi) || []) urls.push('https://' + d);
  S.urlHits = S.urlHits || {}; const sender = String(m.senderId || m.fromId?.userId || '?');
  for (const u of new Set(urls)) { let host = ''; try { host = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; } if (!host.includes('.') || URL_SKIP.test(host)) continue;
    const h = (S.urlHits[host] = S.urlHits[host] || { chats: {}, senders: {}, first: Date.now(), url: u }); h.chats[chatId] = Date.now(); h.senders[sender] = Date.now(); if (VIP_IDS.has(chatId)) h.vip = Date.now(); }
}
async function siteScan(host, url) { /* 只讀網頁文字：不連錢包、不簽名、不執行網站上的程式；只抓網頁裡列出的合約地址 */
  /* v2.7.7：主程式档里的加密常数（64 位）、Multicall、0xeeee… 这类假地址，以前会被当成「已找到地址」就不去读 deployment.json；改成只认刚好 40 位、排除通用地址，找不到真的合约才换下一个来源 */
  const GEN = new Set(['0xca11bde05977b3631167028862be2a173976ca11', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0xffffffffffffffffffffffffffffffffffffffff', '0x000000000022d473030f116ddee9f6b43ac78ba3']);
  const pick = (t) => [...new Set([...String(t).matchAll(/(?<![0-9a-fA-F])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))].filter((a) => !INFRA.has(a) && !GEN.has(a) && !/^0x0{40}$/.test(a) && !/^0x(.{4})\1{9}$/.test(a) && a !== USDT && a !== WBNB);
  const codeChk = new Map(); const real = async (t) => { const out = []; for (const a of pick(t).slice(0, 12)) { if (!codeChk.has(a)) { const cd = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || ''); codeChk.set(a, cd.length > 2); } if (codeChk.get(a)) out.push(a); } return out; };
  const get = async (u) => { try { const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) }); let fh = ''; try { fh = new URL(r.url).hostname.toLowerCase().replace(/^www\./, ''); } catch {} if (!r.ok || (fh && fh !== host && !fh.endsWith('.' + host))) return ''; const tx = await r.text(); return tx.slice(0, 3e6); } catch { return ''; } };
  let html = await get(url.startsWith('https://') ? url : 'https://' + host + '/'); if (!html && url !== 'https://' + host + '/') html = await get('https://' + host + '/');
  let text = html; const title = noLink(((html.match(/<title[^>]*>([^<]{1,80})/i) || [])[1] || '').trim());
  if (!(await real(html)).length) for (const src of [...new Set([...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+\.(?:json|js)(?:\?[^"']*)?)["']/gi)].map((x) => x[1]))].sort((x, y) => (y.endsWith('.json') ? 1 : 0) - (x.endsWith('.json') ? 1 : 0)).slice(0, 5)) { /* 網站常把合約地址放在 deployment.json 或主程式檔裡 */ let su = ''; try { su = new URL(src, 'https://' + host + '/').href; } catch { continue; } text += await get(su); }
  if (!(await real(text)).length) for (const ep of ['/api/stats', '/api/config', '/api/info', '/api/contract', '/api/contracts', '/api/token', '/api/mint', '/api/status', '/config.json', '/deployment.json', '/contracts.json']) { text += await get('https://' + host + ep); if ((await real(text)).length) break; } /* 使用者 11/1 19:26：像 BAO AGENT 合約只放在網站的資料介面（/api/stats）裡 */
  const cs = (await real(text)).slice(0, 8);
  return { title, cs };
}
async function agentOnly(c) { /* 使用者 11/1 18:26：群裡丟的網址，要先確認是不是「Agent ID（AI 代理人）才能打」的項目 */
  S.agentOnly = S.agentOnly || {}; if (S.agentOnly[c] != null) return S.agentOnly[c];
  let r = ''; try {
    let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); code = await fullCode(c, code).catch(() => code);
    if (code.includes(REGISTRY)) r = '合約裡有 Agent ID 檢查';
    else { /* 合約沒寫（可能是官網簽名驗證）→ 看最近打它的錢包是不是大多持有 Agent ID */
      const head = parseInt(await rpc('eth_blockNumber', []), 16); const L = await logsRpc([{ address: c, fromBlock: '0x' + (head - 3000).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => []);
      const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-40);
      if (hs.length >= 5) { const txs = await rpcBatch(hs.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))); const fr = [...new Set(txs.map((t) => String(t?.from || '').toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))].slice(0, 16);
        let n = 0; for (const a of fr) { const b = await call('0x' + REGISTRY, '0x70a08231' + wa(a)); if (b && BigInt(b.slice(0, 66)) > 0n) n++; } if (fr.length >= 5 && n / fr.length >= 0.6) r = `打它的錢包 ${Math.round((n / fr.length) * 100)}% 持有 Agent ID`; }
    }
  } catch {}
  S.agentOnly[c] = r; return r;
}
async function findByHot(title, host) { /* 使用者 11/1 19:42：網站把合約藏起來 → 看現在 Agent ID 錢包正在大量打哪些合約，名字跟網站對得上的就是它 */
  const words = [...new Set(String(title + ' ' + host.split('.')[0]).toLowerCase().match(/[a-z0-9一-鿿]{4,}/g) || [])].filter((w) => !/^(agent|mint|meme|token|launch|https|www|fair|curve|chain|smart|binance)$/.test(w));
  if (!words.length) return [];
  const top = [...HOT.entries()].filter(([a, h]) => h.from.size >= 5 && !INFRA.has(a)).sort((a, b) => b[1].from.size - a[1].from.size).slice(0, 40);
  const out = [];
  for (const [a] of top) { let nm = (tokStr(await call(a, '0x06fdde03')) + ' ' + tokStr(await call(a, '0x95d89b41'))).toLowerCase(); if (!nm.trim()) { const tr = await call(a, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) { const t = '0x' + tr.slice(26, 66); nm = (tokStr(await call(t, '0x06fdde03')) + ' ' + tokStr(await call(t, '0x95d89b41'))).toLowerCase(); } } const nn = nm.replace(/[^a-z0-9一-鿿]/g, ''); if (nn && words.some((w) => nn.includes(w) || w.includes(nn))) out.push(a); }
  return out.slice(0, 3);
}
async function hotUrls() {
  if (!S.urlHits) return; S.urlNoted = S.urlNoted || {}; if (S.urlRetryV !== 1) { S.urlRetryV = 1; for (const [hh, v] of Object.entries(S.urlHits)) if (Date.now() - (v.first || 0) < 7200e3) delete S.urlNoted[hh]; } /* 新功能上線：最近 2 小時找不到合約的熱門網址重新找一次 */
  for (const [host, h] of Object.entries(S.urlHits)) {
    for (const o of [h.chats, h.senders]) for (const [k, t] of Object.entries(o)) if (Date.now() - t > 86400e3) delete o[k];
    const nc = Object.keys(h.chats).length, ns = Object.keys(h.senders).length; if (!nc && Date.now() - h.first > 86400e3) { delete S.urlHits[host]; continue; }
    if (h.retryAt && Date.now() > h.retryAt && Date.now() - h.first < 7200e3 && !h.found) { h.retryAt = Date.now() + 120e3; const fh = await findByHot(h.title || '', host).catch(() => []); const ok = []; for (const c of fh) if (await agentOnly(c)) ok.push(c); if (ok.length) { h.found = 1; for (const c of ok) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: h.title || host, done: {}, fromUrl: host, needLearn: 1 }; } log(`🌐 ${host}：從 Agent ID 錢包正在打的合約裡找到 ${ok.join('、')}`); await tg(`🌐 找到 ${host} 的合約了（從 Agent ID 錢包正在打的合約比對名字）：\n${ok.join('\n')}\n已加入追蹤，照規則決定打不打`); } continue; }
    const vipU = h.vip && Date.now() - h.vip < 86400e3; if (S.urlNoted[host] || !(nc >= 2 || ns >= 3 || vipU)) continue; if (vipU && !(nc >= 2 || ns >= 3) && !vipOk()) continue; /* 使用者 11/1 18:03：門檻降低，更早發現（安小將湊滿 3 群 5 人時已經快賣完） */ S.urlNoted[host] = ts();
    const { title, cs: cs0 } = await siteScan(host, h.url).catch(() => ({ title: '', cs: [] }));
    if (!cs0.length) { const fh = await findByHot(title, host).catch(() => []); for (const c of fh) cs0.push(c); if (!fh.length) { h.retryAt = Date.now() + 120e3; h.title = title; } } /* 網站上找不到合約 → 從 Agent ID 錢包正在打的熱門合約裡比對名字；找不到就每 2 分鐘再找一次（最多 2 小時） */
    const cs = [], why = {}; for (const c of cs0) { const w = await agentOnly(c); if (w) { cs.push(c); why[c] = w; } }
    if (cs0.length && !cs.length) { log(`🌐 熱門網址：${host}（${nc} 個群、${ns} 個人在傳）網站上的合約都不是 Agent ID 專屬項目，略過：${cs0.join('、')}`); continue; }
    for (const c of cs) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: title || host, done: {}, fromUrl: host, needLearn: 1 }; (S.grpHits = S.grpHits || {})[c] = S.grpHits[c] || { chats: {}, first: Date.now(), names: [] }; Object.assign(S.grpHits[c].chats, h.chats); }
    log(`🌐 熱門網址：${host}（${nc} 個群、${ns} 個人在傳）${title ? '「' + title + '」' : ''} → 網站上的合約：${cs.join('、') || '找不到'}`);
    await tg(`🌐 ${vipU && !(nc >= 2 || ns >= 3) ? '⭐ 重點群' : nc + ' 個群、' + ns + ' 個人'}在傳：${host}${title ? '\n' + title : ''}\n${cs.length ? 'Agent ID 專屬的合約（已加入追蹤，打不打照鏈上規則）：\n' + cs.map((c) => c + '（' + why[c] + '）').join('\n') : '網站上找不到合約地址（可能要連錢包後才顯示），要看的話手動處理'}`);
  }
  const ks = Object.keys(S.urlHits); if (ks.length > 5000) for (const k of ks.slice(0, ks.length - 5000)) delete S.urlHits[k];
  const kn = Object.keys(S.urlNoted); if (kn.length > 3000) for (const k of kn.slice(0, kn.length - 3000)) delete S.urlNoted[k];
}
let _tgc = null, _tgBusy = false, _tgDialogsAt = 0, _tgDialogs = [];
async function tgGroupWatch() {
  const f = join(DIR, 'data', 'tg_user.json'); if (!existsSync(f) || _tgBusy) return; _tgBusy = true;
  try {
    if (!_tgc) { const { createRequire } = await import('module'); const req = createRequire(import.meta.url); const { TelegramClient } = req('telegram'); const { StringSession } = req('telegram/sessions'); const u = JSON.parse(readFileSync(f, 'utf8')); _tgc = new TelegramClient(new StringSession(u.session), u.apiId, u.apiHash, { connectionRetries: 5 }); try { _tgc.setLogLevel('none'); } catch {} await _tgc.connect(); log('TG 群組監控：已連線（只讀）'); }
    if (Date.now() - _tgDialogsAt > 600e3) { _tgDialogs = (await _tgc.getDialogs({ limit: 300 })).filter((d) => d.isGroup || d.isChannel); _tgDialogsAt = Date.now(); loadVip(_tgDialogs); _tgDialogs.sort((a, b) => (VIP_IDS.has(String(b.id)) ? 1 : 0) - (VIP_IDS.has(String(a.id)) ? 1 : 0)); try { writeFileSync(join(DIR, 'data', 'tg_groups.txt'), _tgDialogs.map((d) => `${d.isChannel && !d.isGroup ? '頻道' : '群組'}\t${d.entity?.username ? '@' + d.entity.username : '-'}\t${String(d.title || d.name || '').replace(/\s+/g, ' ')}`).join('\n')); } catch {} }
    S.tgLast = S.tgLast || {}; S.grpHits = S.grpHits || {}; let n = 0;
    for (const d of _tgDialogs) {
      const id = String(d.id); const top = d.message?.id || 0; const last = S.tgLast[id];
      if (last == null) { S.tgLast[id] = top; continue; } /* 第一次只記位置，不回頭讀舊訊息 */
      if (top <= last) continue; if (n++ >= 12) break; /* 每分鐘最多讀 12 個有新訊息的群，慢慢讀 */
      await sleep(1500);
      const msgs = await _tgc.getMessages(d.entity, { limit: 50, minId: last }).catch(() => []);
      let mx = last; for (const m of msgs) { if (m.id > mx) mx = m.id; const t = String(m.message || ''); noteUrls(t, m, id); for (const c of new Set((t.match(/0x[a-fA-F0-9]{40}/g) || []).map((x) => x.toLowerCase()))) { if (INFRA.has(c)) continue; const h = (S.grpHits[c] = S.grpHits[c] || { chats: {}, first: Date.now(), names: [] }); h.chats[id] = Date.now(); if (VIP_IDS.has(id)) h.vip = Date.now(); const nm = String(d.title || d.name || '').slice(0, 20); if (nm && !h.names.includes(nm)) h.names.push(nm); } }
      S.tgLast[id] = Math.max(mx, top);
    }
    for (const [c, h] of Object.entries(S.grpHits)) {
      for (const [k, t] of Object.entries(h.chats)) if (Date.now() - t > 86400e3) delete h.chats[k];
      const cnt = Object.keys(h.chats).length; if (!cnt && Date.now() - h.first > 86400e3) { delete S.grpHits[c]; continue; }
      const vipC = h.vip && Date.now() - h.vip < 86400e3 && cnt < 3; if ((cnt >= 3 || vipC) && !h.noted) { if (vipC && !vipOk()) continue; h.noted = 1; const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || ''); if (code.length <= 2) continue;
        const ao = await agentOnly(c); if (!ao) { log(`💬 ${cnt} 個群在討論 ${c}，但不是 Agent ID 專屬項目，略過`); continue; } /* 使用者 11/1 18:26 */
        let nm = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10);
        S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: nm, done: {}, fromGroups: cnt, needLearn: 1, ...(vipC ? { fromCall: 'vip' } : {}) }; /* 重點群來的跟頻道一樣優先算熱度 24 小時 */
        log(`💬 TG 群組熱議：${nm} ${c} 24 小時內有 ${cnt} 個群在討論（${h.names.slice(0, 5).join('、')}），加入追蹤，照鏈上規則決定打不打`);
        await tg(`💬 ${vipC ? '⭐ 重點群提到' : cnt + ' 個 TG 群在討論'}：${nm}\n${h.names.slice(0, 5).join('、')}\n${c}\n已加入追蹤，打不打照鏈上規則（進度、Agent ID 錢包數、保本）`); }
    }
    const ks = Object.keys(S.grpHits); if (ks.length > 5000) for (const k of ks.slice(0, ks.length - 5000)) delete S.grpHits[k];
    await hotUrls().catch((e) => log('熱門網址：' + String(e.message || e).slice(0, 80)));
  } catch (e) { log('TG 群組監控：' + String(e.message || e).slice(0, 100)); if (/AUTH_KEY|SESSION|UNREGISTERED|revoked/i.test(String(e.message))) { _tgc = null; if (!S.tgAuthWarn || Date.now() - S.tgAuthWarn > 86400e3) { S.tgAuthWarn = Date.now(); await tg('⚠️ TG 群組監控登入失效了，請重新執行 tg_login.bat（或在工具資料夾執行 node watch.mjs --tg-login）'); } } }
  finally { _tgBusy = false; }
}
setInterval(() => { tgGroupWatch().catch(() => {}); }, 60e3);
const grpN = (c) => Object.keys(S.grpHits?.[c]?.chats || {}).length; const grpTxt = (c) => { const n = grpN(c); return n ? `\n💬 ${n} 個 TG 群在討論${(S.grpHits[c].names || []).length ? '（' + S.grpHits[c].names.slice(0, 3).join('、') + '）' : ''}` : ''; }; /* 使用者 11/1 16:35：通知附上群組熱度 */
const paidDayUsd = (W) => { const d = new Date().toDateString(); if (!S.paidUsd || S.paidUsd.d !== d) S.paidUsd = { d }; return S.paidUsd[W.name] || 0; };
const addPaidUsd = (W, u) => { paidDayUsd(W); S.paidUsd[W.name] = (S.paidUsd[W.name] || 0) + (Number(u) || 0); save(); };
const LIMIT_NAMES = ['maxPerWallet', 'maxMintPerWallet', 'MAX_PER_WALLET', 'MAX_MINT_PER_WALLET', 'maxPerAddress', 'MAX_PER_ADDRESS', 'maxMintsPerWallet', 'walletLimit', 'mintLimit', 'perWalletLimit', 'maxPerUser', 'maxPerAccount', 'maxMintPerAddress', 'MAX_MINT_PER_ADDRESS', 'maxMintAmountPerWallet', 'maxPerAgent', 'MAX_PER_AGENT', 'maxUnitsPerWallet', 'MAX_UNITS_PER_WALLET', 'maxMintPerAgent', 'quotaPerAgent', 'baseQuota', 'BASE_QUOTA', 'maxPerID', 'perAddressLimit', 'MAX_PER_TX', 'maxPerTx', 'maxMintPerTx', 'MAX_MINT_PER_TX', 'maxMintAmountPerTx', 'maxPerTransaction']; /* 使用者 11/1 18:03：「每筆上限」也算有上限（安小將只有每筆 10 份） */
const TX_LIMIT = new Set(['MAX_PER_TX', 'maxPerTx', 'maxMintPerTx', 'MAX_MINT_PER_TX', 'maxMintAmountPerTx', 'maxPerTransaction']);
async function walletLimit(c, strict = false) { /* 使用者 11/1 17:54：要有「每個錢包最多幾份」規定的項目才打（特別是 NFT）——沒有上限的，項目方或少數人可以無限灌 */
  if (S.wlimV !== 2) { S.wlimV = 2; S.wlim = {}; for (const P of Object.values(S.paid || {})) { delete P.wlim; delete P.noLimLog; } } /* 規則放寬後重新判斷 */
  S.wlim = S.wlim || {}; const ck = strict ? c + ':w' : c; if (S.wlim[ck] != null) return S.wlim[ck];
  let lim = 0; try { let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); code = await fullCode(c, code).catch(() => code);
    for (const nm of LIMIT_NAMES) { if (strict && TX_LIMIT.has(nm)) continue; const sel = keccakHex(Buffer.from(nm + '()').toString('hex')).slice(0, 8); if (!code.includes(sel)) continue; const r = await call(c, '0x' + sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x >= 1 && x <= 10000) { lim = x; break; } } } } catch {}
  S.wlim[ck] = lim; return lim;
}
// ---------- NFT 要很嚴格（使用者 11/1 18:36）：進度 70%、150 個錢包、一定要有「每個錢包上限」、預算 10U、圖片資料要真的打得開、不能重複用別人的圖 ----------
async function isNft(c) { S.isNft = S.isNft || {}; if (S.isNft[c] != null) return !!S.isNft[c]; let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); code = await fullCode(c, code).catch(() => code); const v = code.includes('c87b56dd') || code.includes('0e89341c') ? 1 : 0; S.isNft[c] = v; return !!v; }
const gw = (u) => String(u || '').trim().replace(/^ipfs:\/\/(ipfs\/)?/i, 'https://ipfs.io/ipfs/').replace(/^ar:\/\//i, 'https://arweave.net/');
async function nftStrict(c) {
  S.nftOk = S.nftOk || {}; const k = S.nftOk[c]; if (k && (k.r === '' || Date.now() - k.t < 1800e3)) return k.r;
  let r = '';
  try {
    const str = (x) => { try { const b = Buffer.from(x.slice(2), 'hex'); const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + n).toString('utf8').trim(); } catch { return ''; } };
    let uri = ''; for (const [sel, id] of [['c87b56dd', 1n], ['c87b56dd', 0n], ['0e89341c', 1n], ['0e89341c', 0n]]) { const x = await call(c, '0x' + sel + w(id)); if (x && x.length > 130) { uri = str(x); if (uri) break; } }
    if (!uri) r = 'NFT 讀不到圖片資料';
    else {
      let meta = null;
      if (/^data:application\/json;base64,/i.test(uri)) { try { meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8')); } catch {} }
      else if (/^data:application\/json/i.test(uri)) { try { meta = JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1))); } catch {} }
      else { try { const rs = await fetch(gw(uri), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }); if (rs.ok) meta = JSON.parse((await rs.text()).slice(0, 2e5)); } catch {} }
      const img = meta && (meta.image || meta.image_url || meta.animation_url);
      if (!img) r = 'NFT 圖片資料打不開或裡面沒有圖片';
      else {
        let hash = '';
        if (/^data:image\//i.test(img)) hash = createHash('sha256').update(String(img)).digest('hex');
        else { try { const ri = await fetch(gw(img), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); if (ri.ok) { const buf = Buffer.from(await ri.arrayBuffer()); if (buf.length > 200) hash = createHash('sha256').update(buf.subarray(0, 512e3)).digest('hex'); } } catch {} }
        if (!hash) r = 'NFT 圖片打不開';
        else { /* 有人會用同一張圖重複開盤 → 同一張圖（內容一樣）出現在別的合約就不打 */
          S.nftImg = S.nftImg || {}; const urlKey = 'u:' + gw(img).toLowerCase(); const first = S.nftImg[hash] || S.nftImg[urlKey];
          if (first && first !== c) r = `NFT 圖片跟另一個合約 ${first.slice(0, 10)}… 一模一樣，疑似重複用同一張圖開盤`;
          else { S.nftImg[hash] = c; S.nftImg[urlKey] = c; const ks = Object.keys(S.nftImg); if (ks.length > 20000) for (const kk of ks.slice(0, 2000)) delete S.nftImg[kk]; }
        }
      }
    }
  } catch { r = 'NFT 圖片檢查失敗'; }
  S.nftOk[c] = { t: Date.now(), r }; return r;
}
async function othersPay(c) { /* 使用者 11/1 18:50：「第一份免費、之後付費」（像牛來）要當付費看——看最近別人打它是不是大多有付 BNB */
  S.othersPay = S.othersPay || {}; const k = S.othersPay[c]; if (k && Date.now() - k.t < 600e3) return k.v;
  let v = 0; try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const L = await logsRpc([{ address: c, fromBlock: '0x' + (head - 2000).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => []);
    const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-20); if (hs.length >= 5) { const txs = await rpcBatch(hs.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))); const ok = txs.filter((t) => t && String(t.to || '').toLowerCase() === c); const paid = ok.filter((t) => BigInt(t.value || '0x0') > 0n).length; if (ok.length >= 5 && paid / ok.length >= 0.5) v = 1; } } catch {}
  S.othersPay[c] = { t: Date.now(), v }; return v;
}
async function freeNotify(c, name, prog, agents) { /* 使用者 11/1 15:56：免費項目大多不會真的發射、還是壞人掏錢的入口 → 不自動打，達到條件只通知，使用者要打再手動 */
  S.freeNote = S.freeNote || {}; if (S.freeNote[c]) return; S.freeNote[c] = ts(); const ks = Object.keys(S.freeNote); if (ks.length > 3000) delete S.freeNote[ks[0]];
  let nm = name; if (!nm || /頻道項目/.test(nm)) nm = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10);
  const nj = await nftJunk(c).catch(() => ''); if (nj) { log(`免費項目 ${nm} 達到條件但 ${nj}，不通知`); return; }
  nm = noLink(nm);
  log(`🔔 免費項目達到條件（只通知、不自動打）：${nm} ${c}`);
  await tg(`🔔 免費項目達到條件（照規則不自動打）：${nm}\n進度 ${prog != null ? Math.floor(prog * 100) + '%' : '讀不到'} · ${agents || 0} 個 Agent ID 錢包在打${grpTxt(c)}\n${c}\n${UPD.on ? '要打的話請自己手動鑄造' : '要打的話手動處理「打 ' + nm + '」'}`);
}
async function nftJunk(c) { /* 使用者 11/1 15:03：NFT 的圖片連結是假的或空的（像 ipfs://sniper-test-nft/1）就不打——批量掏手續費的垃圾項目連圖都沒做 */
  S.nftJunk = S.nftJunk || {}; if (S.nftJunk[c] != null) return S.nftJunk[c];
  const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); let fc = code; try { fc = await fullCode(c, code); } catch {}
  if (!fc.includes('c87b56dd')) return (S.nftJunk[c] = ''); /* 不是 NFT（沒有 tokenURI） */
  const str = (r) => { try { const b = Buffer.from(r.slice(2), 'hex'); const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + n).toString('utf8').trim(); } catch { return ''; } };
  let uri = null; for (const id of [1n, 0n]) { const r = await call(c, '0xc87b56dd' + w(id)); if (r && r.length > 130) { uri = str(r); break; } if (r) uri = uri ?? ''; }
  if (uri == null) return ''; /* 讀不到（可能還沒鑄出任何一個），先不判斷 */
  const ok = /^data:/i.test(uri) || /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(uri) || /^ar:\/\/[A-Za-z0-9_-]{30,}/.test(uri) || /^ipfs:\/\/(ipfs\/)?(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})/.test(uri);
  return (S.nftJunk[c] = ok ? '' : `NFT 圖片連結是${uri ? '假的（' + uri.slice(0, 40) + '）' : '空的'}`);
}
async function riskBlock(W, c, valWei, data, isFree, paid = false) { /* 回傳不打的原因；空字串＝可以打 */
  const R = riskDay();
  { const nj = await nftJunk(c).catch(() => ''); if (nj) return nj + '，疑似垃圾項目'; }
  if ((R.rev[c] || 0) >= RISK.revMax) return `這個合約上鏈失敗 ${R.rev[c]} 次，不再試（避免一直燒 gas）`;
  if (!paid && (R.spend[W.name] || 0) >= RISK.dayBnb) { if (!R.warned[W.name]) { R.warned[W.name] = 1; tg(`⚠️ [${W.name}] 今天手續費＋gas 已花 ${(R.spend[W.name]).toFixed(4)} BNB，達到每日上限 ${RISK.dayBnb} BNB，今天停止自動打（賣出不受影響）`).catch(() => {}); } return `今天手續費＋gas 已達 ${RISK.dayBnb} BNB 上限`; }
  if (isFree && !(R.free[W.name] || []).includes(c) && (R.free[W.name] || []).length >= RISK.freePerDay) return `今天已自動打 ${RISK.freePerDay} 個免費項目，達到上限`;
  const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18;
  if (bal - Number(valWei) / 1e18 < PAID.keepBnb) return `BNB 低於保留額 ${PAID.keepBnb}，只留給賣出用`;
  try { const g = await rpc('eth_estimateGas', [{ from: W.addr, to: c, data, value: '0x' + BigInt(valWei).toString(16) }]); const gp = await rpc('eth_gasPrice', []); const fee = (Number(BigInt(g)) * Number(BigInt(gp))) / 1e18; if (fee > (paid ? RISK.gasMaxPaid : RISK.gasMax)) return `預估 gas ${fee.toFixed(5)} BNB 太高`; } catch {}
  return '';
}
function riskAfter(W, c, tx, valWei, isFree, countFee = true) { /* 送出後記帳：手續費＋實際 gas；上鏈失敗次數 */
  const R = riskDay(); if (countFee) R.spend[W.name] = (R.spend[W.name] || 0) + Number(valWei) / 1e18; if (isFree) { const f = (R.free[W.name] = Array.isArray(R.free[W.name]) ? R.free[W.name] : []); if (!f.includes(c)) f.push(c); }
  if (!tx || !/^0x[0-9a-f]{64}$/i.test(tx)) return;
  (async () => { for (let i = 0; i < 6; i++) { await sleep(5000); const r = await rpc('eth_getTransactionReceipt', [tx]).catch(() => null); if (!r) continue; const gas = (Number(BigInt(r.gasUsed || '0x0')) * Number(BigInt(r.effectiveGasPrice || '0x0'))) / 1e18; const R2 = riskDay(); R2.spend[W.name] = (R2.spend[W.name] || 0) + gas; if (r.status === '0x0') { R2.rev[c] = (R2.rev[c] || 0) + 1; log(`[${W.name}] 上鏈失敗（白燒 gas ${gas.toFixed(5)} BNB）：${c}，今天第 ${R2.rev[c]} 次`); } save(); return; } })().catch(() => {});
}
async function serialDev(c) { const dep = (S.depFrom || {})[c]; if (!dep) return ''; /* 只用「實際送出部署交易的錢包」判斷，不用 owner()（發射台的項目 owner 常是同一個平台，會誤殺） */ const n = new Set(((S.devs || {})[dep] || []).filter((x) => Date.now() - x.t < 86400e3).map((x) => x.c)).size; return n >= DEV_MAX ? `同一個部署者 ${dep.slice(0, 10)}… 24 小時內部署了 ${n} 個項目` : ''; }
function isRepeatDev(dep) { return !!dep && new Set(((S.devs || {})[dep] || []).filter((x) => Date.now() - x.t < 86400e3).map(devKey)).size >= 3; }
function blacklist(dep, why) { if (!dep) return; S.black = S.black || {}; if (!S.black[dep]) { S.black[dep] = { at: ts(), why }; log(`黑名單：${dep}（${why}）`); } }

const heatTier = (P) => ((P.agents || 0) >= 200 || (P.burst || 0) >= 30 ? 2 : (P.agents || 0) >= 100 || (P.burst || 0) >= 15 ? 1 : 0);
function markUnmintable(c, P, sym, progress, why = '要官網簽名或白名單') { P.lastReason = why; // 達到進場條件但我們打不了：標記不再重試，通知使用者一次
  if (P.unmintable) return; P.unmintable = ts(); P.unmintableAt = Date.now();
  log(`打不了 ${c}（${sym}）：${why}`);
  if (Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 50 && !((progress || 0) >= 0.98)) tg(`⚠️ 很熱門但工具打不了：${noLink(sym || P.name || '新項目')}（${Math.max(P.agents || 0, HOT.get(c)?.from.size || 0)} 個錢包在打${progress > 0 ? '，進度約 ' + Math.round(progress * 100) + '%' : ''}）\n原因：${why}\n要的話請自己到官網手動打\n${c}`).catch(() => {}); /* 使用者 11/1 17:06：FIST 這種很熱但打不了的要通知 */
}
function noteFail(c, P, sym, progress) { P.cf = (P.cf || 0) + 1; if (P.cf >= 8) markUnmintable(c, P, sym, progress, '模擬鑄造一直失敗，可能已賣完、要官網簽名、白名單或已關閉'); } // 重試 4 輪（兩個錢包）都失敗就不再試
const agentCache = new Map(); // 地址 → 有沒有 .ai Agent ID
async function rpcBatch(reqs) { const out = []; for (let i = 0; i < reqs.length; i += 100) { for (const u of ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com']) { let got = 0; try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs.slice(i, i + 100).map((r, k) => ({ jsonrpc: '2.0', id: i + k, ...r }))), signal: AbortSignal.timeout(20000) })).json(); for (const r of (Array.isArray(j) ? j : [])) if (r.result !== undefined) { out[r.id] = r.result; got++; } } catch {} if (got) break; } } return out; } /* 除錯 11/1：只用一個節點，被限流時整批查不到 → Agent ID 人數算成 0（GOOSE 534 人在打卻顯示 0） */
const NEWAG = { at: 0, set: new Set(), busy: false }, NONCE = new Map();
async function newAgents() { /* v2.8.1 防小号凑数：24 小时内才注册的 Agent ID 钱包不算（从 Agent ID 合约的铸造纪录读，15 分钟更新一次） */
  if (NEWAG.busy || Date.now() - NEWAG.at < 15 * 60e3) return NEWAG.set; NEWAG.busy = true;
  try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const set = new Set(); let ok = 0;
    for (let b = head - 115200; b <= head; b += 5000) { const q = [{ address: '0x' + REGISTRY, fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 4999, head).toString(16), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64)] }]; const L = await rpc('eth_getLogs', q).catch(() => logsRpc(q).catch(() => null)); if (L) { ok++; for (const l of L) if (l.topics?.[2]) set.add('0x' + l.topics[2].slice(26).toLowerCase()); } }
    if (ok >= 20) { NEWAG.set = set; NEWAG.at = Date.now(); } } finally { NEWAG.busy = false; } return NEWAG.set; }
const AGTOK = { usd: 10, dayUsd: 20, need: 100, winMin: 20, minLiqBnb: 10, maxTax: 10, maxBundle: 0.15, maxTop10: 0.3, minReal: 30 }; /* 11/2：加捆绑／前10大／真实买家（跟 Robinhood 同一套），数字玩家自己改 */ /* 11/1 22:21 使用者定：20 分鐘內 100 個 Agent ID 錢包就自動打；每個錢包 10U、代幣另外每天 20U（不佔鑄造的額度）；要過貔貅／稅率／流動性檢查 */
const tokDayUsd = (W) => { const d = new Date().toDateString(); if (!S.tokUsd || S.tokUsd.d !== d) S.tokUsd = { d }; return S.tokUsd[W.name] || 0; };
/* 罗宾猫雷达 11/1：桌面程式的「暂停」「自动打开关」「每笔金额」「手动买卖」接到这里 */
const RADAR = { set: {}, at: 0 };
const SCHEMA = (() => { try { return JSON.parse(readFileSync(join(DIR, 'radar', 'settings_schema.json'), 'utf8')).items || []; } catch { return []; } })();
function radarSet() { if (Date.now() - RADAR.at > 15e3) { RADAR.at = Date.now(); try { RADAR.set = JSON.parse(readFileSync(join(DIR, 'data', 'radar_settings.json'), 'utf8')) || {}; } catch { RADAR.set = {}; } applySettings(RADAR.set); } return RADAR.set; }
const SDEF = { maxUsd: PAID.maxUsd, dayDesc: Object.getOwnPropertyDescriptor(PAID, 'dayUsd'), GO_PCT, AG_MIN, AGTOK: { ...AGTOK }, RULE: { backX: RULE.backX, crash: RULE.crash, crashAfterBack: RULE.crashAfterBack } }; /* 程式里的推荐值：用户改回推荐值时立刻恢复，不用重开 */
function applySettings(set) {
  PAID.maxUsd = SDEF.maxUsd; Object.defineProperty(PAID, 'dayUsd', { ...SDEF.dayDesc, configurable: true }); GO_PCT = SDEF.GO_PCT; AG_MIN = SDEF.AG_MIN; Object.assign(AGTOK, SDEF.AGTOK); Object.assign(RULE, SDEF.RULE); /* 罗宾猫雷达 11/2：玩家在「设定」或叫自己的 AI 改 data/radar_settings.json；只套用有改过的项目，没改的维持程式里的推荐值；每项都限制在 settings_schema.json 的最小～最大值 */
  const old = { 'bsc.mintUsd': set.mintUsd, 'bsc.tokUsd': set.tokUsd ?? set.perUsd };
  const v = (k) => { const it = SCHEMA.find((x) => x.k === k); let x = set[k] ?? old[k]; if (x == null || x === '' || !it) return null; x = Number(x); if (!Number.isFinite(x)) return null; return Math.min(it.max, Math.max(it.min, x)); };
  const put = (k, f) => { const x = v(k); if (x != null) f(x); }; /* 11/2 她定：金额上限由用户自己设定，程式不另外限制 */
  put('bsc.mintUsd', (x) => { PAID.maxUsd = x; }); put('bsc.mintDayUsd', (x) => Object.defineProperty(PAID, 'dayUsd', { get: () => x, configurable: true }));
  put('bsc.goPct', (x) => { GO_PCT = x / 100; }); put('bsc.agMin', (x) => { AG_MIN = Math.round(x); });
  put('bsc.tokUsd', (x) => { AGTOK.usd = x; }); put('bsc.tokDayUsd', (x) => { AGTOK.dayUsd = x; }); put('bsc.tokNeed', (x) => { AGTOK.need = Math.round(x); }); put('bsc.tokWinMin', (x) => { AGTOK.winMin = x; }); put('bsc.tokMinLiqBnb', (x) => { AGTOK.minLiqBnb = x; }); put('bsc.tokMaxTax', (x) => { AGTOK.maxTax = x; }); put('bsc.tokMaxBundle', (x) => { AGTOK.maxBundle = x / 100; }); put('bsc.tokMaxTop10', (x) => { AGTOK.maxTop10 = x / 100; }); put('bsc.tokMinReal', (x) => { AGTOK.minReal = Math.round(x); });
  put('sell.backX', (x) => { RULE.backX = x; }); put('sell.crash', (x) => { RULE.crash = x / 100; }); put('sell.crashAfterBack', (x) => { RULE.crashAfterBack = x / 100; });
  globalThis.RH_APPLY?.(set, SCHEMA);
}
setInterval(() => { try { radarSet(); } catch {} }, 15e3).unref();
const radarOff = () => existsSync(join(DIR, 'data', 'pause_buy.txt')) || radarSet().auto === false || (!radarSet().setupDone && existsSync(join(DIR, 'radar', 'main.cjs'))); /* 有装罗宾猫雷达的：第一次打开还没选打法（setupDone）之前不自动买；只用 /update 更新单档的旧用户不受影响 */ /* 暂停／关掉自动打：只停自动买，卖出照常 */
const SELF_FILE = fileURLToPath(import.meta.url);
const ORD_SEEN = new Set(); let LK_SEQ = 0; /* 只保留最新一次搜寻的结果 */
async function radarOrders() {
  const q = join(DIR, 'data', 'radar_orders.json'); if (!existsSync(q)) return;
  const tmp = q + '.run'; try { renameSync(q, tmp); } catch { return; }
  let arr = []; try { arr = JSON.parse(readFileSync(tmp, 'utf8')) || []; } catch {} try { unlinkSync(tmp); } catch {}
  for (const o of arr.slice(0, 10)) {
    if (o.id) { if (ORD_SEEN.has(o.id)) continue; ORD_SEEN.add(o.id); if (ORD_SEEN.size > 500) ORD_SEEN.delete(ORD_SEEN.values().next().value); } /* 反向抓错 11/2：雷达写单和引擎取单同时发生时，旧单会被写回去 → 用编号去重，绝不重复下单 */
    if (o.type === 'addWallet' || o.type === 'removeWallet') { const f = join(DIR, 'data', 'radar_wallets_cfg.json'); const cfg = { add: [], hidden: [], ...WCFG }; const a = String(o.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
      if (o.type === 'addWallet') { cfg.hidden = (cfg.hidden || []).filter((x) => x !== a); if (!WALLETS.some((w) => w.addr === a) && !cfg.add.some((w) => w.address.toLowerCase() === a)) { const id = 'w' + Date.now().toString(36); cfg.add.push({ name: String(o.name || 'wallet').replace(/[^\w.\-\u4e00-\u9fff]/g, '').slice(0, 30) || 'wallet', address: a, bawDir: 'baw_' + id, instanceId: 'radar-' + id }); } }
      else { const held = (S.dyn || []).filter((t) => t.only === a && !t.closed).length; if (WALLETS.filter((w) => w.addr !== a).length < 1) { await tgSay('🖥 雷达：至少要留一个钱包，没有移除').catch(() => {}); continue; } cfg.add = cfg.add.filter((w) => w.address.toLowerCase() !== a); if (!cfg.hidden.includes(a)) cfg.hidden.push(a); if (held) await tgSay(`⚠️ 已移除钱包 ${a.slice(0, 8)}…，它还有 ${held} 个持仓，雷达之后不会再帮它卖，请自己处理`).catch(() => {}); }
      writeFileSync(f, JSON.stringify(cfg, null, 1)); log(`雷达${o.type === 'addWallet' ? '新增' : '移除'}钱包 ${a}，重新载入`); try { const { utimesSync } = await import('node:fs'); const now = new Date(); utimesSync(SELF_FILE, now, now); } catch {} continue; } /* 改 watch.mjs 的时间 → 工具自动重新载入，钱包名单生效 */
    if (o.type === 'lookup') { const seq = ++LK_SEQ; (async () => { /* 雷达搜寻：输入合约或网址 → 找出合约、加入追踪、回报给雷达 */
      const q = String(o.q || '').trim().slice(0, 300); const out = { q, at: Date.now(), found: [], err: '' }; let cs = [];
      try { const inUrl = [...new Set((q.match(/0x[0-9a-fA-F]{40}/g) || []).map(x => x.toLowerCase()))]; if (inUrl.length) cs = inUrl.slice(0, 4); else { let u = q; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; const host = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); const r = await Promise.race([siteScan(host, u).catch(() => ({ cs: [] })), new Promise((ok) => setTimeout(() => ok({ cs: [], slow: 1 }), 12e3))]); if (r.slow) out.err = '这个网站读太久（超过 12 秒），请改贴合约地址'; cs = (r.cs || []).slice(0, 8); out.title = r.title || ''; if (!cs.length && !out.err) out.err = '这个网址里找不到合约地址'; } } catch (e) { out.err = '格式不对：请贴合约地址（0x 开头 42 码）或网址'; }
      const LKF = join(DIR, 'data', 'radar_lookup.json'); const quick = []; const W_ = (v) => { if (seq === LK_SEQ) writeFileSync(LKF, JSON.stringify(v)); }; W_({ ...out, partial: 1 });
      const str = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/[\u0000-\u001f]/g, '').slice(0, 60); } catch { return ''; } };
      const words = String(out.title || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length >= 3 && !['mint', 'agent', 'the', 'official', 'app', 'www', 'com'].includes(w));
      let hostW = ''; try { hostW = new URL(/^https?:/i.test(q) ? q : 'https://' + q).hostname.replace(/^www\./, '').split('.')[0].toLowerCase(); } catch {}
      out.found = await Promise.all(cs.map(async (c) => { try { const code = await rpc('eth_getCode', [c, 'latest']).catch(() => '0x'); if (!code || code === '0x') return { c, kind: 'wallet', why: 'BSC 上这不是合约（一般钱包，或是别条链的合约）' };
        const name = str(await call(c, '0x06fdde03')), sym = str(await call(c, '0x95d89b41')); const isTok = !!(await call(c, '0x313ce567')) && !!sym;
        const nm = `${name} ${sym}`.toLowerCase(); const self = !!nm.trim() && ((hostW.length >= 3 && nm.replace(/[^a-z0-9]/g, '').includes(hostW.replace(/[^a-z0-9]/g, ''))) || words.some((w) => nm.includes(w)));
        const P = S.paid?.[c]; const base = { c, name: name || P?.name || '', sym, self, tracked: !!P };
        if (P) { base.prog = Math.round((P.progress || 0) * 100); base.ag = P.agents || 0; base.why = String(P.lastReason || '').slice(0, 80); base.no = /不打|騙|貔貅|大量部署|黑名單|不是 Agent/.test(base.why); }
        if (isTok) return { ...base, kind: 'token' };
        quick.push({ ...base, kind: 'checking' }); W_({ ...out, found: quick.slice(), partial: 1 });
        const ff = await Promise.race([(async () => findFree(WALLETS[0]?.addr || '0x000000000000000000000000000000000000dEaD', c, await fullCode(c, code).catch(() => code)))().catch(() => null), new Promise((ok) => setTimeout(() => ok('slow'), 8000))]); /* 她 11/2 03:29「很慢」：模拟最多等 8 秒 */
        if (ff === 'slow') return { ...base, kind: P ? 'paid' : 'other', why: base.why || '模拟超过 8 秒没结果：可能要付费或需要特定条件，按强制打时工具会再试' };
        if (!ff) return { ...base, kind: P ? 'paid' : 'other', why: base.why || (P ? '' : '模拟没找到免费／小额的铸造方式：可能是付费项目、还没开放、已铸完，或根本不是铸造合约') };
        const fee = Number(ff.v || 0n) / 1e18; return { ...base, kind: 'mint', fee, feeUsd: fee ? Math.round(fee * ((await bnbUsd().catch(() => 0)) || 700) * 100) / 100 : 0 };
      } catch (e) { return { c, kind: 'other', why: '读取失败：' + e.message.slice(0, 60) }; } }));
      out.found.sort((a, b) => (b.self - a.self) || ((b.kind === 'mint') - (a.kind === 'mint')));
      W_(out); log(`雷达搜寻 ${q}：${out.found.length} 个合约`); })().catch((e) => log('雷达搜寻出错 ' + e.message)); continue; }
    const c = String(o.c || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c) || Date.now() - (o.at || 0) > 5 * 60e3) continue; /* 超过 5 分钟的旧单不执行 */
    if (o.type === 'track') { S.paid = S.paid || {}; if (!S.paid[c]) { S.paid[c] = { at: Date.now(), name: String(o.name || '').slice(0, 40) || '搜寻项目', done: {}, fromUrl: 'search', needLearn: 1 }; save(); log(`雷达搜寻：${c} 加入追踪（照一般规则）`); } continue; }
    if (o.type === 'analyze' || o.type === 'mintHist') { (async () => { const isRh = Number(o.chain) === 4663; let r;
        try { if (o.type === 'analyze') r = isRh ? (RH ? await RH.analyze(c, null, true) : { ok: false, why: 'Robinhood 模组没载入' }) : (BA ? await Promise.race([BA.analyze(c, o.pool), new Promise((ok) => setTimeout(() => ok({ ok: false, why: '查超过 40 秒（交易太多），稍后再试' }), 40e3))]) : { ok: false, why: '模组没载入' });
          else r = BA ? await BA.mintTimeline(c) : { pts: [] }; } catch (e) { r = { ok: false, why: e.message.slice(0, 80) }; }
        const f = r?.facts ? { bundlePct: r.facts.bundlePct, top10: r.facts.top10, realBuyers: r.facts.realBuyers, devPct: r.facts.devPct ?? null } : null;
        writeFileSync(join(DIR, 'data', o.type === 'analyze' ? 'radar_analyze.json' : 'radar_minthist.json'), JSON.stringify({ c, at: Date.now(), chain: isRh ? 4663 : 56, ok: r?.ok !== false, why: r?.why || '', facts: f, pts: r?.pts || null, nft: r?.nft || false })); })().catch(() => {}); continue; } /* 详情页用：深度检查、铸造走势（只读） */
    if (o.type === 'nftmint' && BN) { await tgSay('🖥 雷达手动铸造 BSC NFT ' + (o.name || c) + '：预演中…').catch(() => {}); const r = await BN.manualMint(c, o.usd).catch((e) => '⚠️ ' + e.message); log('雷达手动铸造 BSC NFT ' + (o.name || c) + '：' + r); continue; }
    if (o.chain && Number(o.chain) !== 56) { if (Number(o.chain) === 4663 && o.type === 'previewMint' && RH) { const r = await RH.previewMint(c).catch((e) => ({ err: e.message })); writeFileSync(join(DIR, 'data', 'rh_preview.json'), JSON.stringify(r, null, 1)); continue; } if (Number(o.chain) === 4663 && o.type === 'mint' && RH) { await tgSay('🖥 雷达手动铸造 Robinhood ' + (o.name || c) + '：预演中…').catch(() => {}); const r = await RH.manualMint(c, o.usd).catch((e) => '⚠️ ' + e.message); log('雷达手动铸造 Robinhood ' + (o.name || c) + '：' + r); continue; } if (Number(o.chain) === 4663 && o.type === 'sell' && RH) { const r = await RH.manualSell(c, o.pct, o.w).catch((e) => '⚠️ ' + e.message); log('雷达手动卖 Robinhood ' + (o.name || c) + '：' + r); await tgSay('🖥 Robinhood 卖 ' + (Number(o.pct) || 100) + '% ' + (o.name || c) + '\n' + r).catch(() => {}); continue; } if (Number(o.chain) === 4663 && o.type === 'buy' && RH) { await tgSay('🖥 雷达手动买 Robinhood ' + (o.name || c) + '：检查中…').catch(() => {}); const r = await RH.manualBuy(c, Number(o.usd) || 0).catch((e) => '⚠️ ' + e.message); log('雷达手动买 Robinhood ' + (o.name || c) + '：' + r); await tgSay('🖥 Robinhood ' + (o.name || c) + '\n' + r).catch(() => {}); } continue; } /* 别条链的合约绝不拿到 BSC 买 */
    if (o.type === 'mint') { if (!S.paid?.[c] && o.src === 'search') { S.paid = S.paid || {}; S.paid[c] = { at: Date.now(), name: String(o.name || '搜寻项目').slice(0, 40), done: {}, fromUrl: 'search', needLearn: 1 }; } if (!S.paid?.[c]) { await tgSay(`🖥 雷达强制打 ${o.name || c}：工具里没有这个铸造项目，没执行`).catch(() => {}); continue; } if (S.forceDone) delete S.forceDone[c]; FORCE.add(c); S.forceAdd = [...new Set([...(S.forceAdd || []), c])]; if (Number(o.usd) > 0) { S.forceUsd = S.forceUsd || {}; S.forceUsd[c] = Number(o.usd); } save(); log(`雷达强制打 ${o.name || c}：加入指定要打名单`); await tgSay(`🖥 雷达强制打 ${o.name || c}：马上执行（这次最多付 ${capOf(c)}U；跳过防钓鱼门槛，只查会不会被盗）`).catch(() => {}); if (S.paid?.[c]) delete S.paid[c].unmintable; paidLoop('one', c).catch((e) => log('强制打 ' + e.message)); continue; } /* 她 11/2 02:48：强制打常常是快没了，不能等下一轮 */
    if (o.type === 'buy') { const r = await tgBuy(c, Number(o.usd) || 10, { pay: o.pay, w: o.w }).catch((e) => '⚠️ 下单出错：' + e.message); log(`雷达手动买 ${o.name || c}：${r}`); await tgSay(`🖥 雷达手动买 ${o.name || c}\n${r}`).catch(() => {}); }
    else if (o.type === 'sell') { let any = false, gone = 0; for (const t of (S.dyn || []).filter((x) => x.addr === c && !x.closed && (!o.w || x.only === String(o.w).toLowerCase()))) { const W = t.only ? WALLETS.find((w) => w.addr === t.only) : WALLETS[0]; if (!W) { await tgSay(`🖥 ${t.sym}：买它的钱包已经从雷达删除，雷达没办法帮它卖，请到那个钱包自己卖`).catch(() => {}); continue; } const bal = big(await call(c, '0x70a08231' + wa(W.addr))); if (bal <= 0n) { t.closed = Date.now(); gone++; continue; } any = true; const amt = (bal * BigInt(Math.min(100, Math.max(1, Number(o.pct) || 100)))) / 100n; const k = Object.keys(S.tokens || {}).find((x) => x === t.sym || x.endsWith(':' + t.sym)); globalThis.LAST_SELL_ERR = ''; const ok = CURVES[c] ? await curveSell(c, W, amt).catch((e) => (log('曲线卖出错 ' + e.message), false)) : await sell(t, S.tokens?.[k] || {}, amt, '指示：雷达手动卖', W).catch((e) => (log('雷达卖出错 ' + e.message), false)); if (ok && CURVES[c] && Number(o.pct || 100) >= 100) t.closed = Date.now(); log(`雷达手动卖 ${t.sym} ${Number(o.pct) || 100}%：${ok ? '成功' : '没卖成'}`); await tgSay(`🖥 雷达手动卖 ${t.sym} ${Number(o.pct) || 100}%（[${W.name}]）：${ok ? '✅ 已送出' : '❌ 没卖成：' + sellWhy(globalThis.LAST_SELL_ERR)}`).catch(() => {}); } if (!any) { save(); await tgSay(`🖥 雷达：${o.name || c} 钱包里已经没有了（之前就卖光了），已从持仓面板移除`).catch(() => {}); } }
  }
}
/* 她 11/2 04:39：「没卖成，看 log」看不懂 → 直接说原因 */
function sellWhy(m) { m = String(m || ''); if (/insufficient liquidity|liquidity/i.test(m)) return '池子里几乎没钱了，没人接得住，卖不出去。这种币基本归零，放着不管就好（不会再扣你钱）'; if (/honeypot|transfer|TRANSFER_FROM_FAILED/i.test(m)) return '这个币不让卖（可能是貔貅或被限制转帐）'; if (/gas|insufficient funds|balance/i.test(m)) return '钱包的 BNB 不够付手续费，先转一点 BNB 进来'; if (/slippage|price impact/i.test(m)) return '价格跳太大（滑点），等一下再试或少卖一点'; return m ? '交易所回：' + m.slice(0, 120) : '没有拿到原因，等一下再试一次'; }

/* 💡 用户反馈收件（11/2，只有 Nancy 的个人版会跑：要有 .sign/referral_bot.json）：用户私讯 @RobinCatRadar_bot → 存进 data/feedback.jsonl，雷达「更多 → 反馈收件箱」看；
   她 11/2 03:13「不要一直通知我」→ 不即时通知，每天 21:00 有新反馈才发一则摘要 */
const FB_CFG = (() => { try { return JSON.parse(readFileSync(join(DIR, '.sign', 'referral_bot.json'), 'utf8')); } catch { return null; } })();
if (FB_CFG?.token) { const FBF = join(DIR, 'data', 'feedback.jsonl'); const api = (m, b) => fetch(`https://api.telegram.org/bot${FB_CFG.token}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}), signal: AbortSignal.timeout(35000) }).then((r) => r.json());
  let fbBusy = false; const fbPoll = async () => { if (fbBusy) return; fbBusy = true; try { const j = await api('getUpdates', { offset: (S.fbOff || 0) + 1, timeout: 25, allowed_updates: ['message'] });
    for (const u of j.result || []) { S.fbOff = u.update_id; const m = u.message; if (!m?.from || m.chat?.type !== 'private') continue; const txt = String(m.text || m.caption || '').trim();
      if (!txt || /^\/start\b/.test(txt)) { await api('sendMessage', { chat_id: m.chat.id, text: '👋 这里是罗宾猫雷达的反馈信箱。\n直接把你想要的功能、遇到的问题打出来送出就好（在雷达按「💡 反馈」会帮你整理好格式）。\nNancy 会看过每一则，好的建议会做进下一个官方版本。' }).catch(() => {}); continue; }
      const k = new Date().toDateString(); S.fbDay = S.fbDay?.k === k ? S.fbDay : { k, n: {} }; const n = (S.fbDay.n[m.from.id] || 0) + 1; S.fbDay.n[m.from.id] = n; if (n > 10) continue; /* 同一人一天最多收 10 则，防灌爆 */
      appendFileSync(FBF, JSON.stringify({ id: u.update_id, at: (m.date || 0) * 1000 || Date.now(), uid: m.from.id, user: m.from.username || '', name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').slice(0, 40), text: txt.slice(0, 3000) }) + '\n');
      await api('sendMessage', { chat_id: m.chat.id, text: n === 10 ? '✅ 收到了，谢谢！（今天已经收满 10 则，明天再来～）' : '✅ 收到了，谢谢你的反馈！Nancy 会看。' }).catch(() => {}); }
    if (j.ok === false && Date.now() - (globalThis._fbErrAt || 0) > 3600e3) { globalThis._fbErrAt = Date.now(); log('反馈机器人收不到讯息：' + String(j.description || '').slice(0, 120)); }
    if ((j.result || []).length) save(); } catch (e) { if (Date.now() - (globalThis._fbErrAt || 0) > 3600e3) { globalThis._fbErrAt = Date.now(); log('反馈机器人出错：' + e.message.slice(0, 100)); } } finally { fbBusy = false; } };
  setInterval(fbPoll, 30e3).unref(); setTimeout(fbPoll, 10e3);
  setInterval(() => { const d = new Date(); if (d.getHours() !== 21 || S.fbDigest === d.toDateString()) return; S.fbDigest = d.toDateString(); save(); try { const all = readFileSync(FBF, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); const nw = all.filter((x) => x.at > (S.fbSeen || 0)); S.fbSeen = Date.now(); save(); if (!nw.length) return;
    tgSay(`💡 今天收到 ${nw.length} 则用户反馈（${[...new Set(nw.map((x) => x.uid))].length} 个人）\n${nw.slice(0, 5).map((x) => '• ' + x.text.replace(/\s+/g, ' ').slice(0, 60)).join('\n')}${nw.length > 5 ? '\n…' : ''}\n全部在雷达「更多 → 反馈收件箱」`).catch(() => {}); } catch {} }, 5 * 60e3).unref(); }
let roBusy = false; setInterval(() => { if (roBusy) return; roBusy = true; radarOrders().catch((e) => log('radarOrders ' + e.message)).finally(() => { roBusy = false; }); }, 800).unref(); /* 11/2：雷达按钮 1 秒内反应（以前最多等 5 秒） */
const holdClean = async () => { try { let n = 0; for (const t of S.dyn || []) { if (t.closed || Date.now() - (t.boughtAt || 0) < 30 * 60e3) continue; const W = WALLETS.find((w) => w.addr === t.only); if (!W) continue; const b = big(await call(t.addr, '0x70a08231' + wa(W.addr))); if (b <= 0n) { t.closed = Date.now(); n++; } } if (n) { save(); log(`持仓面板：${n} 个已经卖光的币移除`); } } catch {} }; setInterval(holdClean, 10 * 60e3).unref(); setTimeout(holdClean, 30e3); /* 已经卖光的不要再显示在面板、也不要再叫用户卖 */
/* 罗宾猫雷达 11/2：玩家自订「不打」规则 = 填表式（data/radar_settings.json 的 rules），只能填条件、不能写程式 → 别人分享的规则不可能藏恶意程式 */
const RULE_FIELDS = { name: 's', liqUsd: 'n', liqBnb: 'n', agents: 'n', progress: 'n', buyTax: 'n', sellTax: 'n', realBuyers: 'n', bundlePct: 'n', top10Pct: 'n' };
globalThis.CUSTOM_SKIP = (info) => { const rules = Array.isArray(radarSet().rules) ? radarSet().rules.slice(0, 50) : [];
  for (const r of rules) { try { if (!r || r.off || !RULE_FIELDS[r.field]) continue; if (r.chain && r.chain !== 'all' && r.chain !== info.chain) continue;
    const v = r.field === 'name' ? `${info.name || ''} ${info.sym || ''}`.toLowerCase() : r.field === 'progress' ? (info.progress != null ? info.progress * 100 : null) : info[r.field];
    if (v == null) continue; const want = RULE_FIELDS[r.field] === 's' ? String(r.value || '').toLowerCase().trim() : Number(r.value); if (RULE_FIELDS[r.field] === 's' ? !want : !Number.isFinite(want)) continue;
    const hit = r.op === 'contains' ? String(v).includes(want) : r.op === '<' ? Number(v) < want : r.op === '>' ? Number(v) > want : false;
    if (hit) return `${r.field} ${r.op} ${r.value}${r.note ? '（' + String(r.note).slice(0, 40) + '）' : ''}`; } catch {} } return ''; };
/* 罗宾猫雷达 11/2：钱包连接（真的，不是示意）：雷达写 data/radar_login_req.json → 这里跑币安钱包登入，二维码网址写到 data/radar_login.json 给雷达显示 */
let _loginBusy = false;
async function radarWalletPoll(force) { try { const out = []; for (const W of WALLETS) { const r = await W.baw(['wallet', 'status'], 60000); out.push({ name: W.name, addr: W.addr, status: r.j?.data?.status || 'UNKNOWN' }); } writeFileSync(join(DIR, 'data', 'radar_wallets.json'), JSON.stringify({ at: Date.now(), list: out })); } catch (e) { log('radarWalletPoll ' + e.message); } }
setInterval(async () => { const q = join(DIR, 'data', 'radar_login_req.json'); if (_loginBusy || !existsSync(q)) return; let req = {}; try { req = JSON.parse(readFileSync(q, 'utf8')); } catch {} try { unlinkSync(q); } catch {} if (Date.now() - (req.at || 0) > 120e3) return;
  const W = WALLETS[Math.max(0, Math.min(WALLETS.length - 1, Number(req.i) || 0))]; const out = join(DIR, 'data', 'radar_login.json'); _loginBusy = true;
  try { writeFileSync(out, JSON.stringify({ state: 'wait', wallet: W.name, at: Date.now() }));
    const si = await W.baw(['auth', 'signin'], 60000); const url = si.j?.data?.urlForWeb, code = si.j?.data?.pairingCode, id = si.j?.data?.qrCodeId;
    if (!id || !/^https:\/\/app\.binance\.com\//.test(String(url))) { writeFileSync(out, JSON.stringify({ state: 'fail', wallet: W.name, why: String(si.j?.error?.message || si.t).slice(0, 120), at: Date.now() })); return; } /* 只认币安官方网址 */
    writeFileSync(out, JSON.stringify({ state: 'qr', wallet: W.name, url, code, expire: Number(si.j?.data?.expireAt) || Date.now() + 300e3, at: Date.now() }));
    const v = await W.baw(['auth', 'verify', '--qrCodeId', id], 330000); const ok = v.j?.data?.status === 'SUCCESS';
    writeFileSync(out, JSON.stringify({ state: ok ? 'ok' : 'fail', wallet: W.name, why: ok ? '' : String(v.j?.data?.status || v.j?.error?.message || '').slice(0, 80), at: Date.now() })); if (ok) await tg(`✅ ${W.name} 在雷达连接成功`).catch(() => {});
  } catch (e) { writeFileSync(out, JSON.stringify({ state: 'fail', wallet: W.name, why: e.message.slice(0, 80), at: Date.now() })); } finally { _loginBusy = false; radarWalletPoll(); } }, 3e3).unref();
const PAY_TOK = { BNB: NATIVE_BNB, USDT, USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' };
async function radarBalPoll() { try { const bp = await bnbUsd().catch(() => 0); const ep = RH?.ethUsd ? await RH.ethUsd().catch(() => 0) : 0; const w = [];
  for (const W of WALLETS) { const b = { name: W.name, addr: W.addr, bsc: {}, rh: {} }; b.bsc.BNB = Number(big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0'))) / 1e18; for (const k of ['USDT', 'USDC']) b.bsc[k] = Number(big(await call(PAY_TOK[k], '0x70a08231' + wa(W.addr)).catch(() => '0x0'))) / 1e18; if (RH?.ethBal) b.rh.ETH = await RH.ethBal(W.addr).catch(() => null); w.push(b); }
  S.curveVal = S.curveVal || {}; for (const t of (S.dyn || []).filter((x) => !x.closed && CURVES[x.addr])) { try { const W = WALLETS.find((x) => x.addr === t.only); if (!W) continue; const bal = big(await call(t.addr, '0x70a08231' + wa(W.addr))); S.curveVal[t.addr + ':' + t.only] = bal > 0n ? (Number(await curveQuote(t.addr, W, bal)) / 1e18) * bp : 0; } catch {} } /* 曲线上的币：用曲线报价算现值 */
  writeFileSync(join(DIR, 'data', 'radar_bal.json'), JSON.stringify({ at: Date.now(), bnbUsd: bp, ethUsd: ep, w, caps: { bscMint: PAID.maxUsd, bscTok: AGTOK.usd, rh: RH?.RHC?.usd ?? null, rhMint: RH?.RHC?.mintUsd ?? null, gasBnb: PAID.keepBnb } })); /* 每笔金额：给「钱包总览」算还够打几笔 */
  if (RH?.RHC && !radarOff() && ((RH.RHC.usd > 0) || RH.RHC.mintAuto) && ep > 0) { const low = w.filter((b) => b.rh.ETH != null && b.rh.ETH * ep < Math.max(RH.RHC.usd || 0, RH.RHC.mintUsd || 0) + 1); S.rhLowAt = S.rhLowAt || 0;
    if (low.length && Date.now() - S.rhLowAt > 12 * 3600e3) { S.rhLowAt = Date.now(); save(); tgSay(`⚠️ Robinhood 自动打是开着的，但这些钱包在 Robinhood 链上的 ETH 不够打一笔：\n${low.map((b) => `[${b.name}] ${b.rh.ETH.toFixed(5)} ETH（约 ${(b.rh.ETH * ep).toFixed(1)}U）`).join('\n')}\n雷达没办法帮你跨链。👉 请叫你的 AI 把 BNB 跨链换成 Robinhood 链（4663）上的 ETH，或到「设定」关掉 Robinhood 自动打。`).catch(() => {}); } } } catch (e) { log('radarBalPoll ' + e.message); } }
setInterval(radarBalPoll, 60e3).unref(); setTimeout(radarBalPoll, 8e3); /* 雷达下单视窗显示每个钱包的余额，不够就提醒 */
setInterval(() => radarWalletPoll(), 300e3).unref(); setTimeout(() => radarWalletPoll(), 20e3);
for (const c of S.forceAdd || []) FORCE.add(c); /* 雷达按的「强制打」重开后还在 */
let RH = null; try { const { startRH } = await import('./rh.mjs?v=' + Date.now()); RH = startRH({ WALLETS, log, tg, S, save, radarOff }); globalThis.RH_APPLY = RH.apply; RADAR.at = 0; radarSet(); } catch (e) { log('Robinhood 模組載入失敗 ' + e.message); } /* 11/2：Robinhood Chain 自動打 */
let BA = null; try { const { makeBscAnalyze } = await import('./bscanal.mjs?v=' + Date.now()); BA = makeBscAnalyze({ rpc, rpcBatch, log }); } catch (e) { log('BSC 深度检查模组载入失败 ' + e.message); } /* 11/2 她：BSC 也要捆绑检查 */
let BN = null; try { const { startBscNft } = await import('./bscnft.mjs?v=' + Date.now()); BN = startBscNft({ rpc, rpcBatch, WALLETS, log, tg, S, save, radarOff, radarSet, previewExec, bnbUsd }); } catch (e) { log('BSC NFT 载入失败 ' + e.message); } /* 11/2：BSC NFT 铸造 */
try { const { startSmart } = await import('./smart.mjs?v=' + Date.now()); startSmart({ rpc, log, tg, S, save, radarSet }); } catch (e) { log('聪明钱包载入失败 ' + e.message); } /* 11/2：聪明钱包监控，本地跑 */
try { const { startJournal } = await import('./journal.mjs?v=' + Date.now()); startJournal({ DIR, S, save, WALLETS, log, tg }); } catch (e) { log('交易日记载入失败 ' + e.message); } /* 11/2：交易日记，全部本地跑 */
try { const { startPlugins } = await import('./plugins.mjs?v=' + Date.now()); await startPlugins({ DIR, WALLETS, log, tg, S, save, radarOff, radarSet, rpc, walletBusy: () => INFLIGHT > 0, keepBnb: PAID.keepBnb }); } catch (e) { log('外挂载入器失败 ' + e.message); } /* 11/2：量化外挂（网格、定投…），要在雷达按允许才载入 */
async function tgBuy(ca, usd, opt = {}) { /* TG 指令「/打 合約 10U」：用第一個錢包透過幣安錢包買（曲線盤、已上池子都一樣） */
  ca = ca.toLowerCase(); usd = Number(usd) > 0 ? Number(usd) : 10; /* 金额由用户自己决定 */ const price = await bnbUsd().catch(() => 0); if (!(price > 0)) return '讀不到 BNB 價格，稍後再試';
  let hp = null; try { hp = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${ca}&chainID=56`, { signal: AbortSignal.timeout(15000) })).json(); } catch {} /* 11/2：手動買也先過貔貅／稅率檢查 */
  if (hp?.honeypotResult?.isHoneypot === true) return '❌ 擋下了：模擬賣出失敗，是貔貅（買了賣不掉）';
  const hbt = Number(hp?.simulationResult?.buyTax), hst = Number(hp?.simulationResult?.sellTax);
  if (hbt > AGTOK.maxTax || hst > AGTOK.maxTax) return `❌ 擋下了：稅太高（買 ${hbt}%／賣 ${hst}%，上限 ${AGTOK.maxTax}%）`;
  const hpWarn = hp?.simulationSuccess ? `\n🛡 貔貅檢查通過（買稅 ${hbt}%／賣稅 ${hst}%）` : '\n⚠️ 查不到貔貅檢查結果（可能還在曲線盤、沒上池子），照你的指示已買，風險自負';
  const W = WALLETS.find((x) => x.addr === String(opt.w || '').toLowerCase()) || WALLETS[0]; const pay = PAY_TOK[opt.pay] ? opt.pay : 'BNB'; /* 雷达 11/2：用户自己选钱包和用哪个币付 */
  const bnbHave = Number(big(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18; const have = pay === 'BNB' ? bnbHave : pay === 'USDT' ? Number(await usdtFree(W)) / 1e18 : Number(big(await call(PAY_TOK[pay], '0x70a08231' + wa(W.addr)))) / 1e18; /* USDT 扣掉外挂（网格／定投）今天要用的 */
  if (pay !== 'BNB' && bnbHave < 0.0015) return `❌ [${W.name}] BNB 只剩 ${bnbHave.toFixed(4)}，付不起手续费（gas）。用 ${pay} 买也要一点 BNB 当手续费，而且之后卖出也要。\n👉 请叫你的 AI 换约 2U 的 BNB 到这个钱包`; const need = pay === 'BNB' ? usd / price + (PAID.keepBnb || 0.002) : usd; /* BNB 付的话留一点当之后卖出的手续费 */
  if (have < need) return `❌ 余额不够：[${W.name}] 只有 ${have.toFixed(pay === 'BNB' ? 4 : 2)} ${pay}（约 ${(pay === 'BNB' ? have * price : have).toFixed(1)}U），这次要 ${pay === 'BNB' ? (usd / price).toFixed(4) + ' BNB＋手续费' : usd + ' ' + pay}。\n👉 请叫你的 AI 把钱包里的其他币换成 ${pay}，或在雷达改用别的币付`;
  const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', pay === 'BNB' ? (usd / price).toFixed(6) : usd.toFixed(4), '--fromToken', pay === 'BNB' ? NATIVE_BNB : PAY_TOK[pay], '--toToken', ca, '--slippage', '15']);
  if (!sw.j?.success) return '❌ 買入失敗：' + String(sw.j?.error?.message || sw.t).slice(0, 100);
  S.dyn = S.dyn || []; if (!S.dyn.some((x) => x.addr === ca && x.only === W.addr)) S.dyn.push({ sym: ca.slice(0, 8), addr: ca, cost: usd, only: W.addr, boughtAt: Date.now() }); save(); return `✅ [${W.name}] 已用 ${pay} 買入 ${usd}U，加入持倉監控` + hpWarn;
}
async function agTokScan() {
  if (radarOff() || Number(radarSet()['bsc.tokAuto']) === 0) return; /* 11/2：BSC 热门代币有自己的开关 */
  const now = Date.now(); S.agTok = S.agTok || {};
  const mintToks = new Set(Object.values(S.paid || {}).map((P) => P.tok).filter(Boolean)); for (const c of Object.keys(S.paid || {})) mintToks.add(c);
  const held = new Set((S.dyn || []).map((t) => String(t.addr).toLowerCase()));
  const cands = [];
  for (const [c, m] of AGH) { for (const [a, t] of m) if (now - t > AGTOK.winMin * 60e3) m.delete(a); if (!m.size) { AGH.delete(c); continue; } if (m.size >= AGTOK.need && !S.agTok[c] && !mintToks.has(c) && !held.has(c) && !(S.agTokChk?.[c] > now - 60e3)) cands.push([c, m]); }
  for (const [c, m] of cands.sort((a, b) => b[1].size - a[1].size).slice(0, 5)) {
    (S.agTokChk = S.agTokChk || {})[c] = now;
    const snd = [...m.keys()]; const unknown = snd.filter((a) => !agentCache.has(a)).slice(0, 400);
    if (unknown.length) { const res = await rpcBatch(unknown.map((a) => ({ method: 'eth_call', params: [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(a) }, 'latest'] }))); unknown.forEach((a, i) => { if (res[i] !== undefined) agentCache.set(a, !!res[i] && res[i].length >= 66 && BigInt(res[i].slice(0, 66)) > 0n); }); }
    const fresh = await newAgents().catch(() => new Set());
    const need = snd.filter((a) => agentCache.get(a) && !fresh.has(a) && !(NONCE.get(a)?.n >= 8) && !(now - (NONCE.get(a)?.t || 0) < 30 * 60e3)).slice(0, 400); if (need.length) { const res = await rpcBatch(need.map((a) => ({ method: 'eth_getTransactionCount', params: [a, 'latest'] }))); need.forEach((a, i) => { if (res[i] !== undefined) NONCE.set(a, { n: parseInt(res[i], 16) || 0, t: Date.now() }); }); }
    const ag = snd.filter((a) => agentCache.get(a) && !fresh.has(a) && (NONCE.get(a)?.n ?? 99) >= 8).length;
    if (ag < AGTOK.need) continue;
    const dec = await call(c, '0x313ce567'); if (!(dec && dec.length >= 66)) { S.agTok[c] = 'not-token'; continue; } /* 不是代幣（像鑄造合約、遊戲合約）不在這裡處理 */
    const sym = tokStr(await call(c, '0x95d89b41')) || c.slice(0, 8);
    const skip = (why, later) => { if (later && now - (S.agTokFirst?.[c] || now) < 2 * 3600e3) { (S.agTokFirst = S.agTokFirst || {})[c] = S.agTokFirst[c] || now; S.agTokChk[c] = now + 9 * 60e3; if (S.agTokWhy?.[c] !== why.slice(0, 6)) { (S.agTokWhy = S.agTokWhy || {})[c] = why.slice(0, 6); log(`AI 熱門代幣 ${sym}（${ag} 個 Agent ID 錢包／${AGTOK.winMin} 分鐘）先不打：${why}（10 分鐘後再查，最多 2 小時）`); } return; } S.agTok[c] = 'skip'; log(`AI 熱門代幣 ${sym}（${ag} 個 Agent ID 錢包／${AGTOK.winMin} 分鐘）不打：${why}`); };
    if (USD1 && c === String(USD1).toLowerCase()) { S.agTok[c] = 'stable'; continue; }
    { const head = parseInt(await rpc('eth_blockNumber', []), 16); const o = await rpc('eth_getCode', [c, '0x' + (head - 345600).toString(16)]).catch(() => null); if (o && o.length > 2) { S.agTok[c] = 'old'; log(`AI 熱門代幣 ${sym}：3 天前就存在的老幣，不打`); continue; } } /* 11/1 22:23：只打新項目，CAKE、BTCB 這種老幣很多 AI 在交易也不買 */
    const dep = await deployerOf(c).catch(() => ''); if (dep && (S.black?.[dep] || isRepeatDev(dep))) { skip('部署者在黑名單或大量部署'); continue; }
    const price = await bnbUsd().catch(() => 0); if (!(price > 0)) continue;
    const p = await findPair({ addr: c }).catch(() => null); if (!p) { skip('沒有池子（還在發射平台曲線上，或還沒開盤）', 1); continue; }
    let liqBnb = 0; if (!p.ds) { const rs = await call(p.pair, '0x0902f1ac'); const t0 = await call(p.pair, '0x0dfe1681'); if (rs && t0) { const r0 = BigInt('0x' + rs.slice(2, 66)), r1 = BigInt('0x' + rs.slice(66, 130)); const qIs0 = ('0x' + t0.slice(26)).toLowerCase() !== c; const qr = Number(qIs0 ? r0 : r1) / 1e18; const q = String(p.quote).toLowerCase(); liqBnb = q === WBNB ? qr : qr / price; } } else { const d = await dexScreener(c).catch(() => null); liqBnb = d?.liq ? d.liq / 2 / price : 0; }
    if (liqBnb < AGTOK.minLiqBnb) { skip(`池子太小（約 ${liqBnb.toFixed(1)} BNB，要 ${AGTOK.minLiqBnb} BNB 以上）`, 1); continue; }
    let hp = null; try { hp = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${c}&chainID=56`, { signal: AbortSignal.timeout(15000) })).json(); } catch {}
    const bt = Number(hp?.simulationResult?.buyTax), st = Number(hp?.simulationResult?.sellTax);
    if (!hp || hp.honeypotResult?.isHoneypot !== false || !hp.simulationSuccess || !(bt >= 0) || !(st >= 0)) { if (hp?.honeypotResult?.isHoneypot === true) skip('模擬賣出失敗，是貔貅'); else skip('貔貅檢查查不到結果', 1); continue; }
    if (bt > AGTOK.maxTax || st > AGTOK.maxTax) { skip(`稅太高（買 ${bt}%／賣 ${st}%，要 ${AGTOK.maxTax}% 以下）`); continue; }
    let AF = null; if (BA) { const A = await Promise.race([BA.analyze(c, p.pair).catch((e) => ({ ok: false, why: e.message })), new Promise((ok) => setTimeout(() => ok({ ok: false, why: '查太久' }), 45e3))]); if (!A?.ok) { skip('捆绑检查读不到（' + String(A?.why || '').slice(0, 40) + '），晚点再查', 1); continue; } AF = A.facts;
      if (AF.bundlePct > AGTOK.maxBundle) { skip(`捆绑钱包持有 ${(AF.bundlePct * 100).toFixed(1)}%（上限 ${(AGTOK.maxBundle * 100).toFixed(0)}%）`); continue; }
      if (AF.top10 > AGTOK.maxTop10) { skip(`前 10 大持有 ${(AF.top10 * 100).toFixed(0)}%（上限 ${(AGTOK.maxTop10 * 100).toFixed(0)}%）`); continue; }
      if (AF.realBuyers < AGTOK.minReal) { skip(`最近 1 小时真实买家只有 ${AF.realBuyers} 个（要 ${AGTOK.minReal} 个）`, 1); continue; } }
    { const cs = globalThis.CUSTOM_SKIP?.({ chain: 'bsc', type: 'token', c, sym: typeof sym !== 'undefined' ? sym : '', agents: ag, buyTax: bt, sellTax: st, liqBnb, bundlePct: AF ? AF.bundlePct * 100 : null, top10Pct: AF ? AF.top10 * 100 : null, realBuyers: AF ? AF.realBuyers : null }); if (cs) { skip('自订规则不打：' + cs); continue; } }
    S.agTok[c] = 'buy'; save();
    for (const W of WALLETS) {
      const left = Math.min(AGTOK.usd, AGTOK.dayUsd - tokDayUsd(W)); if (left < 3) { log(`[${W.name}] AI 熱門代幣今天額度用完（${AGTOK.dayUsd}U），${sym} 不打`); continue; }
      const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18; const bnb = left / price; if (bal - bnb < PAID.keepBnb) { log(`[${W.name}] BNB 不夠，${sym} 不打`); continue; }
      const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', bnb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', c, '--slippage', String(Math.min(25, Math.ceil(bt + st + 5)))]);
      if (!sw.j?.success) { log(`[${W.name}] AI 熱門代幣 ${sym} 買入失敗：${String(sw.j?.error?.message || sw.t).slice(0, 100)}`); continue; }
      S.tokUsd[W.name] = tokDayUsd(W) + left; S.dyn = S.dyn || []; if (!S.dyn.some((t) => t.addr === c && t.only === W.addr)) S.dyn.push({ sym, addr: c, cost: +left.toFixed(2), only: W.addr, boughtAt: Date.now() }); save();
      await tg(`🛒 [${W.name}] 自動打了 AI 熱門項目：${sym} | ${AGTOK.winMin} 分鐘內 ${ag} 個 Agent ID 錢包在互動 · 每個錢包 ${left.toFixed(1)}U · 稅 買 ${bt}%／賣 ${st}% · 池子約 ${liqBnb.toFixed(1)} BNB | ${c}`);
    }
  }
}
async function heatOf(c, P) { // 算熱度：最近約 2.5 小時有幾個不同的 Agent ID 錢包參與鑄造，其中最近 3 分鐘幾個
  const head = parseInt(await rpc('eth_blockNumber', []), 16); let tok = ''; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66).toLowerCase();
  const last = new Map(), txb = new Map(); const skip = new Set([c, tok, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
  const span = P.heatAt ? 6000 : 20000; // 第一次看約 2.5 小時，之後只看最近約 45 分鐘（累計數取最大值）
  for (let b = head - span; b <= head; b += 10000) {
    const q = [{ address: tok ? [c, tok] : c, fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 9999, head).toString(16) }]; const L = await rpc('eth_getLogs', q).catch(() => logsRpc(q).catch(() => [])); /* 除錯 11/1：預設節點限流時改用多節點，熱度（參與人數）才算得準 */
    for (const l of L || []) { if (!l.transactionHash) continue; const bn = parseInt(l.blockNumber, 16); if (!txb.has(l.transactionHash) || txb.get(l.transactionHash) < bn) txb.set(l.transactionHash, bn); }
  }
  /* 逆向防護 11/1：以前把鏈上紀錄裡出現的地址（包括「收到幣的人」）都算成參與者，項目方空投給 150 個 Agent ID 錢包就能灌熱度；改成只算「自己送出交易、付 gas 的錢包」 */
  const hashes = [...txb.entries()].sort((x, y) => y[1] - x[1]).slice(0, 800);
  if (hashes.length) { const txs = await rpcBatch(hashes.map(([h]) => ({ method: 'eth_getTransactionByHash', params: [h] }))); hashes.forEach(([h, bn], i) => { const a = String(txs[i]?.from || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || skip.has(a)) return; if (!last.has(a) || last.get(a) < bn) last.set(a, bn); }); }
  const unknown = [...last.keys()].filter((a) => !agentCache.has(a)).slice(0, 400);
  if (unknown.length) { const res = await rpcBatch(unknown.map((a) => ({ method: 'eth_call', params: [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(a) }, 'latest'] }))); unknown.forEach((a, i) => { if (res[i] !== undefined) agentCache.set(a, !!res[i] && res[i].length >= 66 && BigInt(res[i].slice(0, 66)) > 0n); }); }
  const fresh = await newAgents().catch(() => new Set()); /* v2.8.1 防小号凑数：刚注册（24 小时内）的不算；交易次数少于 8 笔的不算 */
  { const need = [...last.keys()].filter((a) => agentCache.get(a) && !fresh.has(a) && !(NONCE.get(a)?.n >= 8) && !(Date.now() - (NONCE.get(a)?.t || 0) < 30 * 60e3)).slice(0, 400); if (need.length) { const res = await rpcBatch(need.map((a) => ({ method: 'eth_getTransactionCount', params: [a, 'latest'] }))); need.forEach((a, i) => { if (res[i] !== undefined) NONCE.set(a, { n: parseInt(res[i], 16) || 0, t: Date.now() }); }); } }
  let agents = 0, burst = 0; for (const [a, bn] of last) if (agentCache.get(a) && !fresh.has(a) && (NONCE.get(a)?.n ?? 99) >= 8) { agents++; if (bn >= head - 400) burst++; }
  P.agents = Math.max(P.agents || 0, agents); P.burst = burst; P.heatAt = Date.now();
}
const hk = (P) => (P.heatAt || 0) + (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 ? 0 : 540e3);
async function heatWatch() { // 背景：替追蹤中的付費項目算熱度，看不懂的合約順便學別人的打法（不拖慢 15 秒的快速檢查）
  const sig = (c, P) => ((P.fromCall || P.fromUrl || grpN(c) >= 2) && !P.heatAt ? 1 : 0); /* 除錯 11/1（BAO AGENT）：頻道／群組／網址來的新項目優先算熱度 */
  const ents = Object.entries(S.paid || {}).filter(([c, P]) => !INFRA.has(c) && !P.unmintable && (P.progress || 0) < 0.999 && !WALLETS.every((W) => P.done?.[W.name]) && Date.now() - (P.at || 0) < 172800e3 /* v2.7.7：两天 */)
    .sort((a, b) => (sig(b[0], b[1]) - sig(a[0], a[1])) || ((b[1].needLearn && (b[1].progress || 0) >= 0.45) - (a[1].needLearn && (a[1].progress || 0) >= 0.45)) || (hk(a[1]) - hk(b[1])) || ((b[1].at || 0) - (a[1].at || 0))).slice(0, 8); // 快滿或很熱的約每分鐘更新，其他約 10 分鐘；快到門檻又還不會打的排最前面（除錯 11/1：BNBCAT 57% 一直排不到）
  for (const [c, P] of ents) {
    try {
      await heatOf(c, P).catch((e) => log('heat ' + c + ' ' + e.message)); /* 除錯 11/1：算熱度被節點限流時，學打法也跟著被跳過 → 分開處理 */
      if ((P.needLearn || (sig(c, P) || P.fromCall || P.fromUrl || grpN(c) >= 2) && !P.replay && !P.recvValue) && (!P.replay || Date.now() - (P.replay.learnedAt || 0) > 120e3) && (heatTier(P) >= 1 || (P.progress || 0) >= 0.2 || (P.agents || 0) >= 20 || P.fromCall || P.fromUrl || grpN(c) >= 2)) { /* 使用者 11/1 19:41：很熱門但認不出打法的，要自己去找別人怎麼打到的——頻道／群組／網址來的熱門項目一加入就馬上去學別人的鑄造交易 */ const lr = await learnReplay(c).catch(() => null); if (lr?.recv) { P.recvValue = lr.recv; P.recvSeen = lr.recvSeen; P.recvVals = lr.recvVals; P.replay = { hot: lr.hot, learnedAt: lr.learnedAt }; delete P.needLearn; log(`學到 ${P.name || c} 的打法：直接轉 ${Number(BigInt(lr.recv)) / 1e18} BNB 就鑄造（${lr.recvSeen} 筆）`); } else if (lr) P.replay = lr; }
    } catch (e) { log('heat ' + c + ' ' + e.message); }
  }
}
function freshDeadline(data) { /* 照抄的交易裡如果有「期限」（看起來像時間戳記的數字），換成 15 分鐘後，不然舊交易一定過期失敗（币安无忧 10/31） */
  const now = Math.floor(Date.now() / 1000); const ws = data.slice(10).match(/.{64}/g) || []; let ch = 0;
  const out = ws.map((x) => { const v = BigInt('0x' + x); if (v > BigInt(now - 30 * 86400) && v < BigInt(now + 30 * 86400)) { ch = 1; return (BigInt(now + 900)).toString(16).padStart(64, '0'); } return x; });
  return ch ? data.slice(0, 10) + out.join('') : data;
}
async function findCapSel(c, code, sold) { /* 從合約碼找無參數函式，回傳「像總量」的（大於已售、整百、≤1 千萬），優先 10000 */
  const hex = String(code || '').toLowerCase().replace(/^0x/, ''); const sels = new Set(); for (let i = 0; i < hex.length - 10; i += 2) if (hex.slice(i, i + 2) === '63') sels.add(hex.slice(i + 2, i + 10));
  const cand = []; for (const sel of [...sels].slice(0, 160)) { const r = await call(c, '0x' + sel); if (!r || r.length !== 66) continue; const v = Number(BigInt(r)); if (v > sold && v <= 1e7 && v % 100 === 0) cand.push([sel, v]); }
  if (!cand.length) return ''; cand.sort((x, y) => (y[1] === 10000) - (x[1] === 10000) || x[1] - y[1]); log(`找到 ${c} 的總量函式 0x${cand[0][0]} = ${cand[0][1]}`); return cand[0][0];
}
async function learnReplay(c) { // 學別人最近成功的鑄造：最常見的函式、要付多少 BNB／USDT、最近有幾個錢包在打
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const L = await logsRpc([{ address: c, fromBlock: '0x' + (head - 1500).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => rpc('eth_getLogs', [{ address: c, fromBlock: '0x' + (head - 1500).toString(16), toBlock: 'latest' }]).catch(() => [])); /* 除錯 11/1：預設節點查事件常被限流（limit exceeded）→ 學不到打法；改用多節點輪替 */
  const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-40);
  const all = (await Promise.all(hs.map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter((t) => t && t.to && t.to.toLowerCase() === c);
  const txs = all.filter((t) => t.input && t.input.length >= 10 && !badSel(t.input) && !t.input.toLowerCase().includes(t.from.slice(2).toLowerCase()));
  { /* 除錯 11/1：BNBCAT 這種「直接轉 BNB 就鑄造」的合約，別人的交易沒有呼叫資料，以前學不到 → 進度過 55% 也一直沒打。現在學「大家最常轉的金額」 */
    const plain = all.filter((t) => (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n);
    if (plain.length >= 3 && plain.length >= txs.length) { const vc = {}; for (const t of plain) { const v = BigInt(t.value).toString(); vc[v] = (vc[v] || 0) + 1; } const top = Object.entries(vc).sort((x, y) => y[1] - x[1])[0]; const hot = new Set(plain.filter((t) => parseInt(t.blockNumber, 16) >= head - 400).map((t) => t.from.toLowerCase())).size; return { recv: top[0], recvSeen: top[1], recvVals: Object.keys(vc), hot, learned: 1, learnedAt: Date.now() }; }
  }
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
async function paidLoop(mode = 'all', shard = null) {
  if (S.umReset !== 3) { S.umReset = 3; for (const P of Object.values(S.paid || {})) { if (P.unmintable) { delete P.unmintable; P.fail = 0; P.cf = 0; if (P.replay?.learned) delete P.replay; } } } // 新版一次性：之前標記打不了的重新試
  S.paid = S.paid || {}; S.dyn = S.dyn || []; S.paidSpend = S.paidSpend || {};
  if (S.missed && !S.missedClean1) { S.missedClean1 = 1; for (const [k, m] of Object.entries(S.missed)) if (String(m.why || '').includes('保本')) delete S.missed[k]; } /* 照規則不打的不算錯過 */
  if (S.progFixV !== 1) { S.progFixV = 1; for (const P of Object.values(S.paid || {})) if ((P.progress || 0) >= 0.999 && !P.progAt) { delete P.progress; delete P.swLog; } } /* 除錯 11/1（牛來）：舊的進度算法把它讀成 100%，被當成賣完、不再回頭看；進度算法修正後重新讀一次 */
  if (S.agentsV !== 3) { S.agentsV = 3; /* v2.8.1：排除小号后重新算 */ for (const P of Object.values(S.paid || {})) { delete P.agents; delete P.heatAt; } } /* 逆向防護 11/1：參與人數改成只算送出交易的錢包，舊的（可能被空投灌過的）數字清掉重算 */
  if (S.refundReset !== 1) { S.refundReset = 1; for (const P of Object.values(S.paid)) { delete P.refundOk; delete P.noRefundLog; } } /* 除錯 11/1：代理合約解析修正後，重新判斷一次有沒有退款機制 */
  const today = new Date().toDateString(); if (S.paidSpend.day !== today) S.paidSpend = { day: today };
  let price = 0;
  if (!S.forceDone) S.forceDone = { '0xc7d563a7bd5af3de83567a67058b3eb9f285149e': 1 }; // VARC 早上已經打完
  for (const c of FORCE) if (S.forceDone[c] && S.paid[c]) delete S.paid[c];
  for (const c of FORCE) if (!S.paid[c] && !S.forceDone[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; // 審查修正：手動指定的項目打完就不再加回來重打
  if (!S.migrated2) { S.migrated2 = 1; for (const c of Object.keys(S.seenMints || {})) { if (S.paid[c]) continue; const cd = await codeOf(c); if ((cd.includes('e38fd349') && cd.includes('68bce8cd')) || (cd.includes('725c4058') && cd.includes('94bf804d'))) { S.paid[c] = { at: Date.now(), name: '', done: {} }; log('補登付費追蹤 ' + c); } } }
  // 進度 ≥40% 的（快滿的）每輪都看，不跟其他一百多個排隊；其餘輪流，每輪補到 16 個
  const all = Object.entries(S.paid);
  
  const hotP = all.filter(([c, P]) => FORCE.has(c) || ((grpN(c) >= 2 || ((P.fromUrl || P.fromCall) && Date.now() - (P.at || 0) < 86400e3) || (P.progress || 0) >= 0.45 || /* 使用者 11/1 16:35：3 個以上 TG 群在討論的也放進每 15 秒的快速檢查 */ (fpCache.get(c)?.p || 0) >= 0.45 || (!(P.progress > 0) && Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 70)) && (P.progress || 0) < 0.999 && !P.unmintable && (FORCE.has(c) || !P.serialLog))).filter(([c, P]) => !WALLETS.every((W) => P.done[W.name])).sort((a, b) => (FORCE.has(b[0]) ? 1 : 0) - (FORCE.has(a[0]) ? 1 : 0) /* v2.7.7：forceMint 指定的项目永远排第一，不会被挤出 12 个名额 */ || (b[1].progress || 0) - (a[1].progress || 0) || (b[1].agents || 0) - (a[1].agents || 0)).slice(0, 12); /* 使用者 10/31 20:29：快速檢查只看快到門檻的（進度 ≥45%，或讀不到進度但已 70 個以上錢包），最多 12 個，避免越來越慢 */
  // 快速檢查（mode='hot'）每 15 秒只看快滿／很熱的；一般檢查（mode='rest'）另外在背景約每分鐘輪流看其他的，互不拖慢
  const rest = mode === 'hot' ? [] : all.filter((e) => !hotP.includes(e) && Date.now() - (e[1].at || 0) < 172800e3 /* v2.7.7：两天内的都轮 */).sort((a, b) => ((a[1].lastTry || 0) - (b[1].lastTry || 0)) || ((b[1].at || 0) - (a[1].at || 0))).slice(0, 16); /* 除錯 11/1（BAO AGENT）：追蹤名單 3000 多個，新加入的（頻道、網址）排在一堆從沒檢查過的舊項目後面，好幾小時都沒輪到；改成只輪三天內的、而且新的優先 */
  const ents = mode === 'one' ? all.filter((e) => e[0] === shard) : mode === 'rest' ? rest : mode === 'hot' ? (shard == null ? hotP : hotP.filter((e, i) => i % 3 === shard)) : hotP.concat(rest); /* 快速檢查分 3 組同時跑（審查修正：一個一個查要 1 分多鐘） */
  for (const [c, P] of ents) {
    if (INFRA.has(c)) { delete S.paid[c]; continue; } // Agent ID 登記合約本身不是項目（註冊 .ai 身份），不打
    if (busyP.has(c)) continue; busyP.add(c); const tE = Date.now();
    try {
    P.lastTry = Date.now(); if (WALLETS.every((W) => P.done[W.name])) { if (FORCE.has(c)) { S.forceDone = S.forceDone || {}; S.forceDone[c] = 1; } delete S.paid[c]; continue; }
    if (Date.now() - P.at > PAID.maxAgeH * 3600e3) { delete S.paid[c]; continue; }
    if (P.serialLog && !FORCE.has(c)) continue; /* v2.7.7：被「大量部署者」规则挡掉的不再重查（以前占掉九成快速检查名额，拖慢真正热门的项目）；规则本身不变 */
    const code = await codeOf(c);
    // 發現時還沒開的「免費」鑄造：之後每分鐘重試，一開就自動打
    const fcd = (P.progress || 0) >= GO_PCT - 0.02 || Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= 70 ? 20e3 : 120e3; /* 除錯 11/1：快到 60% 的免費項目改成 20 秒重試一次（之前固定 2 分鐘，0xa69adf 在這 2 分鐘內從 63% 賣完） */
    if (Date.now() - (P.freeTryAt || 0) > fcd && !((P.progress || 0) > 0 && P.progress < GO_PCT - 0.02 && Date.now() - (P.freeTryAt || 0) < 600e3)) { /* 優化 11/1：進度讀得到且還沒到 58% 的免費項目，不用每 2 分鐘模擬一次（一晚 850 次白跑、還害節點限流）；改成 10 分鐘看一次，快到門檻才密集重試 */ P.freeTryAt = Date.now(); for (const W of WALLETS) { if (P.done[W.name]) continue; { const ff = await findFree(W.addr, c, code); if (!ff || P.qAt?.[W.name] > Date.now() - (fcd - 5e3)) continue; P.qAt = P.qAt || {}; P.qAt[W.name] = Date.now(); queueMint(c, ff.n, W, ff.v); log(`[${W.name}] 之前還沒開的 ${P.name || c} 現在開了（免費），照規則檢查（免費只通知不自動打）`); } } }
    let kind = code.includes('e38fd349') && code.includes('68bce8cd') ? 'bnb' : code.includes('725c4058') && code.includes('94bf804d') ? 'usdt' : null;
    let unit = 0n; // 一般 NFT：mint(數量) 付「單價 × 數量」BNB（像 Sentient Syndicate 的 PRICE）
    if (!kind && code.includes('a0712d68')) for (const sel of ['8d859f3e', 'a035b1fe', '6817c76c', '13faede6', '817b1cd2']) { if (!code.includes(sel)) continue; const r = await cc(c, '0x' + sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { unit = BigInt(r.slice(0, 66)); kind = 'gen'; break; } }
    if (!kind && P.recvValue) kind = 'recv';
    if (P.replay && badSel(P.replay.data)) delete P.replay;
    if (!kind && P.replay?.data) kind = 'replay'; // 少見的鑄造函式：照別人的呼叫內容與金額打
    
    if (!kind || kind === 'replay') P.needLearn = 1; // 看不懂的合約：交給背景的熱度監測去學別人的打法，這裡不等
    if (!kind) continue;
    if (P.unmintable && P.unmintableAt && Date.now() - P.unmintableAt > 30 * 60e3 && (P.umN || 0) < 2) { P.umN = (P.umN || 0) + 1; delete P.unmintable; P.fail = 0; P.cf = 0; } // 30 分鐘後再試，最多再試 2 次（避免付 USDT 的項目每半小時換一次 USDT 又失敗）
    if (P.unmintable && !FORCE.has(c)) continue;
    let soldR = await call(c, kind === 'bnb' ? '0xa2309ff8' : kind === 'gen' ? '0x18160ddd' : '0x192fc516');
    if (!(soldR && soldR.length >= 66) && (kind === 'replay' || kind === 'recv')) { if (P.soldSel) soldR = await call(c, P.soldSel); else for (const sel of ['0x02c7e7af', '0xa2309ff8', '0x9106d7ba', '0xf4514d2e', '0x505e05fd', '0x3a98ef39']) { const r = await cc(c, sel, 60e3); if (r && r.length >= 66) { soldR = r; P.soldSel = sel; break; } } }
    const sold = soldR && soldR.length >= 66 ? Number(BigInt(soldR.slice(0, 66))) : null; if (sold != null) P._sold = sold;
    let cap = null; { const r = await cc(c, '0xa0e23ebd'); if (r && r.length >= 66 && sold != null) { const x = Number(BigInt(r.slice(0, 66))); if (x >= 1000 && x <= 1e7 && x % 100 === 0) cap = Math.max(x, sold); } } if (!cap) for (const sel of ['0xd8f93498', '0xcef6feda', '0x29b80536', '0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0x3a1d8d3a', '0xf1aee5a2', '0x85e3f997']) { const r = await cc(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && sold != null && x >= sold && x < 1e12) { cap = x; break; } } }
    if (!cap && sold != null && sold > 0) { /* 審查 11/1：bibiai 發射台的總量函式不在常見清單（a0e23ebd=10000）→ 讀不到進度 → 被當成「讀不到＋很多人打」在 4% 就可能買；改成自動從合約裡找「總量」函式並記住 */
      if (P.capSel === undefined) P.capSel = await findCapSel(c, code, sold).catch(() => '') || '';
      if (P.capSel) { const r = await cc(c, '0x' + P.capSel, 600e3); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x < 1e9) cap = Math.max(x, sold); } } /* 已售超過總量＝賣完（AID 賣到 10246／10000 時被讀成 0.23%） */
    }
    let tokAddr0 = ''; { const tr0 = await cc(c, '0xfc0c546a', 3600e3); if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tokAddr0 = '0x' + tr0.slice(26, 66); } if (tokAddr0) P.tok = tokAddr0.toLowerCase(); /* v2.8.3：记下铸造项目的代币，AI 热门代币不会去买它 */
    let progress = cap && sold != null ? sold / cap : 0, how = '已售／上限';
    if (!(progress > 0)) { const pr = await progressOf(c, code, tokAddr0); progress = pr.progress || 0; how = pr.how || ''; }
    /* 使用者 10/31 19:02：進度合理性檢查（币安人 把總量讀成 100 倍，進度 32% 被讀成 0.3%，別人打到我們沒打到）：讀到的進度很低、但已經很多人打 → 判定讀錯，改用庫存算法；還是不合理就當作讀不到，交給熱度規則 */
    if (progress > 0 && progress < 0.03 && !(how === '已售／上限' && cap && (kind === 'bnb' && cap === 10000 || ((P.agents || 0) >= 20 && cap / Math.max(P.agents || 1, 1) <= 1000))) /* 審查 11/1：總量跟參與人數相比合理（平均每人 ≤1000 份）就相信「已售／上限」，只有總量大到不合理（像幣安人讀大 100 倍）才判讀錯 */ /* 除錯 11/1：BNB 報價型固定 1 萬份就開池，「已售／1 萬」是準的；BNLAI 已售 201 份＝2% 被誤判成讀錯，當成讀不到＋很多人打就花了 14U */ && ((P.agents || 0) >= 50 || (sold || 0) >= 1000 || (HOT.get(c)?.from.size || 0) >= 15)) {
      const pr = await progressOf(c, code, tokAddr0).catch(() => ({}));
      if (pr.progress >= 0.03) { progress = pr.progress; how = pr.how || '庫存'; }
      else { if (!P.progBad) { P.progBad = 1; log(`進度看起來讀錯了：${c} 讀到 ${(progress * 100).toFixed(2)}% 但已有 ${P.agents || 0} 個代理人在打，改用熱度規則判斷`); } progress = 0; how = '讀不到（數字不合理）'; }
    }
    const prevProg = P.progress; P.progress = progress; P.progAt = Date.now();
    if (progress >= 0.95 && !P.noRefundLog && !P.serialLog && !String(P.lastReason || '').includes('保本') && !String(P.lastReason || '').includes('部署者') && !(await serialDev(c).catch(() => '')) && !WALLETS.some((W) => P.done[W.name] && !['pool-open', 'fail', 'unknown'].includes(P.done[W.name]))) { /* 照規則不打（沒有保本）的不算錯過 */ S.missed = S.missed || {}; if (!S.missed[c]) { S.missed[c] = { name: P.name || c.slice(0, 10), at: ts(), why: P.lastReason || (P.unmintable ? '打不了' : '還沒找到能打的方式') }; log(`錯過 ${c}（${S.missed[c].name}）：進度已 ${Math.round(progress * 100)}%，我們沒打到，原因：${S.missed[c].why}`); } } /* 讓自己更聰明：記下快賣完卻沒打到的項目和原因，每晚總結列出來，方便找出要補的漏洞 */
    if (progress >= 0.7 && progress <= 1 && (prevProg != null ? prevProg < 0.7 : Date.now() - P.at < 6 * 3600e3)) groupProgress(c, P.name, progress).catch(() => {});
    { const now = Date.now(); P.ph = (P.ph || []).filter((x) => now - x.t < 15 * 60e3); if (!P.ph.length || now - P.ph[P.ph.length - 1].t > 10e3) P.ph.push({ t: now, p: progress }); }
    price = price || (await bnbUsd());
    const forced = FORCE.has(c);
    
    const tier = heatTier(P), needPct = GO_PCT; /* 使用者 11/1 02:37：全部改回進度超過 60% 才打（付費還要有保本機制） */
    const crowdGo = !(progress > 0) && (P.agents || 0) >= AG_MIN; /* 審查 11/1：只算持有 Agent ID 的錢包（熱度名單含一般地址，可能被機器人灌） */ /* 使用者 10/31 19:45：讀不到進度 → 100 個以上錢包在打就打 */
    if (!forced && !((progress >= needPct && (P.agents || 0) >= AG_MIN) || crowdGo)) continue; /* 逆向檢查 11/1：以前這裡只看進度，進度夠但錢包數不到 150 時，會掉進下面的舊規則（看到 20 個錢包就打），150 個的規定被繞過 */
    if (!forced) { const sd = await serialDev(c); if (sd) { if (!P.serialLog) { P.serialLog = 1; P.lastReason = sd + '，照規則不打'; if (S.missed?.[c]) delete S.missed[c]; log(`跳過 ${P.name || c}：${sd}，照規則不打`); } continue; } }
    { /* 使用者 11/1 01:56：風險變大了——付費項目一定要有保本機制（打不滿可以退款），沒有就不打。看合約（含代理背後的實作）有沒有退款函式 */
      const paying = !(kind === 'replay' && !(BigInt(P.replay?.value || '0') > 0n) && !P.replay?.payTok);
      if (!forced && !paying && await othersPay(c).catch(() => 0)) { P.needLearn = 1; P.freePhase = 1; delete P.replay; continue; } /* 學到的是免費那份，但大家都在付費打 → 下輪重學付費的打法 */
      if (!forced && !paying) { await freeNotify(c, P.name, progress > 0 ? progress : null, P.agents).catch(() => {}); for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'free-notify'; continue; } /* 使用者 11/1 15:56：免費的只通知不自動打 */
      /* 使用者 11/1 17:54：保本（退款）不再是必要條件——最重要的是 100 個以上不同 Agent ID 錢包在打、進度過門檻；改成要有每個錢包上限 */
      if (!forced && paying && await isNft(c).catch(() => false)) { /* 使用者 11/1 18:36：NFT 要很嚴格 */ let why = ''; if (!(progress >= Math.max(GO_PCT, 0.7))) why = `NFT 進度要 70% 以上（現在 ${Math.round((progress || 0) * 100)}%）`; else if (!((P.agents || 0) >= Math.max(AG_MIN, 150))) why = `NFT 要 150 個以上 Agent ID 錢包在打（現在 ${P.agents || 0} 個）`; else if (!(await walletLimit(c, true))) why = 'NFT 一定要有「每個錢包上限」（只有每筆上限不算）'; else why = await nftStrict(c); if (why) { if (P.nftWhy !== why) { P.nftWhy = why; P.lastReason = why; log(`跳過 ${P.name || c}：${why}`); } continue; } P.isNftBuy = 1; }
      if (!forced && paying) { if (P.wlim == null) P.wlim = await walletLimit(c); if (!P.wlim) { if (!P.noLimLog) { P.noLimLog = 1; P.lastReason = '沒有每個錢包上限的規定，照規則不打'; log(`跳過 ${P.name || c}：合約沒有「每個錢包最多幾份」的規定，照規則不打`); } continue; } }

    }
    if (!forced) { /* v2.8.0 防定点钓鱼（项目方把总份额调很小，少数人就能把进度灌过门槛）：① 总盘要 ≥10 BNB ② 已售要 ≥500 份或已募 ≥5 BNB ③ 两个钱包合计不超过总盘 2% */
      let unitBnb = 0; try { if (kind === 'bnb') { const q = await cc(c, '0x68bce8cd' + w(1), 300e3); if (q && q.length >= 66) unitBnb = Number(BigInt(q.slice(0, 66))) / 1e18; } else if (kind === 'gen') unitBnb = Number(unit) / 1e18; else if (kind === 'replay' && P.replay?.value && !P.replay?.payTok) { const a1 = /^0x[0-9a-f]{8}([0-9a-f]{64})/i.exec(P.replay.data || ''); let u = a1 ? Number(BigInt('0x' + a1[1])) : 1; if (!(u >= 1 && u <= 1000)) u = 1; unitBnb = Number(BigInt(P.replay.value)) / 1e18 / u; } } catch {}
      const soldN = sold != null && sold < 1e9 ? sold : null, capN = cap != null && cap < 1e9 ? cap : null;
      let why = '';
      if (unitBnb > 0 && capN && capN * unitBnb < 10) why = `總盤太小（${capN} 份 × ${unitBnb.toFixed(4)} BNB ≈ ${(capN * unitBnb).toFixed(2)} BNB，要 10 BNB 以上），可能是定點釣魚`;
      else if (soldN != null && !(soldN >= 500 || (unitBnb > 0 && soldN * unitBnb >= 5))) why = `已售只有 ${soldN} 份${unitBnb > 0 ? '（約 ' + (soldN * unitBnb).toFixed(2) + ' BNB）' : ''}，要 500 份以上或已募 5 BNB 以上`;
      if (why) { if (P.fishWhy !== why.slice(0, 6)) { P.fishWhy = why.slice(0, 6); P.lastReason = why + '，先不打'; log(`跳過 ${P.name || c}：${why}，先不打（之後達標會再檢查）`); } continue; }
      P.maxOurBnb = unitBnb > 0 && capN ? (capN * unitBnb * 0.02) / WALLETS.length : 0;
    }
    const gate = forced || (progress >= GO_PCT && (P.agents || 0) >= AG_MIN) || crowdGo; /* 使用者 11/1 14:48：進度夠也要很多 Agent ID 錢包在打 */ /* 進度過 50%：之前的防釣魚規矩全部不看（只留貔貅類安全檢查：模擬、授權、資產、Flap） */
    if (gate && !forced) { const cs = globalThis.CUSTOM_SKIP?.({ chain: 'bsc', type: 'mint', c, name: P.name || '', progress, agents: P.agents || 0 }); if (cs) { if (P.customWhy !== cs) { P.customWhy = cs; P.lastReason = '自订规则不打：' + cs; log(`${P.name || c} 自订规则不打：${cs}`); } continue; } }
    if (gate && !forced && (radarOff() || Number(radarSet()['bsc.mintAuto']) === 0)) { if (!P.pauseLogged) { P.pauseLogged = 1; log(`${P.name || c} 符合条件，但雷达设成暂停／不自动打，所以不打`); } continue; } /* 罗宾猫雷达 11/1 */
    if (!forced && !P.goLogged) { P.goLogged = 1; globalThis.xCheck?.(c, P.name).catch(() => {}); ownerHeavy(c, P.name).catch(() => {}); log(`進場 ${c}：${progress >= GO_PCT ? '進度過 ' + Math.round(GO_PCT * 100) + '%' : '讀不到進度、' + AG_MIN + ' 個以上錢包在打'}（累計 ${P.agents || 0} 個代理人、3 分鐘 ${P.burst || 0} 個），進度 ${progress > 0 ? Math.round(progress * 100) + '%' : '讀不到'}`); }
    // 防釣魚：① 同款合約 24 小時內被部署 3 次以上（批量發盤）不打 ② 進度要是很多人打出來的（至少 20 個不同錢包），不是項目方自己刷的
    if (!forced) { const dep0 = P.deployer !== undefined ? P.deployer : await deployerOf(c); P.deployer = dep0; if (dep0 && S.black?.[dep0]) { if (!P.blackLogged) { P.blackLogged = 1; log(`跳過 ${c}：部署者 ${dep0} 在黑名單（${S.black[dep0].why}）`); } continue; } } /* 網友 AI 建議 11/1：黑名單不管門檻有沒有過都要查（以前門檻一過就跳過） */
    if (!gate) { const dep = P.deployer !== undefined ? P.deployer : await deployerOf(c); P.deployer = dep;
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
    if (!forced) { if (P.old == null) { /* 網友 AI 建議 11/1：老合約（兩天前就存在）不管門檻有沒有過都不打 */ const head = parseInt(await rpc('eth_blockNumber', []), 16); const o = await rpc('eth_getCode', [c, '0x' + (head - 400000).toString(16)]).catch(() => '0x'); P.old = !!o && o.length > 2; } if (P.old) { for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'old'; continue; } }
    // 已經開池交易的項目不再自動鑄造（鑄造≈用市價買，不划算）
    if (!forced && !(progress >= GO_PCT)) { const tk = tokAddr0 || c; if (await poolOpen(tk)) { if (!P.poolSkipLog) { P.poolSkipLog = 1; log(`跳過 ${c}：已經開池交易，讀不到進度時不在開池後鑄（之後讀到進度 ≥80% 仍會打）`); } continue; } } /* 審查 11/1：以前會直接標記完成並刪掉，讀錯一次就永遠不打 */
    if (!gate && isSerial(code)) { if (!P.serialLogged) { P.serialLogged = 1; log(`跳過 ${c}：同款合約 24 小時內部署 3 次以上，疑似批量發盤`); } continue; }
    if (!gate) { const need = Math.max(P.drain ? 40 : 20, P.needW || 0); const seen = Math.max(P.wallets || 0, HOT.get(c)?.from.size || 0, P.agents || 0); /* 熱度算到的 Agent ID 錢包數也算（USDT 鑄造、幣先鎖住的項目沒有轉帳紀錄可數） */ if (seen < need) { if (Date.now() - (P.wAt || 0) < 60e3) continue; P.wAt = Date.now(); const r = await rpc('eth_getLogs', [{ address: tokAddr0 || c, fromBlock: '0x' + (parseInt(await rpc('eth_blockNumber', []), 16) - 3000).toString(16), toBlock: 'latest', topics: [T_TRANSFER] }]).catch(() => []); const uniq = new Set((r || []).map((l) => l.topics[2])).size; P.wallets = Math.max(P.wallets || 0, uniq); if (uniq < need) continue; } } // 還沒到 80%（或讀不到進度）→ 先不打，之後每分鐘再看
    const limitUsd = Infinity;
    let tokAddr = ''; const tr = await cc(c, '0xfc0c546a', 3600e3); if (tr && tr.length >= 66) tokAddr = '0x' + tr.slice(26, 66);
    const sym = tokAddr ? tokStr(await cc(tokAddr, '0x95d89b41', 3600e3)) || P.name || c.slice(0, 8) : P.name || c.slice(0, 8);
    await Promise.all(WALLETS.map(async (W) => { 
      if (P.done[W.name]) return;
      if (!forced) { const rb = await riskBlock(W, c, 0n, '0x', false, true).catch(() => ''); if (rb) { if (P.riskLog !== rb) { P.riskLog = rb; log(`[${W.name}] 風控暫停 ${P.name || c}：${rb}`); } return; } }
      const budU = forced ? capOf(c) : Math.min(P.isNftBuy ? 10 : PAID.maxUsd, PAID.dayUsd - paidDayUsd(W), P.maxOurBnb > 0 && price > 0 ? P.maxOurBnb * price : 1e9); /* v2.8.0：合计不超过总盘 2% */ /* NFT 預算 10U */ if (budU < 1) { if (P.dayCapLog !== new Date().toDateString()) { P.dayCapLog = new Date().toDateString(); log(`[${W.name}] 今天付費已達 ${PAID.dayUsd}U 上限，${P.name || c} 不打`); } return; } /* 使用者 11/1 17:38：每日總上限 */
      try {
        price = price || (await bnbUsd());
        const spent = S.paidSpend[W.name] || 0;
        const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
        let n = 10, costWei = 0n;
        if (kind === 'replay' && P.replay.payTok) { // 付 USDT 的鑄造（像 BITO）：換 USDT → 授權 → 照別人的方式打，份數放大到預算內最多 10 份
          if (P.replay.payTok !== USDT) { if (!P.payTokLogged) { P.payTokLogged = 1; log(`跳過 ${c}：要付的代幣不是 USDT（${P.replay.payTok}）`); } return; }
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = { ...P.replay, ...lr }; }
          let data = freshDeadline(P.replay.data), need = BigInt(P.replay.payAmt || '0'); const ws = data.slice(10).match(/.{64}/g) || [];
          if (ws.length === 3 && need > 0n) { const n0 = BigInt('0x' + ws[0]), mx = BigInt('0x' + ws[2]); if (n0 > 0n && n0 <= 100n && mx >= need && mx <= (need * 12n) / 10n) { const unit = need / n0; let nn = 10n; while (nn > 1n && (Number(unit * nn) / 1e18) * 1.05 > budU) nn--; const mp = (unit * nn * 105n) / 100n; data = data.slice(0, 10) + w(nn) + ws[1] + w(mp); need = mp; } }
          if (!(need > 0n) || Number(need) / 1e18 > budU) return;
          let ub = (await usdtFree(W));
          if (ub < need) { const nb = ((Number(need - ub) / 1e18) * 1.04) / price; if (nb > bal - PAID.keepBnb) return; const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', nb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]); if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 100)); for (let i = 0; i < 30 && ub < need; i++) { await sleep(3000); ub = (await usdtFree(W)); } if (ub < need) throw new Error('USDT 沒到帳'); }
          await previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(need), 0n, (sim) => ((sim?.allowanceChanges || []).some((a) => String(a.spender).toLowerCase() !== c) ? '授權對象不對' : ''));
          const v = BigInt(P.replay.value || '0'); if (v > 0n && ((Number(v) / 1e18) * 1.005 > bal - PAID.keepBnb || Number(need) / 1e18 + (Number(v) / 1e18) * price > budU)) return; /* 審查修正：付 USDT 的同時若還要附 BNB，也要算進預算 */
          const r = await revokeOnFail(W, USDT, c, async () => { try { data = await safeAddrs(W, c, data, v); data = await fitShares(W, c, data, v); } catch (e) { if (/額度|quota|已打滿/.test(e.message)) P.done[W.name] = 'full'; else noteFail(c, P, sym, progress); throw e; } return previewExec(W, c, data, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.authorityChanges?.length) return '有權限變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => { const a = String(b.contractAddress).toLowerCase(); return a !== USDT && !a.startsWith('0xeeee'); })) return '會扣到 USDT/BNB 以外的資產';
            if (out.filter((b) => String(b.contractAddress).toLowerCase() === USDT).reduce((a, b) => a - Number(b.change), 0) > Number(need) * 1.01) return '扣的 USDT 超過預算'; return '';
          }); });
          const paidU = (r.sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress).toLowerCase() === USDT && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0) / 1e18; const usd = paidU > 0 ? paidU : Number(need) / 1e18; S.paidSpend[W.name] = spent + usd / price; P.done[W.name] = 'minted'; /* 記實際扣掉的 USDT */
          if (paidU > 0 && paidU < (Number(need) / 1e18) * 0.99) previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(0n), 0n, () => '').catch(() => {}); /* 授權沒用完就收回 */
          if (tokAddr && !S.dyn.some((t) => t.addr === tokAddr.toLowerCase() && t.only === W.addr)) S.dyn.push({ sym, addr: tokAddr.toLowerCase(), cost: +usd.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          addPaidUsd(W, usd);
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的方式，付 USDT）${grpTxt(c)}\n花約 ${usd.toFixed(2)} USDT · ${progress > 0 ? '進度約 ' + Math.round(progress * 100) + '%' : '最近 ' + (P.replay.hot || 0) + ' 個錢包在打'}\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'replay') {
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = { ...P.replay, ...lr }; } /* 用最新的別人交易（價格參數要新） */
          let v = BigInt(P.replay.value || '0'); let vb = Number(v) / 1e18;
          if (price && vb * price > budU && P.replay.data) { /* 審查 11/1：學到的金額超過 20U 時，第一個參數是份數就按比例降份數＋金額，不再直接放棄 */
            const w0 = P.replay.data.slice(10, 74); const n0 = w0.length === 64 ? Number(BigInt('0x' + w0)) : 0;
            if (n0 >= 2 && n0 <= 100) { const n1 = Math.floor((budU / (vb * price)) * n0); if (n1 >= 1) { v = (v * BigInt(n1)) / BigInt(n0); vb = Number(v) / 1e18; P.replay = { ...P.replay, data: P.replay.data.slice(0, 10) + n1.toString(16).padStart(64, '0') + P.replay.data.slice(74), value: v.toString() }; log(`照抄金額超過預算，份數 ${n0}→${n1}：${c}`); } }
          }
          if (!price || vb * price > budU || vb * 1.005 > bal - PAID.keepBnb) return;
          let rdata = freshDeadline(P.replay.data); try { rdata = await safeAddrs(W, c, rdata, v); const rd0 = rdata; rdata = await fitShares(W, c, rdata, v); v = scaleV(rd0, rdata, v); vb = Number(v) / 1e18; } catch (e) { if (/額度|quota|已打滿/.test(e?.message || '')) P.done[W.name] = 'full'; else noteFail(c, P, sym, progress); return; } /* 審查修正：付 BNB 的照抄也要換掉別人的地址、自動調份數 */
          { /* 使用者 10/31 19:16「用這種邏輯去優化」：照抄失敗時不馬上放棄——先換最新樣本再試，再試「價格上限 +2%」（只在交易內容裡有跟付款金額一樣的上限數字時） */
            const ok = async (d, val) => { try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x' + val.toString(16) }, 'latest']); return true; } catch { return false; } };
            let good = await ok(rdata, v); P._baseVb = vb; /* 加價前的金額：只有這部分算進每日總上限 */
            if (!good) { const lr = await learnReplay(c).catch(() => null); if (lr?.data) { P.replay = { ...P.replay, ...lr }; const v2 = BigInt(lr.value || '0'); let d2 = freshDeadline(lr.data); let v2s = v2; try { d2 = await safeAddrs(W, c, d2, v2); const dd = d2; d2 = await fitShares(W, c, d2, v2); v2s = scaleV(dd, d2, v2); } catch {} if ((Number(v2s) / 1e18) * price <= budU && (Number(v2s) / 1e18) * 1.005 <= bal - PAID.keepBnb && await ok(d2, v2s)) /* 審查 11/1：重新學到的金額也要在 20U 預算和餘額內 */ { rdata = d2; v = v2s; vb = Number(v) / 1e18; good = true; } } }
            if (!good && v > 0n) for (const pct of [102n, 105n, 110n, 120n]) { /* 使用者 11/1 17:54：跟單漲價最多加 20%；加價的部分不算進每日總上限 */ /* 網友 AI 建議 11/1：跟單漲價最多只加到 10% */ /* 除錯 11/1：AID 價格從 0.0204 漲到 0.022（+8%），舊的只試 +2% → 合約回 MAX_COST 打不了；改成 +2%～+35% 一路試，金額在 20U 預算與餘額內 */
              const vU = (v * pct) / 100n; if ((Number(vU) / 1e18) * price > capOf(c) || (Number(vU) / 1e18) * 1.005 > bal - PAID.keepBnb) break;
              const ws = rdata.slice(10).match(/.{64}/g) || []; let hit = 0; const d3 = rdata.slice(0, 10) + ws.map((x) => { const y = BigInt('0x' + x); if (y > 0n && y * 1000n >= v * 995n && y * 1000n <= v * 1005n) { hit = 1; return vU.toString(16).padStart(64, '0'); } return x; }).join('');
              if (await ok(hit ? d3 : rdata, vU)) { rdata = hit ? d3 : rdata; v = vU; vb = Number(v) / 1e18; good = true; log(`照抄時金額 +${pct - 100n}% 才過：${c}`); P.replay = { ...P.replay, data: rdata, value: v.toString() }; break; }
            }
            if (!good) { noteFail(c, P, sym, progress); return; } /* 審查 11/1：一次失敗就標打不了 → 改成累計 8 次 */
          }
          const r = await previewExec(W, c, rdata, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外或超過金額';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          if (!(v > 0n)) { trackFromSim(W, r.sim, sym, 0); noteFree(c, W, sym); return; }
          trackFromSim(W, r.sim, sym, vb * price); 
          addPaidUsd(W, Math.min(vb, P._baseVb || vb) * price); /* 使用者 11/1 17:54：跟單加價的部分不算進每日總上限 */
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}（照別人的鑄造方式）${grpTxt(c)}\n花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'recv') {
          let v = BigInt(P.recvValue);
          if (price && (Number(v) / 1e18) * price > budU) { /* 除錯 11/1：大家最常轉的金額超過 20U 預算（BNBCAT 10 份＝0.03 BNB≈21U）時，改用別人轉過、在預算內最大的金額，不再直接放棄 */
            const ok = (P.recvVals || []).map((x) => BigInt(x)).filter((x) => (Number(x) / 1e18) * price <= budU).sort((x, y) => (x > y ? -1 : 1)); if (ok.length) v = ok[0]; }
          const vb = Number(v) / 1e18;
          if (!price || vb * price > budU || vb * 1.005 > bal - PAID.keepBnb) return;
          try { await rpc('eth_call', [{ from: W.addr, to: c, value: '0x' + v.toString(16) }, 'latest']); } catch { noteFail(c, P, sym, progress); if ((P.cf || 0) >= 3) { delete P.recvValue; delete P.replay; P.needLearn = 1; } return; } /* 審查 11/1：轉 BNB 金額可能學錯，失敗幾次就重學 */ // 不能鑄（沒資格、已打過、額度滿）
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
          for (; n >= 1; n--) { costWei = unit * BigInt(n); if ((Number(costWei) / 1e18) * 1.005 > bal - PAID.keepBnb || !price || (Number(costWei) / 1e18) * price > budU) continue; data = '0xa0712d68' + w(n); try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + costWei.toString(16) }, 'latest']); break; } catch {} }
          if (n < 1) { noteFail(c, P, sym, progress); return; }
          const r = await previewExec(W, c, data, costWei, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 BNB 以外或超過價格';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          });
          const vb = Number(costWei) / 1e18; S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          trackFromSim(W, r.sim, sym, vb * price);
          addPaidUsd(W, (vb * price));
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}${grpTxt(c)}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${(vb * price).toFixed(1)}U）· 進度約 ${Math.round(progress * 100)}%（${sold ?? '?'}／${cap ?? '?'}）\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'bnb') {
          for (; n >= 1; n--) { const q = await call(c, '0x68bce8cd' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && (Number(costWei) / 1e18) * 1.005 <= bal - PAID.keepBnb && price && (Number(costWei) / 1e18) * 1.005 * price <= budU) break; } // 買得起的最多份數（留 gas）
          if (n < 1) { P.lastReason = '每份太貴，超過 20U 預算'; return; } // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
          const v = (costWei * 1005n) / 1000n, vb = Number(v) / 1e18;
          if (spent + vb > PAID.maxBnbPerDay || bal - vb < PAID.keepBnb) return;
          const data = '0xe38fd349' + w(n) + wa('0x0000000000000000000000000000000000000000') + w(v);
          try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + v.toString(16) }, 'latest']); } catch { noteFail(c, P, sym, progress); return; } // 還沒開或沒資格
          const pool = tokAddr ? Number(await poolOut(v, WBNB, tokAddr)) : 0;
          const r = await previewExec(W, c, data, v, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（新規則：進度 ≥80% 照打）`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.01) return '會扣到 BNB 以外的資產或超過報價';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          }, async () => { const q2 = await call(c, '0x68bce8cd' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return c2 > (costWei * 105n) / 100n ? '價格剛剛漲了超過 5%' : ''; }); /* 新功能：送出前再查一次價格 */
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          const usd = vb * price; const tka = tokAddr && !/^0x0{40}$/i.test(tokAddr) ? tokAddr : tokAddr0; if (!tka) trackFromSim(W, r.sim, sym, usd); /* 審查 11/1：合約沒有 token() 時以前不會加入持倉，賣出規則都不會跑 */ if (tka && !S.dyn.some((x) => x.addr === tka.toLowerCase() && x.only === W.addr)) S.dyn.push({ sym, addr: tka.toLowerCase(), cost: +usd.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now(), ...(FORCE.has(c) ? { hold: true } : {}) }); // 使用者指定的項目照免費幣處理：只通知不自動賣
          addPaidUsd(W, usd);
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}${grpTxt(c)}\n${n} 份，花 ${vb.toFixed(4)} BNB（約 ${usd.toFixed(1)}U）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：${ruleTxt()}`);
        } else {
          for (; n >= 1; n--) { const q = await call(c, '0x725c4058' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && price && ((Number(costWei) / 1e18) * 1.03) / price <= bal - PAID.keepBnb && Number(costWei) / 1e18 <= budU) break; }
          if (n < 1) { P.lastReason = '每份太貴，超過 20U 預算'; return; } // 太貴：先不打（進度到 85% 後上限會放寬到 25U，會再檢查）
          const cu = Number(costWei) / 1e18, needBnb = (cu * 1.03) / price;
          if (!price || spent + needBnb > PAID.maxBnbPerDay || bal - needBnb < PAID.keepBnb) return;
          const data = '0x94bf804d' + w(n) + wa('0x0000000000000000000000000000000000000000');
          let ub = (await usdtFree(W));
          if (ub < costWei) {
            const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', needBnb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]);
            if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 100));
            for (let i = 0; i < 30 && ub < costWei; i++) { await sleep(3000); ub = (await usdtFree(W)); }
            if (ub < costWei) throw new Error('USDT 沒到帳');
          }
          await previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(costWei), 0n, (sim) => ((sim?.allowanceChanges || []).some((a) => String(a.spender).toLowerCase() !== c) ? '授權對象不對' : ''));
          const pool = tokAddr ? Number(await poolOut(costWei, USDT, tokAddr)) : 0;
          const r = await revokeOnFail(W, USDT, c, () => previewExec(W, c, data, 0n, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已開池，鑄造沒有比池子便宜（新規則：進度 ≥80% 照打）`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => String(b.contractAddress).toLowerCase() !== USDT) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * 1.01) return '會扣到 USDT 以外或超過報價';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到代幣'; return '';
          }, async () => { const q2 = await call(c, '0x725c4058' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return c2 > (costWei * 105n) / 100n ? '價格剛剛漲了超過 5%' : ''; })); /* 新功能：送出前再查一次價格 */
          S.paidSpend[W.name] = spent + needBnb; P.done[W.name] = 'minted';
          const tku = tokAddr && !/^0x0{40}$/i.test(tokAddr) ? tokAddr : tokAddr0; if (!tku) trackFromSim(W, r.sim, sym, cu); if (tku && !S.dyn.some((x) => x.addr === tku.toLowerCase() && x.only === W.addr)) S.dyn.push({ sym, addr: tku.toLowerCase(), cost: +cu.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          addPaidUsd(W, cu);
          await tg(`🛒 [${W.name}] 自動打了付費 Agent ID 項目：${sym}${grpTxt(c)}\n${n} 份，花 ${cu.toFixed(2)} USDT（由 BNB 換）· 已售 ${sold ?? '?'} 份 · 進度約 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入監控：${ruleTxt()}`);
        }
      } catch (e) { if (e.message.includes('結果不明')) { P.done[W.name] = 'unknown'; log(`paid ${c} ${W.name} ${e.message}`); await tg(`⚠️ [${W.name}] ${sym} 送出結果不明（逾時），為避免重打已停止，請到錢包確認有沒有打到\n${c}`); return; } if (e.message.includes('已開池')) { P.done[W.name] = 'pool-cheaper'; log(`paid ${c} ${W.name} ${e.message}`); return; } if (/價格剛剛漲了/.test(e.message)) { log(`paid ${c} ${W.name} ${e.message}（下一輪再打）`); return; } P.failW = P.failW || {}; P.failW[W.name] = (P.failW[W.name] || 0) + 1; P.fail = (P.fail || 0) + 1; log(`paid ${c} ${W.name} ${e.message}`); if (kind === 'replay' && P.fail >= 6) { markUnmintable(c, P, sym, progress, '照別人的方式預演一直失敗'); return; } /* 審查 11/1：照抄型 2 次失敗就放棄太快、價格變動不算失敗、失敗按錢包算 */ if (P.failW[W.name] >= 6) { P.done[W.name] = 'fail'; await tg(`⚠️ [${W.name}] 付費項目 ${sym} 自動打失敗，已放棄：${e.message.slice(0, 150)}\n${c}`); } }
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
          const amt = J.pct ? (bal * BigInt(J.pct)) / 100n : bal; if (amt > 10n ** 16n) { const qty = (Number(amt / 10n ** 14n) / 1e4).toFixed(4); const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', J.swapBack, '--toToken', NATIVE_BNB, ...(J.slip ? ['--slippage', String(J.slip)] : [])]); out.push(sw.j?.success ? `已把 ${qty} 換回 BNB` : '換 BNB 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 80)); }
          return `[${W.name}] ${out.join('，') || '沒有需要處理的'}`;
        } catch (e) { return `[${W.name}] ❌ ${e.message.slice(0, 100)}`; }
      }
      if (J.usdt) { // USDT 型：BNB 換 USDT → 授權 → 鑄造（J.data 固定）
        try {
          const need = BigInt(Math.round(J.usdt * 1e6)) * 10n ** 12n; let ub = (await usdtFree(W));
          if (ub < need) { const px = await bnbUsd(); const nb = ((Number(need - ub) / 1e18) * 1.04) / px; const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', nb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]); if (!sw.j?.success) throw new Error('BNB 換 USDT 失敗 ' + (sw.j?.error?.message || sw.t).slice(0, 80)); for (let k = 0; k < 30 && ub < need; k++) { await sleep(3000); ub = (await usdtFree(W)); } if (ub < need) throw new Error('USDT 沒到帳'); }
          await previewExec(W, USDT, '0x095ea7b3' + wa(J.c) + w(need), 0n, (sim) => ((sim?.allowanceChanges || []).some((x) => String(x.spender).toLowerCase() !== J.c) ? '授權對象不對' : ''));
          const r = await revokeOnFail(W, USDT, J.c, () => previewExec(W, J.c, J.data, 0n, (sim) => { const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr); if (mine.some((b) => Number(b.change) < 0 && String(b.contractAddress).toLowerCase() !== USDT)) return '會扣到 USDT 以外的資產'; if (-mine.filter((b) => Number(b.change) < 0).reduce((x, b) => x + Number(b.change), 0) > Number(need) * 1.01) return '扣款超過預期'; return ''; }));
          ok = 1; S.paidSpend = S.paidSpend || {}; if (J.tok) { S.dyn = S.dyn || []; if (!S.dyn.some((t) => t.addr === J.tok && t.only === W.addr)) S.dyn.push({ sym: J.name || 'TOKEN', addr: J.tok, cost: J.usdt, only: W.addr, boughtAt: Date.now() }); }
          return `[${W.name}] ✅ 打到（花約 ${J.usdt}U）交易 ${r.tx}`;
        } catch (e) { return `[${W.name}] ❌ 沒打到（${e.message.slice(0, 100)}）`; }
      }
      for (let i = 0; i < (J.n || 1); i++) {
        const data = J.randArg ? J.sel + w(BigInt(Math.floor(Math.random() * 65536))) : J.data;
        try {
          const mr = await previewExec(W, J.c, data, BigInt(J.value || 0), (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授權變化';
            if (mine.some((b) => Number(b.change) < 0 && !String(b.contractAddress).toLowerCase().startsWith('0xeeee'))) return '會扣到其他資產';
            if (!mine.some((b) => Number(b.change) > 0)) return '模擬沒拿到東西'; return '';
          }, null, { manual: true });
          ok++; if (BigInt(J.value || 0) > 0n) trackFromSim(W, mr.sim, J.name, (Number(J.value) / 1e18) * ((await bnbUsd().catch(() => 0)) || 0));
        } catch (e) { err = e.message.slice(0, 80); break; }
      }
      if (ok) { S.nftCols = S.nftCols || {}; S.nftCols[J.c] = 1; S.freeTrack = S.freeTrack || {}; S.freeTrack[J.c] = S.freeTrack[J.c] || { at: Date.now() }; }
      return ok ? `[${W.name}] ✅ 打到 ${ok} 份${err ? '（已達這個項目每個錢包的上限）' : ''}` : `[${W.name}] ❌ 沒打到（${/reverted/.test(err) ? '合約不讓這個錢包打，可能已打過、名額滿或需要資格' : err}）`;
    }));
    log(`手動補打 ${J.name || J.c}：${res.join('；')}`);
    if (!(J.swapBack || J.approvals || J.revokeAll) && J.c) { /* v2.7.8：手动打成功的钱包记成「已打」，自动流程（含 forceMint）不会再重复打 */ const c1 = String(J.c).toLowerCase(); WALLETS.forEach((W, i) => { if (!String(res[i] || '').includes('✅')) return; S.paid = S.paid || {}; const P1 = S.paid[c1] || (S.paid[c1] = { at: Date.now(), name: J.name || '', done: {} }); P1.done = P1.done || {}; P1.done[W.name] = 'minted'; }); if (FORCE.has(c1) && WALLETS.every((W, i) => String(res[i] || '').includes('✅'))) { S.forceDone = S.forceDone || {}; S.forceDone[c1] = 1; } save(); }
    if (J.swapBack || J.approvals || J.revokeAll) await tgSay(`🛠 ${J.swapBack ? '換回 BNB' : '授權處理'} ${J.name || J.c || ''}\n${res.join('\n')}`);
    else { /* 使用者 11/1 03:42：手動補打不發個人 TG，改發大群（只說打了什麼，不寫金額和錢包） */
      const okAny = res.some((x) => x.includes('✅')); const c0 = String(J.c || '').toLowerCase(); S.grpOnce = S.grpOnce || {};
      if (okAny && TG && GROUP_ID && c0 && !S.grpOnce[c0]) { S.grpOnce[c0] = Date.now(); save(); try { await fetch(`https://api.telegram.org/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text: `📡 Agent ID 播报\n🛒 已铸造：${J.name || c0.slice(0, 10)}\n合约：${c0}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); log(`群播報: 手動補打 ${J.name || c0}`); } catch {} }
    }
  }
}
// ── TG 指令：使用者直接在機器人打「賣 XXX」「賣 XXX 一半」「餘額」，幾秒內執行，不經過 Claude ──
// ── 更新提醒（開源版才開；使用者 11/1 00:47：不自動更新，只提醒；用戶回 /update 才更新，更新前安檢＋sha256＋備份，新版起不來自動換回）──
const UPD = { on: true, ver: '3.0.0', repo: 'nancyc0813-maker/agentid-sniper', group: 't.me/nancy_c0813' }; /* 使用者 11/1 00:47：只提醒不自動更新；引導用戶加入使用者的 TG 群 */
const verGt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function updCheck(quiet = false) {
  if (!UPD.on) return null;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${UPD.repo}/main/version.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) return null;
    const v = await r.json(); if (!v.version || !verGt(v.version, UPD.ver)) return null; UPD.latest = v;
    if (!quiet && S.updNotified !== v.version) { /* 使用者 11/1 00:47：不要自動更新（怕被罵）——只提醒，用戶自己回 /update 才更新 */
      S.updNotified = v.version; save();
      const msg = `🔔 Agent ID Sniper 有新版 v${v.version}（你現在是 v${UPD.ver}）\n${(v.notes || []).map((x) => '• ' + x).join('\n')}\n\n要更新：在 TG 回「/update」，或在工具資料夾放一個名為 UPDATE 的空檔案（更新前會自動安檢、備份舊版）。\n不更新也可以照常使用。\n官方群：${UPD.group}`;
      log(msg.replace(/\n/g, ' | ')); console.log('\n' + '='.repeat(48) + '\n' + msg + '\n' + '='.repeat(48) + '\n'); await tgSay(msg);
    }
    return v;
  } catch { return null; }
}
async function doUpdate() {
  if (!UPD.on) return '這個版本不自動更新';
  const v = UPD.latest && verGt(UPD.latest.version, UPD.ver) ? UPD.latest : await updCheck(true); if (!v) return `目前已經是最新版 v${UPD.ver}`;
  if (v.files) return `v${v.version} 是多个档案一起更新的大版本：请在工具资料夹执行 git pull（或叫你的 AI 照 GitHub 说明更新），再重开工具和罗宾猫雷达`; /* 3.0 起有很多档案，单档更新会缺档 */
  const r = await fetch(`https://raw.githubusercontent.com/${UPD.repo}/main/watch.mjs?t=${Date.now()}`, { signal: AbortSignal.timeout(60000) }).catch(() => null);
  if (!r || !r.ok) return '⚠️ 下載新版失敗，等一下再試';
  const buf = Buffer.from(await r.arrayBuffer()), code = buf.toString('utf8');
  if (!v.sha256 || createHash('sha256').update(buf).digest('hex') !== v.sha256) return '⚠️ 新版檔案校驗不符（GitHub 剛更新時快取還沒同步，或下載不完整），稍後再試';
  const old = readFileSync(SELF, 'utf8');
  const hosts = (t) => new Set([...t.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
  const TRUST = new Set(['api.geckoterminal.com', 'api.dexscreener.com', 'raw.githubusercontent.com', 'api.telegram.org', 'bsc-dataseed.bnbchain.org', 'bsc-rpc.publicnode.com']); /* 已知安全的價格／節點網站，之後新版用到不擋 */
  const ho = hosts(old), nh = [...hosts(code)].filter((h) => !ho.has(h) && !TRUST.has(h));
  if (nh.length) return `⛔ 新版會連到沒見過的網站（${nh.slice(0, 3).join('、')}），為了安全已拒絕更新。請到 GitHub 自己看過再手動下載。`;
  const risky = [/private[_\s-]?key/gi, /mnemonic/gi, /seed\s?phrase/gi, /助記詞|助记词|私鑰|私钥/g, /\beval\s*\(/g, /new\s+Function\s*\(/g, /child_process/g, /powershell|Invoke-WebRequest|curl\s|wget\s|certutil|bitsadmin/gi, /execSync|spawnSync|\bspawn\s*\(/g, /\.(exe|dll|ps1|bat|cmd|vbs)['"`]/gi, /keystore/gi];
  for (const re of risky) { const n = (t) => (t.match(re) || []).length; if (n(code) > n(old)) return `⛔ 新版出現可疑內容（${re.source.slice(0, 40)}），為了安全已拒絕更新。請到 GitHub 自己看過再手動下載。`; }
  const tmp = join(DIR, 'data', 'update_new.mjs'); writeFileSync(tmp, code);
  const bad = await new Promise((res) => execFile(process.execPath, ['--check', tmp], { windowsHide: true, timeout: 60000 }, (e, o, er) => res(e ? String(er || e.message) : '')));
  if (bad) { try { unlinkSync(tmp); } catch {} return '⛔ 新版語法檢查沒過，已取消更新：' + bad.slice(0, 120); }
  copyFileSync(SELF, join(DIR, 'data', 'update_backup.mjs')); writeFileSync(SELF, code); try { unlinkSync(tmp); } catch {}
  log(`已更新到 v${v.version}（舊版備份在 data/update_backup.mjs）`);
  return `✅ 已更新到 v${v.version}，舊版已備份，工具會自動重啟載入。新版如果連續 3 次啟動失敗，會自動換回舊版。`;
}
async function groupInvite() { if (!UPD.on || S.grpInvited === 1) return; S.grpInvited = 1; save(); const msg = `👋 歡迎使用 Agent ID Sniper v${UPD.ver}\n加入官方 TG 群，第一時間收到：\n• 工具更新通知\n• 打到什麼項目、哪個開盤的即時播報\n• 使用教學與問題解答\n👉 ${UPD.group}`; log(msg.replace(/\n/g, ' | ')); console.log('\n' + '='.repeat(48) + '\n' + msg + '\n' + '='.repeat(48) + '\n'); await tgSay(msg); }
if (UPD.on) setTimeout(() => { const b = join(DIR, 'data', 'update_backup.mjs'); if (existsSync(b)) { try { renameSync(b, join(DIR, 'data', 'backup_prev.mjs')); log('新版已穩定運行 10 分鐘，舊版備份改存為 data/backup_prev.mjs'); } catch {} } }, 10 * 60e3).unref();
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
    const dupSym = TOKENS.concat(S.dyn || []).filter((x) => (!x.only || x.only === W.addr) && x.sym === t0.sym && x.addr !== t0.addr).length > 0;
    const key = (W.addr === ME ? t0.sym : W.name + ':' + t0.sym) + (dupSym ? '#' + t0.addr.slice(2, 8) : '');
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
async function holdReport(title = '📦 持倉總結') { /* 使用者 11/1 03:19：每 12 小時（凌晨 1 點、下午 1 點；使用者 11/1 03:36 改）發一次持倉總結：成本、現值、倍數、狀態 */
  const rows = [], noPool = [], dust = []; let tc = 0, tv = 0;
  for (const W of WALLETS) for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr)).catch(() => null)); if (!(bal > 0n)) continue;
    const v = await valueUsd(t0, bal).catch(() => null); const wn = W === WALLETS[0] ? 'A' : 'B';
    if (v == null) { if (!noPool.includes(t0.sym)) noPool.push(t0.sym); continue; }
    if (v < 0.3) { if (!dust.includes(t0.sym)) dust.push(t0.sym); continue; }
    const st = (S.tokens || {})[t0.sym] || (S.tokens || {})[W.name + ':' + t0.sym] || {}; const cost = Number(t0.cost) || 0; const x = cost > 0 ? v / cost : 0;
    const status = t0.hold ? '只通知' : t0.custom ? '特殊規則' : (st.done2 || []).includes('back') ? (st.moon ? `已回本，含 ${RULE.moonPct}% 長抱` : '已回本，照策略持有') : cost > 0 ? '照策略持有' : '免費幣';
    tc += cost; tv += v; rows.push({ v, line: `${t0.sym}（錢包${wn}）${cost > 0 ? `成本 ${cost.toFixed(1)}U → ` : ''}約 ${v.toFixed(2)}U${x ? `（${x.toFixed(2)} 倍）` : ''} · ${status}` });
  }
  rows.sort((a, b) => b.v - a.v);
  const msg = `${title}（錢包A＝${WALLETS[0]?.name || ''}${WALLETS[1] ? '、錢包B＝' + WALLETS[1].name : ''}）\n${rows.length ? rows.map((r) => '· ' + r.line).join('\n') : '目前沒有有價格的持倉'}\n\n有價格的合計：約 ${tv.toFixed(2)}U${tc ? `（付費成本合計 ${tc.toFixed(1)}U）` : ''}${noPool.length ? `\n還沒開池（${noPool.length} 個）：${noPool.slice(0, 20).join('、')}${noPool.length > 20 ? '…' : ''}` : ''}${dust.length ? `\n不到 0.3U 的零頭：${dust.join('、')}` : ''}`;
  await tgSay(msg);
}
setInterval(() => { const tp = new Date(Date.now() + 8 * 3600e3), h = tp.getUTCHours(), k = tp.toISOString().slice(0, 10) + '-' + h; if ((h === 1 || h === 13) && S.holdRepAt !== k) { S.holdRepAt = k; save(); holdReport().catch((e) => log('holdReport ' + e.message)); } }, 60e3).unref();
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
        else if (/^(持倉|持仓|holdings?)$/i.test(txt)) { holdReport('📦 持倉').catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(暫停|暂停|pause)$/i.test(txt)) { writeFileSync(join(DIR, 'data', 'pause_buy.txt'), String(Date.now())); await tgSay('⏸ 已暂停自动买（卖出照常）。要恢复打「恢复」'); }
        else if (/^(恢復|恢复|resume)$/i.test(txt)) { try { unlinkSync(join(DIR, 'data', 'pause_buy.txt')); } catch {} await tgSay('▶ 已恢复自动买'); }
        else if (/^\/?(?:打|buy)\s+0x[0-9a-fA-F]{40}/i.test(txt)) { const m = txt.match(/(0x[0-9a-fA-F]{40})\s*(\d+(?:\.\d+)?)?/); await tgSay('⚡ 收到，下單中…'); await tgSay(await tgBuy(m[1], m[2] || 10).catch((e) => '⚠️ 下單出錯：' + e.message)); } /* 11/1 22:55：/打 合約 10U */
        else if (/^(戰績|战绩|統計|统计|stats?)$/i.test(txt)) { cmdStats().catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(update|更新)$/i.test(txt)) { if (!UPD.on) await tgSay('這個版本不自動更新'); else { await tgSay('⚡ 收到，下載新版並安檢中…'); await tgSay(await doUpdate().catch((e) => '⚠️ 更新出錯：' + e.message)); } }
        else if (/^(help|指令|說明|说明)$/i.test(txt)) await tgSay('可用指令：\n賣 XXX → 所有錢包全賣\n賣 XXX 一半 → 各賣一半\n（也可打「XXX 全出」「XXX 出一半」）\n餘額 → 看各錢包 BNB\n持倉 → 還沒賣的幣和現值\n戰績 → 上線以來打了多少、賣了多少');
      }
    } catch { await sleep(3000); }
  }
}

let lastLoopAt = Date.now();
setInterval(() => { if (Date.now() - lastLoopAt > (INFLIGHT > 0 ? 11 : 8) * 60e3) { log('看門狗：主迴圈卡住超過 8 分鐘，自動重啟'); try { save(); } catch {} process.exit(3); } }, 30e3).unref();
async function main() {
  log('启动监测'); setTimeout(() => groupInvite().catch(() => {}), 20e3);
  tgCmdLoop().catch((e) => log('tgCmd ' + e.message));
  let lastHold = 0, lastLogin = 0;
  for (;;) {
    try { if (statSync(SELF).mtimeMs !== SELF_MT) { if ((INFLIGHT > 0 || globalThis._xBusy) && !globalThis._waitSince) globalThis._waitSince = Date.now(); if ((INFLIGHT === 0 && !globalThis._xBusy) || Date.now() - (globalThis._waitSince || 0) > 300e3) { log('程序更新，重启'); save(); process.exit(0); } } } catch {} // 有交易正在送出就先等它送完（最多 4 分鐘）
    if (UPD.on && existsSync(join(DIR, 'UPDATE'))) { try { unlinkSync(join(DIR, 'UPDATE')); } catch {} doUpdate().then((m) => { log(m); console.log('\n' + m + '\n'); tgSay(m); }).catch((e) => log('update ' + e.message)); }
    if (UPD.on && (!globalThis._updAt || Date.now() - globalThis._updAt > 30 * 60e3)) { globalThis._updAt = Date.now(); updCheck().catch(() => {}); } // 每 30 分鐘看一次 GitHub 有沒有新版
    if (existsSync(join(DIR, 'WATCH_STOP'))) { log('WATCH_STOP，退出'); save(); process.exit(0); }
    try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const tS = Date.now(); await scanNew(head); if (Date.now() - tS > 20e3) log(`掃描一輪花了 ${Math.round((Date.now() - tS) / 1000)} 秒`);
      if (!globalThis._agBusy && Date.now() - (globalThis._agAt || 0) > 60e3) { globalThis._agBusy = true; globalThis._agAt = Date.now(); agTokScan().catch((e) => log('agTok ' + e.message)).finally(() => { globalThis._agBusy = false; }); } /* 11/1 22:21：AI 熱門代幣每分鐘檢查 */
      if (!globalThis._openBusy && Date.now() - (globalThis._openAt || 0) > 15e3) { globalThis._openBusy = true; globalThis._openAt = Date.now(); openWatch(head).catch((e) => log('openWatch ' + e.message)).finally(() => { globalThis._openBusy = false; }); } /* v2.8.0：开盘侦测每 15 秒 */
      { const fast = Object.values(S.tokens).some((st) => st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done); const full = Date.now() - lastHold > 5000; if (!globalThis._holdBusy && full) { lastHold = Date.now(); globalThis._holdBusy = true; const tH = Date.now(); holdings(head, false).catch((e) => log('holdings ' + e.message)).finally(() => { globalThis._holdBusy = false; if (Date.now() - tH > 20e3) log(`持倉檢查花了 ${Math.round((Date.now() - tH) / 1000)} 秒`); }); } if (fast && !globalThis._fastBusy && Date.now() - (globalThis._fastAt || 0) > 15e3) { globalThis._fastBusy = true; globalThis._fastAt = Date.now(); holdings(head, true).catch((e) => log('holdings fast ' + e.message)).finally(() => { globalThis._fastBusy = false; }); } } /* v2.8.2：刚开盘 30 分钟内的币独立每 15 秒看价格，不再等完整检查跑完 */ /* 持倉檢查放背景，同時只跑一個，避免重複賣 */
      if (!globalThis._flapAt || Date.now() - globalThis._flapAt > 30e3) { globalThis._flapAt = Date.now(); if (!globalThis._flapBusy) { globalThis._flapBusy = true; flapAgentWatch().catch((e) => log('flap ' + e.message)).finally(() => { globalThis._flapBusy = false; }); } }
      if (!globalThis._toshAt || Date.now() - globalThis._toshAt > 60e3) { globalThis._toshAt = Date.now(); if (!globalThis._toshBusy) { globalThis._toshBusy = true; toshWatch().catch((e) => log('tosh ' + e.message)).finally(() => { globalThis._toshBusy = false; }); } }
      if (!globalThis._miscAt || Date.now() - globalThis._miscAt > 600e3) { globalThis._miscAt = Date.now(); lowBnbWatch().catch(() => {}); flapApprovalWatch().catch((e) => log('flapApproval ' + e.message)); approvalPatrol().catch((e) => log('approvalPatrol ' + e.message)); } /* 每 10 分鐘看 BNB 夠不夠 */
      dailyReport().catch((e) => log('daily ' + e.message));
      if (!globalThis._pruneAt || Date.now() - globalThis._pruneAt > 3600e3) { globalThis._pruneAt = Date.now(); pruneState(); }
      if (!globalThis._aidropAt || Date.now() - globalThis._aidropAt > 120e3) { globalThis._aidropAt = Date.now(); const tA = Date.now(); await aidropWatch(head); if (Date.now() - tA > 20e3) log(`aidrop 檢查花了 ${Math.round((Date.now() - tA) / 1000)} 秒`); }
      for (let k = 0; k < 3; k++) { const bk = '_paidBusy' + k, ak = '_paidAt' + k; if (!globalThis[bk] && (!globalThis[ak] || Date.now() - globalThis[ak] > 15e3)) { globalThis[ak] = Date.now(); globalThis[bk] = true; paidLoop('hot', k).catch((e) => log('paidLoop ' + e.message)).finally(() => { globalThis[bk] = false; globalThis._paidDur = Math.round((Date.now() - globalThis[ak]) / 1000); }); } } /* 快速檢查：每 15 秒，分 3 組同時跑 */
      if (!globalThis._swBusy && (!globalThis._swAt || Date.now() - globalThis._swAt > 60e3)) { globalThis._swAt = Date.now(); globalThis._swBusy = true; progressSweep().catch((e) => log('sweep ' + e.message)).finally(() => { globalThis._swBusy = false; }); } // 每分鐘輕量讀進度
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
