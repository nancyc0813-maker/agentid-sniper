// 罗宾猫雷达 · BSC NFT 铸造（11/2）：扫 BSC 上的 NFT 铸造（ERC721／ERC1155 从 0 地址转出），很多不同的真人钱包自己付钱铸同一个 NFT → 列到面板
// 防盗：一律先在币安钱包预演，有授权、交出钱包权限、扣别的币 → 不铸（手动也一样）。全部本地跑。
const T721 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', T1155 = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62', Z64 = '0x' + '0'.repeat(64);
const lc = (x) => String(x || '').toLowerCase();
export function startBscNft({ rpc, rpcBatch, WALLETS, log, tg, S, save, radarOff, radarSet, previewExec, bnbUsd }) {
  const N = S.bscNft = S.bscNft || { m: {}, day: {}, log: [] }; N.m = N.m || {}; N.day = N.day || {}; N.log = N.log || [];
  const C = () => { const z = radarSet(); const g = (k, d) => { const v = Number(z['bscnft.' + k]); return Number.isFinite(v) && z['bscnft.' + k] != null ? v : d; }; return { auto: g('auto', 0), usd: g('usd', 5), dayUsd: g('dayUsd', 20), minReal: g('minReal', 50), winMin: g('winMin', 60), maxFresh: g('maxFresh', 15), oldNonce: g('oldNonce', 8), minBnb: g('minBnb', 0.005) }; };
  const strOf = (h) => { try { const b = Buffer.from(String(h).slice(2), 'hex'); if (b.length >= 96) { const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + Math.min(n, 64)).toString('utf8'); } return b.toString('utf8').replace(/\0/g, ''); } catch { return ''; } };
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => '0x');
  const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  let busy = false;
  async function scan() {
    if (busy) return; busy = true; try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16); let from = N.last ? N.last + 1 : head - 400; if (head - from > 1600) from = head - 1600;
      for (let a = from; a <= head; a += 400) { const b = Math.min(head, a + 399); const q = (topics) => rpc('eth_getLogs', [{ fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics }]).catch(() => []);
        const L = [...(await q([T721, Z64])).filter((l) => l.topics.length === 4).map((l) => [l, l.topics[2]]), ...(await q([T1155, null, Z64])).map((l) => [l, l.topics[3]])];
        const now = Date.now(); for (const [l, toT] of L) { const c = lc(l.address); const to = lc('0x' + toT.slice(26)); const M = N.m[c] || (N.m[c] = { first: now, n: 0, m: {}, tx: [] }); M.n++; M.last = now; if (!M.m[to]) M.m[to] = now; if (M.tx.length < 8 || Math.random() < 0.1) { M.tx.push(l.transactionHash); if (M.tx.length > 8) M.tx.shift(); } } }
      N.last = head;
      for (const [c, M] of Object.entries(N.m)) { if (Date.now() - (M.last || 0) > 6 * 3600e3) { delete N.m[c]; continue; } const ks = Object.keys(M.m); if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) delete M.m[k]; }
      let k = 0; for (const [c, M] of Object.entries(N.m)) { if (M.name !== undefined || Object.keys(M.m).length < 10) continue; if (++k > 25) break; M.name = strOf(await call(c, '0x06fdde03')).slice(0, 40); M.sym = strOf(await call(c, '0x95d89b41')).slice(0, 16); }
      const cf = C(); const cands = Object.entries(N.m).map(([c, M]) => [c, M, Object.values(M.m).filter((t) => Date.now() - t < cf.winMin * 60e3).length]).filter((x) => x[2] >= 10).sort((a, b) => b[2] - a[2]).slice(0, 4);
      for (const [c, M, recent] of cands) if (!M.chkAt || Date.now() - M.chkAt > 5 * 60e3) await check(c, M, recent).catch((e) => log('[BSC NFT] 检查出错 ' + e.message));
      save();
    } catch (e) { log('[BSC NFT] 扫描出错 ' + e.message); } finally { busy = false; }
  }
  async function check(c, M, recent) {
    const cf = C(); M.chkAt = Date.now(); M.recent = recent;
    const minters = Object.entries(M.m).filter(([, t]) => Date.now() - t < cf.winMin * 60e3).map(([a]) => a).slice(-300);
    const res = await rpcBatch(minters.flatMap((a) => [{ method: 'eth_getTransactionCount', params: [a, 'latest'] }, { method: 'eth_getBalance', params: [a, 'latest'] }]));
    if (res.filter((x) => x != null).length < minters.length) { for (let i = 0; i < Math.min(minters.length, 120); i++) { if (res[2 * i] == null) res[2 * i] = await rpc('eth_getTransactionCount', [minters[i], 'latest']).catch(() => null); if (res[2 * i + 1] == null) res[2 * i + 1] = await rpc('eth_getBalance', [minters[i], 'latest']).catch(() => null); } } /* 批次查询被挡时改一个一个查，不会误判成 0 个真人 */
    if (minters.length && res.filter((x) => x != null).length < minters.length * 0.5) { M.real = null; M.ok = false; M.why = '暂时读不到钱包资料，稍后再查'; M.chkAt = Date.now() - 4 * 60e3; return; }
    let real = 0, fresh = 0; minters.forEach((a, i) => { const n = res[2 * i] == null ? -1 : parseInt(res[2 * i], 16), e = res[2 * i + 1] == null ? -1 : Number(BigInt(res[2 * i + 1])) / 1e18; if (n >= cf.oldNonce && e >= cf.minBnb) real++; if (n >= 0 && n <= 3) fresh++; });
    M.real = real; M.freshPct = minters.length ? fresh / minters.length * 100 : 0;
    M.tpl = null; for (const h of [...M.tx].reverse()) { const tx = await rpc('eth_getTransactionByHash', [h]).catch(() => null); if (!tx || !tx.to) continue; const from = lc(tx.from); if (!M.m[from]) continue; M.tpl = { to: lc(tx.to), data: tx.input, value: BigInt(tx.value).toString(), from }; break; }
    const px = await bnbUsd().catch(() => 0); M.costUsd = M.tpl && px > 0 ? Number(BigInt(M.tpl.value)) / 1e18 * px : null;
    const why = []; if (!M.tpl) why.push('找不到一般人自己铸造的交易（可能要白名单或签名）');
    if (/^0x(095ea7b3|39509351|a22cb465|d505accf)/i.test(M.tpl?.data || '')) why.push('铸造交易里有授权动作，不碰');
    if (real < cf.minReal) why.push(`${cf.winMin} 分钟内真人钱包 ${real} 个（要 ${cf.minReal} 个）`);
    if (M.freshPct > cf.maxFresh) why.push(`新开钱包占 ${M.freshPct.toFixed(0)}%（上限 ${cf.maxFresh}%）`);
    if (M.costUsd != null && M.costUsd > cf.usd) why.push(`一次约 ${M.costUsd.toFixed(2)}U（超过设定 ${cf.usd}U）`);
    const cs = globalThis.CUSTOM_SKIP?.({ chain: 'bsc', type: 'mint', c, name: M.name, sym: M.sym, realBuyers: real }); if (cs) why.push('自订规则：' + cs);
    M.ok = !why.length; M.why = why.join('；') || '符合条件';
    if (M.ok && cf.auto && !radarOff() && !M.done) await mint(c, M, false);
  }
  async function mint(c, M, manual, capU = 0) {
    if (!M.tpl) return '没有可以照着做的铸造方式'; const cf = C(); const px = await bnbUsd().catch(() => 0); const out = []; M.done = M.done || {};
    for (const W of WALLETS) { if (M.done[W.addr]) continue; const sp = (N.day[day()] || {})[W.addr] || 0; if (!manual && sp + (M.costUsd || 0) > cf.dayUsd) { out.push(`[${W.name}] 今天额度用完`); continue; }
      const data = String(M.tpl.data).toLowerCase().split(M.tpl.from.slice(2)).join(W.addr.slice(2)); const val = BigInt(M.tpl.value); if (capU > 0 && px > 0 && (Number(val) / 1e18) * px > capU) { out.push(`[${W.name}] 一次要约 ${((Number(val) / 1e18) * px).toFixed(2)}U，超过你这次填的 ${capU}U，没铸`); continue; }
      try { await previewExec(W, M.tpl.to, data, val, (sim) => { if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '⛔ 会授权或交出钱包权限（防盗）'; const mine = (sim?.balanceChanges || []).filter((b) => lc(b.owner) === W.addr); if (mine.some((b) => !lc(b.contractAddress).startsWith('0xeeee') && Number(b.change) < 0)) return '⛔ 会扣你别的币'; if (!mine.some((b) => lc(b.contractAddress) === c && Number(b.change) > 0)) return '预演看不到会拿到 NFT'; return ''; }, null, { manual });
        M.done[W.addr] = Date.now(); const cu = px > 0 ? Number(val) / 1e18 * px : 0; N.day = { [day()]: { ...(N.day[day()] || {}), [W.addr]: sp + cu } }; N.log.push({ c, sym: M.sym || M.name, w: W.addr, usd: +cu.toFixed(2), at: Date.now() }); if (N.log.length > 2000) N.log.splice(0, N.log.length - 2000); out.push(`[${W.name}] ✅ 已铸造${cu ? `（约 ${cu.toFixed(2)}U）` : ''}`);
      } catch (e) { out.push(`[${W.name}] ${e.message.slice(0, 80)}`); } }
    save(); const msg = out.join('\n'); await tg(`💰 [BSC NFT] ${manual ? '手动' : '自动'}铸造 ${M.name || ''}\n真人钱包 ${M.real ?? '-'} 个\n${msg}\n${c}\n（NFT 雷达不会自动卖，要卖请自己到市场挂单）`).catch(() => {}); return msg;
  }
  async function manualMint(c, capU) { c = lc(c); const M = N.m[c]; if (!M) return '雷达还没看到这个 NFT 铸造'; if (!M.tpl) await check(c, M, 0).catch(() => {}); return mint(c, M, true, Number(capU) || 0); }
  setInterval(scan, 60e3).unref(); setTimeout(scan, 30e3); log('[BSC NFT] 铸造监测启动');
  return { manualMint };
}
