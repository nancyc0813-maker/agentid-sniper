// 罗宾猫雷达 · Robinhood Chain（4663）自动打
// 11/2 她定：两条链都要自动打，风险我自己抓、自己排除。Robinhood 没有 Agent ID，所以改用「真人买家＋防捆绑＋防抽池＋卖得掉」四层检查
export const RHC = {
  usd: 5, dayUsd: 30, maxPos: 3, minEth: 0.003,           // 每笔 10U、每个钱包每天最多 30U、同时最多持有 3 个
  maxAgeMin: 120, minLiqUsd: 20000,          // 开池 2 小时内、流动性 ≥ 2 万美金
  minRealBuyers: 80, oldNonce: 8, freshNonce: 3, // 1 小时内 ≥ 80 个「老钱包」买家（交易过 8 次以上）；交易 ≤ 3 次的算新开钱包
  maxBundle: 0.15, earlySec: 15,             // 开盘前 15 秒买的、新开钱包、买入数量一模一样的 → 合计持有 > 15% 不打
  maxTop10: 0.30, maxDev: 0.05,              // 前 10 大 ≤ 30%、部署者 ≤ 5%
  maxRoundTrip: 0.25,                        // 模拟「买进马上卖」亏损 > 25%（税高／貔貅）不打
  lpDrop: 0.4, bundleSellPct: 0.01,          // 买了以后：池子少 40% 或捆绑钱包卖超过 1% 总量 → 立刻全卖
  backX: 2, steps: [[10, 30], [20, 50]], crash: 0.4, crashAfterBack: 0.6,
  mintAuto: 1, mintUsd: 5, mintDayUsd: 20, mintMinReal: 50, mintWinMin: 60, mintMaxFresh: 15, // Robinhood 铸造项目：1 小时内 ≥ 50 个真人钱包在铸造、新开钱包占比 ≤ 15%、每次铸造 ≤ 5U 才自动铸 // 卖出照 BSC：2 倍卖回本、10 倍卖 30%、20 倍再卖 50%、从最高回落 40%（回本后 60%）全卖
};
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org', 'https://4663.rpc.thirdweb.com']; /* 官方会限流 → 轮流用三个；nodeflare 每 10 秒只给 1 次，而且历史查询会回假资料，不用 */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (x) => String(x || '').toLowerCase();
const isAddr = (x) => /^0x[0-9a-f]{40}$/.test(lc(x));

