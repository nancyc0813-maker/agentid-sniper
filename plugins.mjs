// 罗宾猫雷达 · 外挂（量化策略等）载入器
// 规矩：1) plugins/ 里的外挂要玩家在雷达按「允许」才载入，档案一改就要重新允许（比对 sha256）
//       2) 外挂不准 import / require / 读写档案 / 碰环境变数，只能用这里给的 api
//       3) 外挂有自己的帐本：只能卖自己买的，碰不到雷达打到的币；有自己的每日额度；雷达「暂停」时不能买
//       4) 买卖一律透过币安 Agentic 钱包（baw），拿不到私钥
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';

const BAD = /\bimport\b|\brequire\b|\bprocess\b|child_process|globalThis|\bglobal\b|\beval\b|\bFunction\b|__proto__|\bconstructor\b|\bprototype\b|\bReflect\b|\bProxy\b|__define|\bcallee\b|\\u[0-9a-fA-F{]|\\x[0-9a-fA-F]|\bDeno\b|\bBun\b|WebSocket|XMLHttpRequest|\bfetch\b|\bsetPrototypeOf\b|\bwindow\b|\bself\b/; /* 防：动态载入、碰系统、用 constructor 绕出沙盒、用 \\u 跳脱字元藏关键字 */
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDT = '0x55d398326f99059ff775485246999027b3197955';
export const STABLES = { USDT: '0x55d398326f99059ff775485246999027b3197955', USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', FDUSD: '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409' };
export const TOKENS = { USDC: STABLES.USDC, FDUSD: STABLES.FDUSD, BNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' /* 外挂一律用 WBNB，跟雷达付 gas／铸造用的 BNB 分开，才不会互相吃掉 */, ETH: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', BTCB: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', USDT };


/* 自订面板（11/2）：外挂只交「资料」，雷达用官方画面显示 → 不碰签名、外挂没办法在画面里塞程式或偷偷下单 */
const S_ = (v, n = 80) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const N_ = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const TONES = new Set(['up', 'dn', 'warn', 'info', '']);
function cleanPanel(p) { const items = []; for (const it of (Array.isArray(p?.items) ? p.items : []).slice(0, 40)) { const t = it?.type; const tone = TONES.has(it?.tone) ? it.tone : '';
    if (t === 'stat') items.push({ type: t, label: S_(it.label, 40), value: S_(it.value, 30), sub: S_(it.sub, 60), tone });
    else if (t === 'text' || t === 'alert') items.push({ type: t, text: S_(it.text, 600), tone });
    else if (t === 'table') items.push({ type: t, cols: (it.cols || []).slice(0, 8).map((c) => S_(c, 24)), rows: (it.rows || []).slice(0, 60).map((r) => (Array.isArray(r) ? r : []).slice(0, 8).map((c) => S_(c, 60))) });
    else if (t === 'line') items.push({ type: t, label: S_(it.label, 40), points: (it.points || []).slice(-400).map((q) => [N_(q?.[0]), N_(q?.[1])]).filter((q) => q[0] != null && q[1] != null) });
    else if (t === 'action' && /^0x[0-9a-fA-F]{40}$/.test(String(it.c || '')) && ['buy', 'mint'].includes(it.act)) items.push({ type: t, label: S_(it.label, 30), act: it.act, chain: it.chain === 'rh' ? 'rh' : 'bsc', c: String(it.c).toLowerCase(), name: S_(it.name, 30), usd: N_(it.usd) }); }
  return { title: S_(p?.title, 60), items }; }
function savePanel(id, meta, p) { try { const dir = join(PANEL_ROOT, 'data', 'panels'); mkdirSync(dir, { recursive: true }); const v = { id, name: S_(meta?.name || id, 40), at: Date.now(), ...cleanPanel(p) }; writeFileSync(join(dir, String(id).replace(/[^\w一-鿿-]/g, '_') + '.json'), JSON.stringify(v)); } catch {} }
let PANEL_ROOT = '.';
const DATA_HOSTS = new Set(['api.dexscreener.com', 'api.geckoterminal.com', 'api.coingecko.com', 'api.binance.com', 'data-api.binance.vision', 'api.honeypot.is', 'api.llama.fi', 'coins.llama.fi']); /* 外挂能读的公开行情网站（只读、不带任何私人资料） */
export async function startPlugins(ctx) {
  const { DIR, WALLETS, log, tg, S, save, radarOff, radarSet, rpc } = ctx; PANEL_ROOT = DIR;
  const readData = async (url) => { const u = new URL(String(url)); if (u.protocol !== 'https:' || !DATA_HOSTS.has(u.hostname)) throw new Error('只能读这些公开行情网站：' + [...DATA_HOSTS].join('、')); const r = await fetch(u, { signal: AbortSignal.timeout(12000), headers: { accept: 'application/json' } }); const t = await r.text(); if (t.length > 2e6) throw new Error('资料太大'); return JSON.parse(t); };
  const readBal = async () => { try { return JSON.parse(readFileSync(join(DIR, 'data', 'radar_bal.json'), 'utf8')); } catch { return null; } }; /* 钱包余额（雷达每分钟更新的那份；只有公开地址和余额，没有私钥） */
  const RH_RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const readChain = async (to, data, ch) => { if (!/^0x[0-9a-fA-F]{40}$/.test(String(to)) || !/^0x[0-9a-fA-F]*$/.test(String(data))) throw new Error('地址或资料格式不对'); const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }; if (String(ch) === '4663') { const j = await (await fetch(RH_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })).json(); return j.result || '0x'; } return await rpc('eth_call', [{ to, data }, 'latest']); }; /* 只读链上资料，不能送交易 */
  const PD = join(DIR, 'plugins'), OK = join(DIR, 'data', 'plugins_ok.json'), META = join(DIR, 'data', 'plugins_meta.json');
  const rj = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
  S.plug = S.plug || {};
  const HOST = join(DIR, 'plugin-host.mjs');
  const PERM = ['--permission', '--experimental-permission'].find((fl) => { try { return spawnSync(process.execPath, [fl, '-e', '0'], { timeout: 15000, windowsHide: true }).status === 0; } catch { return false; } });
  function spawnHost(file) { return new Promise((res, rej) => {
    const ch = fork(HOST, [file], { execArgv: [PERM, `--allow-fs-read=${HOST}`, `--allow-fs-read=${file}`], env: { SystemRoot: process.env.SystemRoot || '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let err = ''; ch.stderr?.on('data', (d) => { err += d; }); const to = setTimeout(() => { ch.kill(); rej(new Error('外挂启动逾时')); }, 15000);
    ch.once('message', (m) => { clearTimeout(to); if (m.t === 'meta') res({ ch, meta: m.meta }); else { ch.kill(); rej(new Error(m.err || '启动失败')); } });
    ch.once('exit', (c) => { clearTimeout(to); rej(new Error('外挂结束了 ' + (err.slice(-150) || c))); }); }); }
  const okMap = rj(OK, {}); const found = [], loaded = [];
  for (const f of existsSync(PD) ? readdirSync(PD).filter((x) => x.endsWith('.mjs')) : []) {
    const src = readFileSync(join(PD, f), 'utf8'); const hash = createHash('sha256').update(src).digest('hex');
    const doc = (src.match(/^\s*\/\/[^\n]*(\n\s*\/\/[^\n]*){0,6}/) || [''])[0].replace(/^\s*\/\/\s?/gm, '').trim().slice(0, 400);
    const bad = src.replace(/\/\/[^\n]*/g, '').match(BAD)?.[0] || '';
    const trades = /api\.(buy|sell|call|limitBuy|limitSell)\s*\(/.test(src);
    const item = { file: f, hash, doc, trades, bad, approved: okMap[f] === hash, size: src.length };
    found.push(item);
    if (bad) { log(`外挂 ${f} 用了不允许的东西（${bad}），不载入`); continue; }
    if (!item.approved) { log(`外挂 ${f} 还没在雷达按「允许」（或档案被改过），不载入`); continue; }
    if (!PERM) { item.err = '这台电脑的 Node 版本太旧，没有沙盒，为了安全不载入外挂（请更新 Node 到 22 版以上）'; log(`外挂 ${f}：${item.err}`); continue; }
    const host = await spawnHost(join(PD, f)).catch((e) => { item.err = e.message.slice(0, 120); return null; }); if (!host) { log(`外挂 ${f} 启动失败：${item.err}`); continue; }
    const m = { meta: host.meta }; loaded.push({ f, m, item, host }); item.id = m.meta.id; item.name = m.meta.name; item.meta = m.meta;
  }
  // 给雷达「设定」页用：外挂清单＋每个外挂的设定项目
  const schemaItems = [], groups = [];
  if (loaded.length) { groups.push({ id: 'plug._all', zh: '外挂 · 总额度', en: 'Plugins · total budget' }); schemaItems.push({ k: 'plugins.base', g: 'plug._all', def: 0, min: 0, max: 2, zh: '本金用哪个稳定币（0=USDT，1=USDC，2=FDUSD）', en: 'Base stablecoin (0=USDT, 1=USDC, 2=FDUSD)', dzh: '外挂用这个稳定币买，卖掉换回当初用的那个', den: 'Plugins buy with it and sell back to the same one' }); schemaItems.push({ k: 'plugins.slipCustom', g: 'plug._all', def: 5, min: 0.5, max: 50, unit: '%', zh: '自选币滑点', en: 'Custom token slippage', dzh: '稳定币之间 0.3%、大币 1% 是固定的；你自己加的币用这个', den: 'Stables 0.3% and majors 1% are fixed; custom tokens use this' }); schemaItems.push({ k: 'plugins.dayUsd', g: 'plug._all', def: 100, min: 0, max: 1e9, unit: 'U', zh: '所有外挂每天合计最多', en: 'All plugins daily total', dzh: '全部外挂加起来每天最多花多少，自己决定', den: 'Your choice' }); }
  for (const L of loaded) { const id = L.m.meta.id; groups.push({ id: 'plug.' + id, zh: '外挂 · ' + (L.m.meta.name || id), en: 'Plugin · ' + (L.m.meta.nameEn || L.m.meta.name || id) });
    schemaItems.push({ k: `plug.${id}.on`, g: 'plug.' + id, def: 0, min: 0, max: 1, type: 'bool', zh: '启用', en: 'Enabled', dzh: L.m.meta.desc || '', den: L.m.meta.descEn || L.m.meta.desc || '' });
    schemaItems.push({ k: `plug.${id}.dayUsd`, g: 'plug.' + id, def: L.m.meta.dayUsd ?? 20, min: 0, max: 1e9, unit: 'U', zh: '每天最多花', en: 'Daily cap', dzh: '这个外挂每天买进的总上限（跟雷达分开算）', den: 'Separate from the radar budget' });
    for (const it of L.m.meta.settings || []) if (it && /^[a-zA-Z0-9_]+$/.test(it.k)) schemaItems.push({ ...it, k: `plug.${id}.${it.k}`, g: 'plug.' + id }); }
  writeFileSync(META, JSON.stringify({ at: Date.now(), found, groups, items: schemaItems }, null, 1));

  const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const big = (h) => (h && h !== '0x' ? BigInt(h.slice(0, 66)) : 0n);
  async function balOf(W, token) { if (token.toLowerCase() === NATIVE.toLowerCase()) return Number(big(await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0'))) / 1e18; const d = Number(big(await rpc('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']).catch(() => '0x12'))) || 18; return Number(big(await rpc('eth_call', [{ to: token, data: '0x70a08231' + W.addr.slice(2).padStart(64, '0') }, 'latest']).catch(() => '0x0'))) / 10 ** d; }
  const WBNB = TOKENS.BNB; const isStable = (a) => Object.values(STABLES).includes(String(a).toLowerCase());
  const userToks = () => { const L = radarSet()['plugins.tokens']; const o = {}; for (const x of Array.isArray(L) ? L.slice(0, 100) : []) { const a = String(x?.addr || '').toLowerCase(); const n = String(x?.sym || '').toUpperCase().slice(0, 20); if (/^0x[0-9a-f]{40}$/.test(a) && n) o[n] = a; } return o; };
  const tok = (t, forSell) => { let a = TOKENS[String(t).toUpperCase()] || userToks()[String(t).toUpperCase()] || (/^0x[0-9a-fA-F]{40}$/.test(String(t)) && Object.values({ ...TOKENS, ...userToks() }).includes(String(t).toLowerCase()) ? String(t).toLowerCase() : null);
    if (String(t).toLowerCase() === NATIVE.toLowerCase()) a = WBNB; /* 原生 BNB 一律换成 WBNB，不碰付 gas 的 BNB */
    if (!a) throw new Error('这个币不在外挂可交易清单里（在「设定 → 外挂可交易的币」加）：' + String(t).slice(0, 50));
    if (!forSell && (S.dyn || []).some((x) => String(x.addr).toLowerCase() === a.toLowerCase())) throw new Error('雷达正在持有这个币，外挂不能碰，免得互相卖到'); return a; };
  const baseOf = () => { const n = Number(radarSet()['plugins.base']) || 0; return [STABLES.USDT, STABLES.USDC, STABLES.FDUSD][n] || STABLES.USDT; };
  const slipFor = (a) => isStable(a) ? '0.3' : Object.values(TOKENS).includes(a.toLowerCase()) ? '1' : String(Math.min(50, Math.max(0.5, Number(radarSet()['plugins.slipCustom']) || 5)));
  const stName = (a) => Object.entries(STABLES).find(([, v]) => v === String(a).toLowerCase())?.[0] || 'USDT';
  async function revokeAll(W, token) { try { const r = await W.baw(['approvals', 'list', '--limit', '100']); for (const x of r.j?.data?.list || []) { if (String(x.tokenContract).toLowerCase() !== token.toLowerCase()) continue; const v = await W.baw(['approvals', 'revoke', '--binanceChainId', '56', '--tokenContract', x.tokenContract, '--spender', x.spender, '--type', x.type || 'approve']); log(`[外挂] 卖光 ${token.slice(0, 8)}，取消授权：${v.j?.success ? '成功' : '失败'}`); } } catch (e) { log('取消授权出错 ' + e.message); } } /* 卖光就取消授权，路由出事也转不走 */
  const allCap = () => { const x = Number(radarSet()['plugins.dayUsd']); return Number.isFinite(x) && x >= 0 ? x : 100; }; const allSpent = () => Object.values(S.plug || {}).reduce((a, p) => a + ((p.spent || {})[day()] || 0), 0); /* 所有外挂加起来每天的上限：用户在设定里自己定（推荐 100U） */

  for (const L of loaded) {
    const id = L.m.meta.id; const st = S.plug[id] = S.plug[id] || { pos: {}, spent: {}, state: {} };
    const conf = () => { const z = radarSet(); const o = {}; for (const it of schemaItems.filter((x) => x.g === 'plug.' + id)) { const n = it.k.split('.').pop(); let v = z[it.k] ?? it.def; v = Number(v); if (!Number.isFinite(v)) v = it.def; o[n] = Math.min(it.max, Math.max(it.min, v)); } return o; };
    const W0 = WALLETS[0]; const W = { ...W0, baw: async (args, to) => { const send = args[1] === 'swap' || args[1] === 'execute'; if (send) { for (let i = 0; i < 40 && ctx.walletBusy?.(); i++) await new Promise((z) => setTimeout(z, 500)); globalThis.PLUG_INFLIGHT = (globalThis.PLUG_INFLIGHT || 0) + 1; } try { return await W0.baw(args, to); } finally { if (send) globalThis.PLUG_INFLIGHT--; } } }; /* 11/2 她问「双方一起执行怎么办」：外挂送交易前先等雷达送完；雷达也会等外挂送完（同一个钱包一次只送一笔） */
    const gasOk = async () => (await balOf(W0, NATIVE)) >= (ctx.keepBnb ?? 0.006) + 0.002; /* BNB 是雷达付手续费、铸造用的，外挂不能把它用到不够 */
    let busy = false;
    const api = Object.freeze({
      id, log: (m) => log(`[外挂 ${id}] ${String(m).slice(0, 300)}`),
      notify: (m) => tg(`💰 [外挂 ${L.m.meta.name || id}] ${String(m).slice(0, 500)}`).catch(() => {}),
      settings: conf, position: (t) => ({ ...(st.pos[tok(t, true).toLowerCase()] || { qty: 0, cost: 0 }) }),
      spentToday: () => st.spent[day()] || 0,
      async price(t) { const a = tok(t); if (isStable(a)) return 1; const base = baseOf(); const r = await W.baw(['market-order', 'quote', '--binanceChainId', '56', '--fromTokenQty', '10', '--fromToken', base, '--toToken', a]); const q = Number(r.j?.data?.toCoinAmount); if (!(q > 0)) throw new Error('报价失败'); return 10 / q; }, /* 稳定币一律当 1 美元 */
      async buy(t, usd) { usd = Number(usd); const c = conf(); if (!(usd > 0)) throw new Error('金额不对');
        if (radarOff()) return { ok: false, why: '雷达暂停中／没开自动打' };
        if (!(await gasOk())) return { ok: false, why: '钱包里的 BNB 快不够付手续费了，先留给雷达用（请补一点 BNB）' };
        if ((st.spent[day()] || 0) + usd > c.dayUsd) return { ok: false, why: `今天额度用完（${c.dayUsd}U）` };
        if (allSpent() + usd > allCap()) return { ok: false, why: `所有外挂今天合计已到 ${allCap()}U（在设定里可以改）` };
        const a = tok(t); const base = baseOf(); if (a === base) return { ok: false, why: '本金币不用买' }; const ub = await balOf(W, base); if (ub < usd) return { ok: false, why: `${stName(base)} 不够（有 ${ub.toFixed(2)}）` };
        const b0 = await balOf(W, a); st.spent = { [day()]: (st.spent[day()] || 0) + usd }; /* 先记帐：雷达看到的保留额度跟着减少，两边不会抢同一笔 USDT */
        const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', usd.toFixed(4), '--fromToken', base, '--toToken', a, '--slippage', slipFor(a)]);
        if (!r.j?.success) { st.spent = { [day()]: Math.max(0, (st.spent[day()] || 0) - usd) }; return { ok: false, why: String(r.j?.error?.message || r.t).slice(0, 100) }; }
        let b1 = b0; for (let i = 0; i < 15 && b1 <= b0; i++) { await new Promise((z) => setTimeout(z, 3000)); b1 = await balOf(W, a); }
        const got = Math.max(0, b1 - b0); const k = a.toLowerCase(); const p = st.pos[k] || (st.pos[k] = { qty: 0, cost: 0, base }); if (p.qty > 0 && p.base && p.base !== base) { p.qty += got; p.cost += usd; } else { p.base = base; p.qty += got; p.cost += usd; } save(); /* 记住用哪个稳定币买的，卖时换回同一种 */
        (st.trades = st.trades || []).push({ side: '买', stable: stName(base), sym: String(t).toUpperCase(), w: W.addr, usd, got: `${got} ${String(t).toUpperCase()}`, at: Date.now() }); if (st.trades.length > 2000) st.trades.splice(0, st.trades.length - 2000);
        log(`[外挂 ${id}] 买 ${t} ${usd}U → ${got}`); return { ok: true, qty: got }; },
      async call(to, data, valueEth, chain) { /* 外挂也能跟合约互动（例如铸造），但一律先预演：有授权、交出钱包权限、扣别的币、花的比说的多 → 不送出 */
        to = String(to || '').toLowerCase(); data = String(data || '0x'); const v = Math.max(0, Number(valueEth) || 0); const cid = Number(chain) === 4663 ? '4663' : '56';
        if (!/^0x[0-9a-f]{40}$/.test(to) || !/^0x[0-9a-fA-F]*$/.test(data)) throw new Error('合约地址或资料格式不对');
        if (/^0x(095ea7b3|39509351|a22cb465|d505accf|8fcbaf0c|2b67b570)/i.test(data)) return { ok: false, why: '⛔ 这是授权／Permit 类的动作，外挂不准做（防盗）' };
        if (radarOff()) return { ok: false, why: '雷达暂停中／没开自动打' };
        const px = cid === '56' ? (await rpc('eth_call', [{ to: '0x0000000000000000000000000000000000000000', data: '0x' }, 'latest']).catch(() => null), null) : null; void px;
        const c = conf(); if ((st.spent[day()] || 0) >= c.dayUsd) return { ok: false, why: '今天额度用完' };
        const wei = BigInt(Math.round(v * 1e9)) * 10n ** 9n;
        const p = await W.baw(['contract-call', 'preview', '--binanceChainId', cid, '--from', W.addr, '--to', to, '--value', wei.toString(), '--inputData', data]);
        const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId; if (!p.j?.success || !rid) return { ok: false, why: '预演失败：' + String(p.j?.error?.message || p.t).slice(0, 80) };
        if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return { ok: false, why: '⛔ 预演发现会授权或交出钱包权限，不送出（防盗）' };
        const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
        if (mine.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee') && Number(b.change) < 0)) return { ok: false, why: '⛔ 预演显示会扣你别的币，不送出' };
        const out = mine.filter((b) => String(b.contractAddress).toLowerCase().startsWith('0xeeee') && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0); if (out > v * 1.05 + 1e-9) return { ok: false, why: `预演要花 ${out}，比你说的 ${v} 多，不送出` };
        const x = await W.baw(['contract-call', 'execute', '--requestId', rid]); log(`[外挂 ${id}] 合约互动 ${to}：${String(x.t).slice(0, 160)}`);
        if (!x.j?.success) return { ok: false, why: '送出失败：' + String(x.j?.error?.message || x.t).slice(0, 80) };
        (st.trades = st.trades || []).push({ side: '买', sym: '合约 ' + to.slice(0, 8), w: W.addr, usd: null, got: `${v} ${cid === '56' ? 'BNB' : 'ETH'}`, at: Date.now() }); save(); return { ok: true, tx: x.j.data?.txHash || '' }; },
      async sell(t, qty) { const a = tok(t, true); const k = a.toLowerCase(); const p = st.pos[k]; if (!p || !(p.qty > 0)) return { ok: false, why: '外挂自己的帐本里没有这个币' };
        qty = Math.min(Number(qty) || 0, p.qty); if (!(qty > 0)) return { ok: false, why: '数量不对' }; /* 只能卖自己帐本里的量，碰不到雷达的部位 */
        const back0 = p.base || STABLES.USDT; if (a === back0) return { ok: false, why: '本金币不用卖' };
        const u0 = await balOf(W, back0); const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty.toFixed(6), '--fromToken', a, '--toToken', back0, '--slippage', slipFor(a)]);
        if (!r.j?.success) return { ok: false, why: String(r.j?.error?.message || r.t).slice(0, 100) };
        let u1 = u0; for (let i = 0; i < 15 && u1 <= u0; i++) { await new Promise((z) => setTimeout(z, 3000)); u1 = await balOf(W, back0); }
        const back = Math.max(0, u1 - u0); const frac = qty / p.qty; p.cost *= 1 - frac; p.qty -= qty; (st.trades = st.trades || []).push({ side: '卖', stable: stName(back0), sym: String(t).toUpperCase(), w: W.addr, usd: +back.toFixed(2), got: `${qty} ${String(t).toUpperCase()}`, at: Date.now() }); save(); if (p.qty <= 1e-12 || (await balOf(W, a)) <= 0) { p.qty = 0; p.cost = 0; if (!isStable(a)) revokeAll(W, a); } /* 稳定币的授权雷达铸造也在用，不取消 */ log(`[外挂 ${id}] 卖 ${t} ${qty} → ${back.toFixed(2)}U`); return { ok: true, usd: back }; },
    });
    const every = Math.max(30, Number(L.m.meta.everySec) || 60) * 1e3;
    let H = L.host;
    const runTick = () => new Promise((res) => { if (!H?.ch?.connected) return res('外挂沙盒没在跑');
      const ch = H.ch; const to = setTimeout(() => { ch.kill(); H = null; res('一轮超过 5 分钟，强制停止'); }, 300e3);
      const on = async (m) => { if (m.t === 'log') api.log(m.m); else if (m.t === 'notify') api.notify(m.m); else if (m.t === 'panel') savePanel(id, L.m.meta, m.p);
        else if (m.t === 'call') { const fn = { price: api.price, buy: api.buy, sell: api.sell, call: api.call, position: api.position, spentToday: api.spentToday, fetchJson: readData, read: readChain, balances: readBal }[m.name]; let v, err; try { if (!fn) throw new Error('没有这个功能'); v = await fn(...(Array.isArray(m.args) ? m.args.slice(0, 3) : [])); } catch (e) { err = e.message; } if (ch.connected) ch.send({ t: 'ret', id: m.id, v, err }); }
        else if (m.t === 'done') { clearTimeout(to); ch.off('message', on); if (m.state && typeof m.state === 'object') { st.state = m.state; } res(m.err || ''); } };
      ch.on('message', on); ch.send({ t: 'tick', id, settings: conf(), state: st.state }); });
    setInterval(async () => { if (busy || !conf().on) return; if (L.item.trades && ctx.walletBusy?.()) return; /* 只看不买的外挂（面板）不用等钱包空下来 */ busy = true; try { if (!H?.ch?.connected) { H = await spawnHost(join(PD, L.f)).catch(() => null); } const e = await runTick(); if (e) log(`[外挂 ${id}] ${e}`); save(); } catch (e) { log(`[外挂 ${id}] 出错：${e.message}`); } finally { busy = false; } }, every).unref();
    log(`外挂 ${L.f}（${id}）已载入`);
  }
  globalThis.PLUG_RESERVE_FN = () => { let r = 0; for (const L of loaded) { const id = L.m.meta.id; const z = radarSet(); if (!Number(z[`plug.${id}.on`])) continue; const cap = Number(z[`plug.${id}.dayUsd`] ?? L.m.meta.dayUsd ?? 20) || 0; r += Math.max(0, cap - ((S.plug[id]?.spent || {})[day()] || 0)); } r = Math.min(r, Math.max(0, allCap() - allSpent())); for (const p of Object.values(S.plug || {})) { const q = p.pos?.[STABLES.USDT]?.qty || 0; if (q > 0) r += q; } return r; }; /* 外挂今天还能花的＋外挂持有的 USDT，雷达都不碰 */
  globalThis.PLUG_HELD = (addr) => { let q = 0; const k = String(addr).toLowerCase(); for (const p of Object.values(S.plug || {})) q += p.pos?.[k]?.qty || 0; return q; }; /* 雷达卖出时扣掉外挂的部分 */ /* 外挂今天还能花的 USDT，雷达不会拿去用 */
  return { found };
}
