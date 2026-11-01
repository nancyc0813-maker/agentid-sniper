// BSC 代币深度检查（11/2 她：「当然要补」）：捆绑比例、前 10 大持有、真实买家
// 跟 Robinhood 同一套算法，但 BSC 的公开节点一次只能查一小段区块，所以：
//   1) 只看最近 6 小时的转帐纪录（AI 热门代币本来就只看 3 天内的新币）
//   2) 持有量用 balanceOf 直接问链上（不是用转帐纪录推算），比较准
// 只读链上资料，不会送任何交易。
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const lc = (x) => String(x || '').toLowerCase();
const big = (h) => { try { return h && h !== '0x' ? BigInt(h) : 0n; } catch { return 0n; } };
const wa = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');

export function makeBscAnalyze({ rpc, rpcBatch, log = () => {} }) {
  const BPS = 2.2; // BSC 约 0.45 秒一个区块
  const CACHE = new Map();
  /* 11/2 反向抓错：工具的 rpc() 会轮流试好几个节点、每个等 12 秒，有的节点不支援查纪录 → 一次检查拖到 40 秒以上。查纪录改成直接问支援的节点、6 秒没回就换下一个 */
  const LOG_NODES = ['https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com'];
  async function getLogs(params) { let last; for (const u of LOG_NODES) { try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params }), signal: AbortSignal.timeout(6000) })).json(); if (j.error) { last = new Error(j.error.message); if (/limit|range|too many|exceed/i.test(j.error.message)) throw last; continue; } return j.result; } catch (e) { last = e; if (/limit|range|too many|exceed/i.test(e.message)) throw e; } } return await rpc('eth_getLogs', params).catch(() => { throw last; }); }
  async function seg(c, a, b, topics, depth = 0) { /* 一段查不了（结果太多）就切半再查 */
    try { return (await getLogs([{ fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), address: c, topics }])) || []; }
    catch (e) { if (depth > 2 || b - a < 200) throw e; const m = Math.floor((a + b) / 2); return [...await seg(c, a, m, topics, depth + 1), ...await seg(c, m + 1, b, topics, depth + 1)]; } }
  async function logsOf(c, from, to, topics = [TRANSFER], maxLogs = 8000) { /* 11/2 她嫌慢：6 段同时查（以前一段一段排队） */
    const parts = []; for (let b = to; b >= from; b -= 2000) parts.push([Math.max(from, b - 1999), b]); /* 从最新往回查 */
    const out = new Array(parts.length); let k = 0, total = 0; const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, async () => { while (k < parts.length && total < maxLogs && Date.now() - t0 < 12e3) { const n = k++; out[n] = await seg(c, parts[n][0], parts[n][1], topics).catch(() => []); total += out[n].length; } }));
    return out.filter(Boolean).reverse().flat(); /* 交易很热的币：查到 2 万笔或 20 秒就停（只看最近那一段） */
  }
  async function analyze(c, poolHint, opt = {}) {
    c = lc(c); const ck = CACHE.get(c); if (ck && Date.now() - ck.at < (opt.maxAgeMs ?? 120e3)) return ck.v;
    const head = parseInt(await rpc('eth_blockNumber', []), 16); const from = head - Math.ceil(BPS * 3600 * 6);
    const raw = await logsOf(c, from, head);
    if (!raw.length) return { ok: false, why: '最近 6 小时没有转帐纪录' };
    const tf = raw.filter((l) => l.topics?.length >= 3).map((l) => ({ from: lc('0x' + l.topics[1].slice(26)), to: lc('0x' + l.topics[2].slice(26)), v: big(l.data), b: parseInt(l.blockNumber, 16), tx: l.transactionHash }));
    const supply = big(await rpc('eth_call', [{ to: c, data: '0x18160ddd' }, 'latest']).catch(() => '0x'));
    if (supply <= 0n) return { ok: false, why: '读不到总量' };
    // 池子 = 出现在最多笔交易里的转出方
    const cnt = new Map(); for (const t of tf) if (t.from !== ZERO) cnt.set(t.from, (cnt.get(t.from) || new Set()).add(t.tx));
    let pool = /^0x[0-9a-f]{40}$/.test(lc(poolHint)) ? lc(poolHint) : null; if (!pool || !cnt.has(pool)) pool = [...cnt.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0];
    const byTx = new Map(); for (const t of tf) { if (!byTx.has(t.tx)) byTx.set(t.tx, []); byTx.get(t.tx).push(t); }
    const buys = [];
    for (const arr of byTx.values()) { const net = new Map(); for (const t of arr) { net.set(t.from, (net.get(t.from) || 0n) - t.v); net.set(t.to, (net.get(t.to) || 0n) + t.v); }
      if ((net.get(pool) || 0n) < 0n) { const [who, v] = [...net.entries()].filter(([a, x]) => a !== pool && a !== ZERO && a !== c && x > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] || []; if (who) buys.push({ who, v, b: arr[0].b }); } }
    // 真实持有量：直接问链上
    const recv = new Map(); for (const t of tf) if (t.to !== ZERO && t.to !== DEAD) recv.set(t.to, (recv.get(t.to) || 0n) + t.v);
    const cand = [...recv.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 600).map(([a]) => a);
    const bals = await rpcBatch(cand.map((a) => ({ method: 'eth_call', params: [{ to: c, data: '0x70a08231' + wa(a) }, 'latest'] })));
    const bal = new Map(cand.map((a, i) => [a, big(bals[i])]));
    const skipA = new Set([pool, ZERO, DEAD, c]);
    const holders = [...bal.entries()].filter(([a, v]) => v > 0n && !skipA.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    const pct = (v) => Number((v * 10000n) / supply) / 10000;
    const top10 = pct(holders.slice(0, 10).reduce((s, [, v]) => s + v, 0n));
    const share = (set) => pct([...set].reduce((s, a) => s + (bal.get(a) > 0n ? bal.get(a) : 0n), 0n));
    // 开盘那几个区块一起买的（只有池子是这 6 小时内开的才算得出来）
    let early = new Set(); let poolNew = false;
    if (pool && buys.length) { const firstB = Math.min(...buys.map((x) => x.b)); const pc = await rpc('eth_getCode', [pool, '0x' + Math.max(0, from).toString(16)]).catch(() => '0x1'); poolNew = !pc || pc === '0x'; if (poolNew) early = new Set(buys.filter((x) => x.b <= firstB + 7).map((x) => x.who)); }
    // 钱包新旧
    const hourAgo = head - Math.ceil(BPS * 3600);
    const recentBuyers = [...new Set(buys.filter((x) => x.b >= hourAgo).map((x) => x.who))].slice(0, 300);
    const chk = [...new Set([...recentBuyers, ...holders.slice(0, 50).map(([a]) => a)])];
    const nn = await rpcBatch(chk.map((a) => ({ method: 'eth_getTransactionCount', params: [a, 'latest'] })));
    const N = new Map(chk.map((a, i) => [a, nn[i] == null ? -1 : parseInt(nn[i], 16)]));
    const bb = await rpcBatch(recentBuyers.map((a) => ({ method: 'eth_getBalance', params: [a, 'latest'] })));
    const EB = new Map(recentBuyers.map((a, i) => [a, bb[i] == null ? -1 : Number(big(bb[i])) / 1e18]));
    const realBuyers = recentBuyers.filter((a) => N.get(a) >= 8 && EB.get(a) >= 0.005).length; /* 真人 = 交易 8 次以上＋钱包里真的有 BNB */
    const fresh = new Set(holders.slice(0, 50).map(([a]) => a).filter((a) => N.get(a) >= 0 && N.get(a) <= 3));
    const grp = new Map(); for (const x of buys) { const s = x.v.toString(); const k = s.length + ':' + s.slice(0, 2); if (!grp.has(k)) grp.set(k, new Set()); grp.get(k).add(x.who); }
    const same = new Set(); for (const g of grp.values()) if (g.size >= 5) g.forEach((a) => same.add(a));
    const bundle = new Set([...early, ...fresh, ...same]); bundle.delete(pool);
    const v = { ok: true, facts: { bundlePct: share(bundle), top10, realBuyers, buyers1h: recentBuyers.length, freshTop50: fresh.size, sameAmt: same.size, early: early.size, poolNew, pool, holdersSeen: holders.length } };
    CACHE.set(c, { at: Date.now(), v }); if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);
    return v;
  }
  // 铸造进度走势（她 11/2 03:24「线图都没波动」）：直接用链上的铸造纪录（从 0 地址转出）还原最近 6 小时每 10 分钟累计铸了多少
  const MT = new Map();
  async function mintTimeline(c, nowProg) {
    { const k = MT.get(lc(c)); if (k && Date.now() - k.at < 90e3) return k.v; }
    c = lc(c); let tok = c; try { const r = await rpc('eth_call', [{ to: c, data: '0xfc0c546a' }, 'latest']); if (r && r.length >= 66 && big(r.slice(0, 66)) > 0n) tok = '0x' + r.slice(26, 66); } catch {}
    const head = parseInt(await rpc('eth_blockNumber', []), 16); const from = head - Math.ceil(BPS * 3600 * 6); const now = Date.now();
    const raw = await logsOf(tok, from, head, [TRANSFER, '0x' + '0'.repeat(64)]);
    const ev = raw.map((l) => ({ b: parseInt(l.blockNumber, 16), to: lc('0x' + String(l.topics?.[2] || '').slice(26)), v: 1n })); /* 算「铸造次数」（不管 NFT 还是代币都一样好懂） */
    if (!ev.length) return { pts: [], n: 0 };
    const tOf = (b) => now - ((head - b) / BPS) * 1000; const BK = 10 * 60e3; const t0 = tOf(from);
    let i = 0;
    let cum2 = 0n; i = 0; const out = []; const seen2 = new Set();
    for (let t = t0 + BK; t <= now + BK; t += BK) { while (i < ev.length && tOf(ev[i].b) <= t) { cum2 += ev[i].v; seen2.add(ev[i].to); i++; } out.push({ t: Math.min(t, now), n: Number(cum2), w: seen2.size }); }
    const v = { pts: out, n: ev.length, tok, nft: raw.some((l) => l.topics?.length >= 4) }; MT.set(c, { at: Date.now(), v }); if (MT.size > 200) MT.delete(MT.keys().next().value); return v;
  }
  return { analyze, mintTimeline };
}