export function startRH(ctx) {
  const { WALLETS, log, tg, S, save, radarOff } = ctx;
  S.rh = S.rh || {}; S.rh.pos = S.rh.pos || {}; S.rh.seen = S.rh.seen || {}; S.rh.black = S.rh.black || {}; S.rh.day = S.rh.day || {};
  const R = S.rh; let ri = 0;
  async function rpc(method, params) { let last; for (let i = 0; i < RPCS.length; i++) { const u = RPCS[(ri + i) % RPCS.length]; try { const rs = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) }); if (rs.status === 429) throw new Error('Too Many Requests'); const j = await rs.json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (e) { last = e; ri++; if (/Too Many|rate/i.test(e.message)) await sleep(800); } } throw last; }
  async function batch(calls) { const out = []; for (let i = 0; i < calls.length; i += 20) { const part = calls.slice(i, i + 20); let ok = false; for (let k = 0; k < RPCS.length && !ok; k++) { try { const j = await (await fetch(RPCS[(ri + k) % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part.map(([m, p], n) => ({ jsonrpc: '2.0', id: n, method: m, params: p }))), signal: AbortSignal.timeout(20000) })).json(); const by = new Map((Array.isArray(j) ? j : []).map((x) => [x.id, x.result])); part.forEach((_, n) => out.push(by.get(n) ?? null)); ok = Array.isArray(j); if (!ok) throw 0; } catch { await sleep(600); } } if (!ok) part.forEach(() => out.push(null)); await sleep(300); } return out; }
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
  const big = (h) => (h && h !== '0x' ? BigInt(h.slice(0, 66)) : 0n);
  const wa = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
  const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const spent = (a) => R.day[day()]?.[a] || 0;
  const addSpent = (a, u) => { const d = day(); R.day = { [d]: { ...(R.day[d] || {}), [a]: spent(a) + u } }; };
  let bps = 4; // 每秒几个区块（启动时校正）
  (async () => { try { const h = parseInt(await rpc('eth_blockNumber', []), 16); const [a, b] = await Promise.all([rpc('eth_getBlockByNumber', ['0x' + h.toString(16), false]), rpc('eth_getBlockByNumber', ['0x' + (h - 20000).toString(16), false])]); const dt = parseInt(a.timestamp, 16) - parseInt(b.timestamp, 16); if (dt > 0) bps = 20000 / dt; log(`[Robinhood] 区块速度约 ${bps.toFixed(2)} 块/秒`); } catch (e) { log('[Robinhood] 校正区块速度失败 ' + e.message); } })();

  async function ethUsd() { try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/search?q=WETH%20USDG', { signal: AbortSignal.timeout(12000) })).json(); for (const p of j.pairs || []) if (p.chainId === 'robinhood' && p.baseToken?.symbol === 'WETH' && +p.priceUsd > 500) return +p.priceUsd; } catch {} try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/search?q=WETH', { signal: AbortSignal.timeout(12000) })).json(); for (const p of j.pairs || []) if (p.baseToken?.symbol === 'WETH' && +p.priceUsd > 500) return +p.priceUsd; } catch {} return 0; }
  async function dsInfo(addrs) { const m = new Map(); for (let i = 0; i < addrs.length; i += 30) { try { const j = await (await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${addrs.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(12000) })).json(); for (const p of j || []) { const t = lc(p.baseToken?.address); const liq = +(p.liquidity?.usd) || 0; if (!m.has(t) || liq > m.get(t).liq) m.set(t, { price: +p.priceUsd || 0, liq, pair: lc(p.pairAddress), sym: p.baseToken?.symbol }); } } catch {} } return m; }
  async function quote(W, from, to, qty) { const r = await W.baw(['market-order', 'quote', '--binanceChainId', '4663', '--fromTokenQty', String(qty), '--fromToken', from, '--toToken', to]); if (!r.j?.success) throw new Error(String(r.j?.error?.message || r.t).slice(0, 120)); return +r.j.data.toCoinAmount; }
  async function decimals(t) { const d = await call(t, '0x313ce567'); return d ? Number(big(d)) : 18; }

  // ── 候选：GeckoTerminal 热门＋新池（DexScreener 补），同名多池直接跳过 ──
  async function candidates() {
    const pools = [];
    for (const k of ['new_pools', 'trending_pools']) { try { const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/${k}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) })).json(); for (const p of j.data || []) { const a = p.attributes || {}; pools.push({ c: lc(String(p.relationships?.base_token?.data?.id || '').split('_').pop()), sym: String(a.name || '').split(' / ')[0].trim(), pool: lc(a.address), liq: +a.reserve_in_usd || 0, ageMin: a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 60e3 : 1e9, buys: a.transactions?.h1?.buys || 0, sells: a.transactions?.h1?.sells || 0 }); } } catch {} await sleep(1500); }
    if (pools.length < 5) { try { const seen = new Set(); for (const u of ['token-profiles/latest/v1', 'token-boosts/latest/v1']) { const j = await (await fetch('https://api.dexscreener.com/' + u, { signal: AbortSignal.timeout(12000) })).json(); for (const x of j || []) if (x.chainId === 'robinhood') seen.add(lc(x.tokenAddress)); }
        const ids = [...seen].filter(isAddr).slice(0, 30); if (ids.length) { const ps = await (await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${ids.join(',')}`, { signal: AbortSignal.timeout(12000) })).json(); for (const p of ps || []) pools.push({ c: lc(p.baseToken?.address), sym: String(p.baseToken?.symbol || ''), pool: lc(p.pairAddress), liq: +(p.liquidity?.usd) || 0, ageMin: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60e3 : 1e9, buys: p.txns?.h1?.buys || 0, sells: p.txns?.h1?.sells || 0 }); } } catch {} } /* GeckoTerminal 被限流时改用 DexScreener，不会整个瞎掉 */
    const bySym = new Map(); for (const p of pools) { const s = p.sym.toUpperCase(); if (!bySym.has(s)) bySym.set(s, new Set()); bySym.get(s).add(p.c); }
    const seen = new Set(), out = [];
    for (const p of pools) { if (!isAddr(p.c) || seen.has(p.c)) continue; seen.add(p.c);
      if (bySym.get(p.sym.toUpperCase()).size > 1) { note(p, '同名有好几个币（仿盘），跳过'); continue; }
      if (!(p.liq > 0)) { note(p, '流动性是 0，数据不可信'); continue; }
      if (p.ageMin > RHC.maxAgeMin) continue;
      if (p.liq < RHC.minLiqUsd) { note(p, `流动性 $${Math.round(p.liq)}，要 $${RHC.minLiqUsd} 以上`, 1); continue; }
      if (p.buys <= p.sells) { note(p, `1 小时买 ${p.buys}／卖 ${p.sells}，卖比买多`, 1); continue; }
      out.push(p); }
    return out;
  }
  function note(p, why, retry) { const o = R.seen[p.c] || {}; R.seen[p.c] = { ...o, sym: p.sym || o.sym, at: Date.now(), why, ok: false, retry: !!retry, liq: p.liq ?? o.liq }; }

  // ── 深度检查：真人买家、捆绑、持币集中、后门、卖得掉 ──
  async function analyze(c, poolHint, manual, opt = {}) {
    const head = opt.toBlock || parseInt(await rpc('eth_blockNumber', []), 16); const TB = '0x' + head.toString(16);
    let from = Math.max(0, head - Math.ceil(bps * 3600 * 6)); let logs = [];
    for (let tries = 0; tries < 3; tries++) { logs = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: TB, address: c, topics: [TRANSFER] }]); if (logs.some((l) => lc('0x' + l.topics[1].slice(26)) === ZERO) || from === 0) break; from = Math.max(0, from - Math.ceil(bps * 3600 * 24)); }
    if (!logs.length) return { ok: false, why: '查不到转账纪录' };
    const tf = logs.map((l) => ({ from: lc('0x' + l.topics[1].slice(26)), to: lc('0x' + l.topics[2].slice(26)), v: big(l.data), b: parseInt(l.blockNumber, 16), tx: l.transactionHash }));
    let supply = 0n; const bal = new Map(); const add = (a, v) => bal.set(a, (bal.get(a) || 0n) + v);
    let deployer = null; for (const t of tf) { if (t.from === ZERO) { supply += t.v; if (!deployer) deployer = t.to; } else add(t.from, -t.v); if (t.to === ZERO || t.to === DEAD) supply -= t.v; else add(t.to, t.v); }
    if (supply <= 0n) { supply = big(await call(c, '0x18160ddd')); }
    if (supply <= 0n) return { ok: false, why: '读不到总量' };
    // 池子（或 v4 的 PoolManager）= 出现在最多笔交易里的「转出方」
    const cnt = new Map(); for (const t of tf) if (t.from !== ZERO) cnt.set(t.from, (cnt.get(t.from) || new Set()).add(t.tx));
    let pool = isAddr(poolHint) ? lc(poolHint) : null; if (!pool || !cnt.has(pool)) pool = [...cnt.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0];
    const byTx = new Map(); for (const t of tf) { if (!byTx.has(t.tx)) byTx.set(t.tx, []); byTx.get(t.tx).push(t); }
    const buys = [], sells = [];
    for (const [tx, arr] of byTx) { const net = new Map(); for (const t of arr) { net.set(t.from, (net.get(t.from) || 0n) - t.v); net.set(t.to, (net.get(t.to) || 0n) + t.v); }
      const pn = net.get(pool) || 0n; const others = [...net.entries()].filter(([a]) => a !== pool && a !== ZERO && a !== c);
      if (pn < 0n) { const [who, v] = others.sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] || []; if (who && v > 0n) buys.push({ who, v, b: arr[0].b }); }
      else if (pn > 0n) { const [who, v] = others.sort((a, b) => (a[1] > b[1] ? 1 : -1))[0] || []; if (who && v < 0n) sells.push({ who, v: -v, b: arr[0].b }); } }
    if (!buys.length) return { ok: false, why: '还没有人买' };
    buys.sort((a, b) => a.b - b.b); const first = buys[0].b, earlyEnd = first + Math.max(3, Math.ceil(bps * RHC.earlySec));
    const early = new Set(buys.filter((x) => x.b <= earlyEnd).map((x) => x.who));
    const share = (set) => Number(([...set].reduce((s, a) => s + ((bal.get(a) || 0n) > 0n ? bal.get(a) : 0n), 0n) * 10000n) / supply) / 10000;
    const skipA = new Set([pool, ZERO, DEAD, c]);
    const holders = [...bal.entries()].filter(([a, v]) => v > 0n && !skipA.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    const top10 = Number((holders.slice(0, 10).reduce((s, [, v]) => s + v, 0n) * 10000n) / supply) / 10000;
    const devPct = deployer && !skipA.has(deployer) ? Number(((bal.get(deployer) || 0n) * 10000n) / supply) / 10000 : 0;
    // 钱包新旧（交易次数）
    const hourAgo = head - Math.ceil(bps * 3600);
    const recentBuyers = [...new Set(buys.filter((x) => x.b >= hourAgo).map((x) => x.who))].slice(0, 300);
    const checkAddrs = [...new Set([...recentBuyers, ...holders.slice(0, 50).map(([a]) => a), ...early])];
    const nonces = await batch(checkAddrs.map((a) => ['eth_getTransactionCount', [a, 'latest']]));
    const ethb = await batch(recentBuyers.map((a) => ['eth_getBalance', [a, 'latest']])); const EB = new Map(recentBuyers.map((a, i) => [a, ethb[i] == null ? -1 : Number(big(ethb[i])) / 1e18]));
    const N = new Map(checkAddrs.map((a, i) => [a, nonces[i] == null ? -1 : parseInt(nonces[i], 16)]));
    const realBuyers = recentBuyers.filter((a) => N.get(a) >= RHC.oldNonce && EB.get(a) >= RHC.minEth).length; /* 真人 = 交易够多次＋钱包里真的有 ETH（造 80 个假钱包每个都要押钱，成本高很多） */
    const fresh = new Set(holders.slice(0, 50).map(([a]) => a).filter((a) => N.get(a) >= 0 && N.get(a) <= RHC.freshNonce));
    // 买入数量一模一样（前两位有效数字相同、≥ 5 个不同钱包）
    const grp = new Map(); for (const x of buys) { const s = x.v.toString(); const k = s.length + ':' + s.slice(0, 2); if (!grp.has(k)) grp.set(k, new Set()); grp.get(k).add(x.who); }
    const same = new Set(); for (const g of grp.values()) if (g.size >= 5) g.forEach((a) => same.add(a));
    const bundle = new Set([...early, ...fresh, ...same]); bundle.delete(pool);
    const bundlePct = share(bundle);
    // 后门：可升级合约、有 owner 又有 mint／pause／blacklist
    const code = lc(await rpc('eth_getCode', [c, 'latest']).catch(() => '0x'));
    const impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']).catch(() => '0x0');
    const owner = lc('0x' + String((await call(c, '0x8da5cb5b')) || '').slice(-40));
    const hasOwner = isAddr(owner) && owner !== ZERO && owner !== DEAD;
    const back = []; if (big(impl) > 0n) back.push('可升级合约（项目方能换掉程式）'); if (hasOwner) { if (code.includes('40c10f19')) back.push('项目方可以增发'); if (code.includes('8456cb59')) back.push('项目方可以暂停交易'); if (code.includes('f9f92be4') || code.includes('44337ea1')) back.push('项目方可以拉黑名单'); }
    const facts = { realBuyers, bundlePct, top10, devPct, early: [...early], bundle: [...bundle], pool, supply: supply.toString(), deployer };
    const why = [];
    if (R.black[lc(deployer)]) why.push('部署者在黑名单');
    if (back.length) why.push(back.join('、'));
    if (bundlePct > RHC.maxBundle) why.push(`捆绑钱包持有 ${(bundlePct * 100).toFixed(1)}%（上限 ${RHC.maxBundle * 100}%）`);
    if (top10 > RHC.maxTop10) why.push(`前 10 大持有 ${(top10 * 100).toFixed(0)}%（上限 ${RHC.maxTop10 * 100}%）`);
    if (devPct > RHC.maxDev) why.push(`部署者自己持有 ${(devPct * 100).toFixed(1)}%（上限 ${RHC.maxDev * 100}%）`);
    if (!manual && realBuyers < RHC.minRealBuyers) why.push(`1 小时真实买家 ${realBuyers} 个（要 ${RHC.minRealBuyers} 个，新开钱包、空钱包不算）`);
    if (bundlePct > 0.3 && deployer) R.black[lc(deployer)] = { why: '捆绑超过 30%', at: Date.now() };
    if (why.length) return { ok: false, why: why.join('；'), facts };
    if (opt.noQuote) return { ok: true, why: '（回测）链上检查全部通过', facts };
    // 模拟买进马上卖：亏太多 = 税高或貔貅
    try { const W = WALLETS[0]; const px = await ethUsd(); if (!(px > 0)) return { ok: false, why: '读不到 ETH 价格', facts }; const eq = (RHC.usd / px).toFixed(6);
      const got = await quote(W, NATIVE, c, eq); if (!(got > 0)) return { ok: false, why: '买入报价失败', facts };
      const back2 = await quote(W, c, NATIVE, (got * 0.999).toPrecision(12)); const loss = 1 - back2 / Number(eq);
      facts.roundTrip = loss; if (!(back2 > 0) || loss > RHC.maxRoundTrip) return { ok: false, why: `模拟买进马上卖要亏 ${(loss * 100).toFixed(0)}%（税太高或卖不掉）`, facts };
    } catch (e) { return { ok: false, why: '模拟卖出失败（可能是貔貅）：' + e.message.slice(0, 60), facts }; }
    return { ok: true, why: '全部检查通过', facts };
  }

  async function ethBal(a) { return Number(big(await rpc('eth_getBalance', [a, 'latest']).catch(() => '0x0'))) / 1e18; }
  async function tokBal(c, a) { return big(await call(c, '0x70a08231' + wa(a))); }

  async function buy(c, sym, facts, manual, usdIn) { const USD = Number(usdIn) > 0 ? Number(usdIn) : RHC.usd;
    const px = await ethUsd(); if (!(px > 0)) return '读不到 ETH 价格';
    const res = [];
    for (const W of WALLETS) {
      if (!manual && spent(W.addr) + USD > RHC.dayUsd) { res.push(`[${W.name}] 今天额度用完`); continue; }
      const q = USD / px; const eb = await ethBal(W.addr); if (eb < q + 0.0003) { res.push(`[${W.name}] Robinhood 上的 ETH 不够（有 ${eb.toFixed(5)}，要 ${(q + 0.0003).toFixed(5)}）`); continue; }
      const b0 = await tokBal(c, W.addr);
      const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '4663', '--fromTokenQty', q.toFixed(6), '--fromToken', NATIVE, '--toToken', c, '--slippage', '15']);
      log(`[Robinhood][${W.name}] 买 ${sym}：${sw.t.slice(0, 300)}`);
      if (!sw.j?.success) { res.push(`[${W.name}] 买入失败：${String(sw.j?.error?.message || sw.t).slice(0, 80)}`); continue; }
      addSpent(W.addr, USD);
      let b1 = b0; for (let i = 0; i < 20 && b1 <= b0; i++) { await sleep(3000); b1 = await tokBal(c, W.addr); }
      const P = R.pos[c] || (R.pos[c] = { sym, at: Date.now(), w: {}, liq0: facts?.liq0 || 0, pool: facts?.pool, watch: facts?.bundle || [], supply: facts?.supply, lastB: 0, bundleSold: '0' });
      const w = P.w[W.addr] || (P.w[W.addr] = { cost: 0, peak: 0, stage: 0 }); w.cost += USD; save();
      res.push(`[${W.name}] ✅ 已买 ${USD}U`);
    }
    return res.join('\n');
  }

  async function sellPct(c, P, W, pct, why) {
    const b = await tokBal(c, W.addr); if (b <= 0n) return false; const d = await decimals(c);
    const amt = (b * BigInt(Math.round(pct * 100))) / 10000n; const qty = (Number(amt / 10n ** BigInt(Math.max(0, d - 6))) / 1e6).toFixed(6); if (!(Number(qty) > 0)) return false;
    const r = await W.baw(['market-order', 'swap', '--binanceChainId', '4663', '--fromTokenQty', qty, '--fromToken', c, '--toToken', NATIVE, '--slippage', '20']);
    log(`[Robinhood][${W.name}] 卖 ${P.sym} ${pct}%（${why}）：${r.t.slice(0, 300)}`);
    const ok = !!r.j?.success; R.trades = R.trades || []; R.trades.push({ sym: P.sym, c, w: W.addr, pct, why, ok, at: Date.now() }); if (R.trades.length > 2000) R.trades.splice(0, R.trades.length - 2000);
    await tg(`💰 [Robinhood][${W.name}] ${P.sym} ${ok ? '已卖' : '想卖但失败'} ${pct}%（${why}）\n${c}`).catch(() => {}); return ok;
  }

  // ── 持仓监控：每 15 秒 ──
  let monBusy = false;
  async function monitor() {
    if (monBusy) return; monBusy = true; try {
      const cs = Object.keys(R.pos); if (!cs.length) return; const info = await dsInfo(cs); const head = parseInt(await rpc('eth_blockNumber', []), 16);
      for (const c of cs) { const P = R.pos[c]; const I = info.get(c); let dump = '';
        // 捆绑钱包开始卖 → 先跑
        if (P.watch?.length && P.pool) { const fromB = P.lastB || head - 50; if (head > fromB) { try { const lg = await rpc('eth_getLogs', [{ fromBlock: '0x' + (fromB + 1).toString(16), toBlock: '0x' + head.toString(16), address: c, topics: [TRANSFER] }]); const ws = new Set(P.watch); let s = BigInt(P.bundleSold || '0'); for (const l of lg) { const f = lc('0x' + l.topics[1].slice(26)), t = lc('0x' + l.topics[2].slice(26)); if (ws.has(f) && t === P.pool) s += big(l.data); } P.bundleSold = s.toString(); P.lastB = head; if (P.supply && Number((s * 10000n) / BigInt(P.supply)) / 10000 > RHC.bundleSellPct) dump = '捆绑钱包开始砸盘'; } catch {} } }
        if (I && P.liq0 > 0 && I.liq < P.liq0 * (1 - RHC.lpDrop)) dump = `池子流动性掉了 ${Math.round((1 - I.liq / P.liq0) * 100)}%（可能在抽池）`;
        if (I && !P.liq0) P.liq0 = I.liq;
        for (const W of WALLETS) { const w = P.w[W.addr]; if (!w || w.closed) continue;
          if (dump) { if (await sellPct(c, P, W, 100, dump)) w.closed = 1; continue; }
          if (!I?.price) continue; const b = await tokBal(c, W.addr); if (b <= 0n) { w.closed = 1; continue; } const d = await decimals(c); const val = (Number(b / 10n ** BigInt(Math.max(0, d - 6))) / 1e6) * I.price; w.val = val; w.peak = Math.max(w.peak || 0, val); const x = val / (w.cost || 1);
          if (w.stage === 0 && x >= RHC.backX) { if (await sellPct(c, P, W, Math.min(100, Math.round(100 / x)), `${x.toFixed(1)} 倍，卖回本钱`)) w.stage = 1; continue; }
          const st = RHC.steps[w.stage - 1]; if (st && x >= st[0]) { if (await sellPct(c, P, W, st[1], `${st[0]} 倍分批卖`)) w.stage++; continue; }
          if (w.peak > 0 && val < w.peak * (1 - (w.stage ? RHC.crashAfterBack : RHC.crash))) { if (await sellPct(c, P, W, 100, `从最高点回落 ${Math.round((1 - val / w.peak) * 100)}%`)) w.closed = 1; }
        }
        if (Object.values(P.w).every((w) => w.closed)) { R.done = R.done || {}; R.done[c] = { ...P, endAt: Date.now() }; delete R.pos[c]; }
      } save();
    } catch (e) { log('[Robinhood] 监控出错 ' + e.message); } finally { monBusy = false; }
  }

  // ── 扫描：每 90 秒 ──
  let scanBusy = false;
  async function scan() {
    if (scanBusy) return; scanBusy = true; try {
      const cs = await candidates(); let n = 0;
      for (const p of cs) { if (n >= 3) break; if (R.pos[p.c]) continue; const o = R.seen[p.c]; if (o && (o.ok || (!o.retry && o.full)) && Date.now() - o.at < 10 * 60e3) continue; n++;
        const r = await analyze(p.c, p.pool).catch((e) => ({ ok: false, why: '检查出错：' + e.message.slice(0, 60) }));
        R.seen[p.c] = { sym: p.sym, at: Date.now(), why: r.why, ok: r.ok, full: 1, liq: p.liq, real: r.facts?.realBuyers, bundle: r.facts?.bundlePct, top10: r.facts?.top10 }; save();
        log(`[Robinhood] ${p.sym} ${p.c}：${r.why}`);
        if (r.ok) { const cs = globalThis.CUSTOM_SKIP?.({ chain: 'robinhood', type: 'token', c: p.c, sym: p.sym, liqUsd: p.liq, realBuyers: r.facts.realBuyers, bundlePct: r.facts.bundlePct * 100, top10Pct: r.facts.top10 * 100 }); if (cs) { R.seen[p.c].ok = false; R.seen[p.c].why = '自订规则不打：' + cs; log(`[Robinhood] ${p.sym} 自订规则不打：${cs}`); continue; } }
        if (r.ok) { if (radarOff() || RHC.auto === 0) { log(`[Robinhood] ${p.sym} 符合条件，但雷达设成暂停／不自动打`); continue; }
          if (Object.keys(R.pos).length >= RHC.maxPos) { log(`[Robinhood] ${p.sym} 符合条件，但已经持有 ${RHC.maxPos} 个，先不打`); continue; }
          r.facts.liq0 = p.liq; const msg = await buy(p.c, p.sym, r.facts);
          await tg(`💰 [Robinhood] 自动打 ${p.sym}\n真实买家 ${r.facts.realBuyers} 个｜捆绑 ${(r.facts.bundlePct * 100).toFixed(1)}%｜前10大 ${(r.facts.top10 * 100).toFixed(0)}%｜模拟来回亏 ${(r.facts.roundTrip * 100).toFixed(0)}%\n${msg}\n${p.c}`).catch(() => {}); }
      }
      for (const [c, o] of Object.entries(R.seen)) if (Date.now() - o.at > 86400e3) delete R.seen[c];
      save();
    } catch (e) { log('[Robinhood] 扫描出错 ' + e.message); } finally { scanBusy = false; }
  }

  // ── Robinhood 铸造项目（11/2）：扫链上「从 0 地址转出」= 铸造，很多不同的真人钱包自己付钱铸同一个新合约 → 列为铸造项目 ──
  const INFRA = new Set(['0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x58daec3116aae6d93017baaea7749052e8a04fa7', '0x73991a25c818bf1f1128deaab1492d45638de0d3', '0xbeeff033f34c046626b8d0a041844c5d1a5409dd', '0x07f44c47743a2f36414a82b9f558ecfcf0eedcef']); // WETH、Uniswap 仓位 NFT、金库份额 → 不是铸造项目
  R.mint = R.mint || {}; R.mintDay = R.mintDay || {};
  const strOf = (h) => { try { const b = Buffer.from(String(h).slice(2), 'hex'); if (b.length >= 96) { const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + Math.min(n, 64)).toString('utf8'); } return b.toString('utf8').replace(/\0/g, ''); } catch { return ''; } };
  let mintBusy = false;
  async function scanMints() {
    if (mintBusy) return; mintBusy = true; try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16); let from = R.mintLastB ? R.mintLastB + 1 : head - 3000; if (head - from > 40000) from = head - 40000;
      for (let a = from; a <= head; a += 2500) { const b = Math.min(head, a + 2499); let logs = []; try { logs = await rpc('eth_getLogs', [{ fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [TRANSFER, '0x' + '0'.repeat(64)] }]); } catch { continue; }
        const now = Date.now(); for (const l of logs) { const c = lc(l.address); if (INFRA.has(c)) continue; const to = lc('0x' + l.topics[2].slice(26)); if (to === ZERO) continue;
          const M = R.mint[c] || (R.mint[c] = { first: now, nft: l.topics.length === 4, n: 0, m: {}, tx: [] }); M.n++; M.last = now; if (!M.m[to]) M.m[to] = now; if (M.tx.length < 8 || Math.random() < 0.1) { M.tx.push(l.transactionHash); if (M.tx.length > 8) M.tx.shift(); } } }
      R.mintLastB = head;
      for (const [c, M] of Object.entries(R.mint)) { if (Date.now() - (M.last || 0) > 6 * 3600e3) { delete R.mint[c]; continue; } const ks = Object.keys(M.m); if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) delete M.m[k]; }
      { let k = 0; for (const [c, M] of Object.entries(R.mint)) { if (M.name !== undefined || Object.keys(M.m).length < 10) continue; if (++k > 25) break; M.name = strOf(await call(c, '0x06fdde03')).slice(0, 40); M.sym = strOf(await call(c, '0x95d89b41')).slice(0, 16); } } /* 面板上先显示名字，不用等深度检查 */
      const cands = Object.entries(R.mint).map(([c, M]) => [c, M, Object.values(M.m).filter((t) => Date.now() - t < RHC.mintWinMin * 60e3).length]).filter((x) => x[2] >= 10).sort((a, b) => b[2] - a[2]).slice(0, 4);
      for (const [c, M, recent] of cands) if (!M.chkAt || Date.now() - M.chkAt > 5 * 60e3) await checkMint(c, M, recent).catch((e) => log('[Robinhood 铸造] 检查出错 ' + e.message));
      save();
    } catch (e) { log('[Robinhood 铸造] 扫描出错 ' + e.message); } finally { mintBusy = false; }
  }
  async function checkMint(c, M, recent) {
    M.chkAt = Date.now();
    if (!M.name && M.name !== '') { M.name = strOf(await call(c, '0x06fdde03')).slice(0, 40); M.sym = strOf(await call(c, '0x95d89b41')).slice(0, 16); }
    if (/position|wrapped|vault|\blp\b|staked|receipt/i.test(M.name + ' ' + M.sym)) { M.why = '不是铸造项目（看起来是仓位／金库凭证）'; M.ok = false; return; }
    const minters = Object.entries(M.m).filter(([, t]) => Date.now() - t < RHC.mintWinMin * 60e3).map(([a]) => a).slice(-300);
    const res = await batch(minters.flatMap((a) => [['eth_getTransactionCount', [a, 'latest']], ['eth_getBalance', [a, 'latest']]]));
    let real = 0, fresh = 0; minters.forEach((a, i) => { const n = res[2 * i] == null ? -1 : parseInt(res[2 * i], 16), e = res[2 * i + 1] == null ? -1 : Number(big(res[2 * i + 1])) / 1e18; if (n >= RHC.oldNonce && e >= RHC.minEth) real++; if (n >= 0 && n <= RHC.freshNonce) fresh++; });
    M.real = real; M.recent = recent; M.freshPct = minters.length ? fresh / minters.length * 100 : 0;
    // 铸造方式：找一笔「自己付钱铸给自己」的交易当范本
    M.tpl = null; for (const h of [...M.tx].reverse()) { const tx = await rpc('eth_getTransactionByHash', [h]).catch(() => null); if (!tx || !tx.to) continue; const from = lc(tx.from); if (!M.m[from]) continue; const rc = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); const q = (rc?.logs || []).filter((l) => lc(l.address) === c && l.topics[0] === TRANSFER && l.topics[1] === '0x' + '0'.repeat(64) && lc('0x' + l.topics[2].slice(26)) === from).length || 1;
      M.tpl = { to: lc(tx.to), data: tx.input, value: BigInt(tx.value).toString(), from, q, viaOther: lc(tx.to) !== c }; break; }
    const px = await ethUsd(); M.priceUsd = M.tpl && px > 0 ? Number(BigInt(M.tpl.value)) / 1e18 * px / (M.tpl.q || 1) : null; M.costUsd = M.tpl && px > 0 ? Number(BigInt(M.tpl.value)) / 1e18 * px : null;
    const why = []; if (!M.tpl) why.push('找不到一般人自己铸造的交易（可能要白名单或签名）');
    if (real < RHC.mintMinReal) why.push(`${RHC.mintWinMin} 分钟内真人钱包 ${real} 个（要 ${RHC.mintMinReal} 个）`);
    if (M.freshPct > RHC.mintMaxFresh) why.push(`新开钱包占 ${M.freshPct.toFixed(0)}%（上限 ${RHC.mintMaxFresh}%，可能是项目方自己刷）`);
    if (M.costUsd != null && M.costUsd > RHC.mintUsd) why.push(`一次铸造要约 ${M.costUsd.toFixed(1)}U（超过设定 ${RHC.mintUsd}U）`);
    const cs = globalThis.CUSTOM_SKIP?.({ chain: 'robinhood', type: 'mint', c, name: M.name, sym: M.sym, realBuyers: real }); if (cs) why.push('自订规则：' + cs);
    M.ok = !why.length; M.why = why.join('；') || '符合条件';
    if (M.ok && RHC.mintAuto && RHC.auto !== 0 && !radarOff() && !M.done) await doMint(c, M, false);
  }
  async function doMint(c, M, manual, capU = 0) {
    if (!M.tpl) return '没有可以照着做的铸造方式';
    const px = await ethUsd(); const out = []; M.done = M.done || {};
    for (const W of WALLETS) { if (M.done[W.addr]) continue;
      const dd = day(); const sp = (R.mintDay[dd] || {})[W.addr] || 0; if (!manual && sp + (M.costUsd || 0) > RHC.mintDayUsd) { out.push(`[${W.name}] 今天铸造额度用完`); continue; }
      const data = String(M.tpl.data).toLowerCase().split(M.tpl.from.slice(2)).join(W.addr.slice(2)); // 范本里如果写了对方的地址，换成我们自己的
      const val = BigInt(M.tpl.value); if (await ethBal(W.addr) < Number(val) / 1e18 + 0.0003) { out.push(`[${W.name}] Robinhood 上的 ETH 不够`); continue; }
      const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '4663', '--from', W.addr, '--to', M.tpl.to, '--value', val.toString(), '--inputData', data]);
      const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId; if (!p.j?.success || !rid) { out.push(`[${W.name}] 预演失败：${String(p.j?.error?.message || p.t).slice(0, 80)}`); continue; }
      const got = (sim?.balanceChanges || []).some((b) => lc(b.owner) === W.addr && lc(b.contractAddress) === c && Number(b.change) > 0) || (sim?.nftChanges || sim?.erc721Changes || []).length > 0;
      const ethOut = (sim?.balanceChanges || []).filter((b) => lc(b.owner) === W.addr && lc(b.contractAddress).startsWith('0xeeee') && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0);
      if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) { out.push(`[${W.name}] ⛔ 预演发现会授权或交出钱包权限，不铸（防盗）`); log(`[Robinhood 铸造] ${M.name || c} 预演有授权／权限变化，挡下`); continue; } /* 11/2 BDOG 被盗事件：有授权就不铸，手动也一样 */
      if ((sim?.balanceChanges || []).some((b) => lc(b.owner) === W.addr && !lc(b.contractAddress).startsWith('0xeeee') && Number(b.change) < 0)) { out.push(`[${W.name}] ⛔ 预演显示会扣你别的币，不铸`); continue; }
      if (!manual && !got) { out.push(`[${W.name}] 预演看不到我们会拿到东西，不铸`); continue; }
      if (px > 0 && ethOut * px > (capU > 0 ? capU : Math.max(RHC.mintUsd, M.costUsd || 0) * 1.1 + 0.5)) { out.push(`[${W.name}] 预演要花 ${(ethOut * px).toFixed(1)}U，超过${capU > 0 ? '你这次填的 ' + capU + 'U' : '预期'}，不铸`); continue; }
      const x = await W.baw(['contract-call', 'execute', '--requestId', rid]); log(`[Robinhood 铸造][${W.name}] ${M.name || c}：${String(x.t).slice(0, 200)}`);
      if (!x.j?.success) { out.push(`[${W.name}] 送出失败：${String(x.j?.error?.message || x.t).slice(0, 80)}`); continue; }
      M.done[W.addr] = Date.now(); const cu = px > 0 ? Number(val) / 1e18 * px : 0; R.mintDay = { [dd]: { ...(R.mintDay[dd] || {}), [W.addr]: sp + cu } };
      if (!M.nft) { const P = R.pos[c] || (R.pos[c] = { sym: M.sym || M.name, at: Date.now(), w: {}, liq0: 0, watch: [], lastB: 0, bundleSold: '0' }); const w = P.w[W.addr] || (P.w[W.addr] = { cost: 0, peak: 0, stage: 0 }); w.cost += cu; } // 代币型：开盘后照卖出规则管
      (R.mintLog = R.mintLog || []).push({ c, sym: M.sym || M.name, w: W.addr, usd: +cu.toFixed(2), nft: M.nft, at: Date.now() }); out.push(`[${W.name}] ✅ 已铸造${cu ? `（约 ${cu.toFixed(2)}U）` : ''}`);
    }
    save(); const msg = out.join('\n'); await tg(`💰 [Robinhood] ${manual ? '手动' : '自动'}铸造 ${M.name || ''}（${M.sym || ''}）\n真人钱包 ${M.real} 个｜新开钱包 ${M.freshPct?.toFixed(0)}%\n${msg}\n${c}${M.nft ? '\n（这是 NFT，雷达不会自动卖，要卖请自己到市场挂单）' : ''}`).catch(() => {}); return msg;
  }
  async function previewMint(c) { c = lc(c); const M = R.mint[c]; if (!M) return { err: '没看到' }; if (!M.tpl) await checkMint(c, M, 0).catch(() => {}); if (!M.tpl) return { err: '没范本', why: M.why }; const W = WALLETS[0]; const data = String(M.tpl.data).toLowerCase().split(M.tpl.from.slice(2)).join(W.addr.slice(2));
    const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '4663', '--from', W.addr, '--to', M.tpl.to, '--value', String(M.tpl.value), '--inputData', data]); return { tpl: M.tpl, raw: String(p.t).slice(0, 4000) }; } /* 只预演、不送出（测试用） */
  async function manualMint(c, capU) { c = lc(c); const M = R.mint[c]; if (!M) return '雷达还没看到这个铸造项目'; if (!M.tpl) await checkMint(c, M, 0).catch(() => {}); return await doMint(c, M, true, Number(capU) || 0); }
  const t3 = setInterval(() => { scanMints(); }, 60e3); t3.unref?.(); setTimeout(scanMints, 25e3);
  if (ctx.noLoop) return { analyze, RHC };
  const PCT = new Set(['maxBundle', 'maxTop10', 'maxDev', 'maxRoundTrip', 'lpDrop', 'bundleSellPct', 'crash', 'crashAfterBack']);
  const RDEF = { ...RHC };
  function apply(set, schema) { Object.assign(RHC, RDEF); for (const it of schema || []) { if (!it.k.startsWith('rh.')) continue; const n = it.k.slice(3); let x = set[it.k]; if (x == null || x === '') continue; x = Number(x); if (!Number.isFinite(x)) continue; x = Math.min(it.max, Math.max(it.min, x)); RHC[n] = PCT.has(n) ? x / 100 : x; } }
  const t1 = setInterval(() => { scan(); }, 90e3); const t2 = setInterval(() => { monitor(); }, 15e3); t1.unref?.(); t2.unref?.(); setTimeout(scan, 15e3);
  log('[Robinhood] 自动打启动');
  async function manualBuy(c, usd) { c = lc(c); const r = await analyze(c, null, true).catch((e) => ({ ok: false, why: e.message })); if (!r.ok) return '❌ 挡下了：' + r.why; const I = (await dsInfo([c])).get(c); r.facts.liq0 = I?.liq || 0; return await buy(c, I?.sym || c.slice(0, 8), r.facts, true, usd); }
  async function manualSell(c, pct = 100, only = '') { c = lc(c); pct = Math.min(100, Math.max(1, Number(pct) || 100)); const P = R.pos[c]; if (!P) return '没有这个 Robinhood 持仓'; const out = []; for (const W of WALLETS) { if (only && lc(only) !== W.addr) continue; const w = P.w[W.addr]; if (!w || w.closed) continue; const ok = await sellPct(c, P, W, pct, `你在雷达按了卖 ${pct}%`); if (ok && pct >= 100) w.closed = 1; out.push(`[${W.name}] ${ok ? '✅ 已卖' : '❌ 没卖成'}`); } if (Object.values(P.w).every((w) => w.closed)) { R.done = R.done || {}; R.done[c] = { ...P, endAt: Date.now() }; delete R.pos[c]; } save(); return out.join('\n') || '没有可卖的'; }
  return { manualBuy, manualSell, manualMint, previewMint, analyze, RHC, apply, ethBal, ethUsd };
}
