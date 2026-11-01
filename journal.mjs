// 罗宾猫雷达 · 交易日记：每一笔买卖都记下来（data/journal.jsonl），用户在雷达「持仓 → 交易日记」自己查询、汇出
// 做法：每 10 秒比对一次状态（持仓成本变多 = 买、卖出纪录变多 = 卖），所以不管是哪个功能下的单都记得到
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function startJournal({ DIR, S, save, WALLETS, log, tg }) {
  const F = join(DIR, 'data', 'journal.jsonl');
  const wn = (a) => (WALLETS.find((w) => w.addr === a) || {}).name || (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const put = (r) => { try { appendFileSync(F, JSON.stringify({ at: Date.now(), ...r }) + '\n'); } catch (e) { log('日记写入失败 ' + e.message); } };
  function snap() {
    const tk = (t) => t ? [t.at, t.sym, t.w, t.usd].join('|') : ''; const last = (a) => tk((a || [])[(a || []).length - 1]);
    const o = { dyn: {}, btK: last(S.trades), rhK: last(S.rh?.trades), rmK: last(S.rh?.mintLog), bnK: last(S.bscNft?.log), plK: {} };
    for (const t of S.dyn || []) o.dyn[t.addr + '|' + t.only] = +(t.cost || 0);
    for (const [c, P] of Object.entries(S.rh?.pos || {})) for (const [a, w] of Object.entries(P.w || {})) o.rh[c + '|' + a] = +(w.cost || 0);
    for (const [id, p] of Object.entries(S.plug || {})) o.plK[id] = last(p.trades);
    return o;
  }
  if (!S.jPrev) { // 第一次：把以前的卖出纪录和现有持仓补进日记
    for (const t of S.trades || []) put({ at: Date.parse(String(t.at).replace(/\//g, '-')) || Date.now(), chain: 'BSC', src: '雷达', side: '卖', sym: t.sym, wallet: t.w, usd: t.usd, got: t.bnb ? t.bnb + ' BNB' : '', note: t.why || '', cost: t.cost || 0, old: 1 });
    for (const t of S.dyn || []) if (t.cost > 0) put({ at: t.boughtAt || Date.now(), chain: 'BSC', src: '雷达', side: '买', sym: t.sym, token: t.addr, wallet: wn(t.only), usd: +t.cost, note: '（补登）', old: 1 });
    S.jPrev = snap(); save(); log('交易日记：已补登以前的纪录');
  }
  const after = (a, k) => { a = a || []; if (!k) return a; for (let i = a.length - 1; i >= 0; i--) if ([a[i].at, a[i].sym, a[i].w, a[i].usd].join('|') === k) return a.slice(i + 1); return a.slice(-5); }; /* 用最后一笔的内容对，不用位置，旧纪录被裁掉也不会漏记 */
  function tick() { try {
    const P = S.jPrev, N = snap();
    for (const t of S.dyn || []) { const k = t.addr + '|' + t.only; const d = +(t.cost || 0) - (P.dyn[k] || 0); if (d > 0.001) put({ chain: 'BSC', src: '雷达', side: '买', sym: t.sym, token: t.addr, wallet: wn(t.only), usd: +d.toFixed(2) }); }
    for (const t of P.btK === undefined ? (S.trades || []).slice(P.bt || 0) : after(S.trades, P.btK)) put({ chain: 'BSC', src: '雷达', side: '卖', sym: t.sym, wallet: t.w, usd: t.usd, got: t.bnb ? t.bnb + ' BNB' : '', note: t.why || '' });
    for (const [c, Q] of Object.entries(S.rh?.pos || {})) for (const [a, w] of Object.entries(Q.w || {})) { const d = +(w.cost || 0) - (P.rh[c + '|' + a] || 0); if (d > 0.001) put({ chain: 'Robinhood', src: '雷达', side: '买', sym: Q.sym, token: c, wallet: wn(a), usd: +d.toFixed(2) }); }
    for (const t of P.rhK === undefined ? (S.rh?.trades || []).slice(P.rht || 0) : after(S.rh?.trades, P.rhK)) put({ chain: 'Robinhood', src: '雷达', side: '卖', sym: t.sym, token: t.c, wallet: wn(t.w), usd: t.usd ?? null, note: `${t.pct}%｜${t.why}${t.ok ? '' : '（失败）'}` });
    if (P.rmK !== undefined) for (const t of after(S.rh?.mintLog, P.rmK).filter((x) => x.nft)) put({ chain: 'Robinhood', src: '雷达 铸造', side: '买', sym: t.sym, token: t.c, wallet: wn(t.w), usd: t.usd, note: t.nft ? 'NFT' : '' });
    if (P.bnK !== undefined) for (const t of after(S.bscNft?.log, P.bnK)) put({ chain: 'BSC', src: '雷达 NFT 铸造', side: '买', sym: t.sym, token: t.c, wallet: wn(t.w), usd: t.usd, note: 'NFT' });
    for (const [id, p] of Object.entries(S.plug || {})) for (const t of P.plK === undefined ? (p.trades || []).slice((P.pl || {})[id] || 0) : after(p.trades, P.plK[id])) put({ chain: 'BSC', src: '外挂 ' + id, side: t.side, sym: t.sym, wallet: wn(t.w), usd: t.usd, got: t.got || '', stable: t.stable || '' });
    S.jPrev = N; save();
  } catch (e) { log('日记出错 ' + e.message); } }
  setInterval(tick, 10e3).unref();
  // ── 每周检讨（全部本地算，不用 AI）：每周一早上 9 点，用日记统计上周，TG 发给用户 ──
  function weekly(force) { try {
    const tp = new Date(Date.now() + 8 * 3600e3); const key = tp.toISOString().slice(0, 10);
    if (!force && (tp.getUTCDay() !== 1 || tp.getUTCHours() !== 9 || S.weeklyAt === key)) return; S.weeklyAt = key; save();
    const since = Date.now() - 7 * 86400e3; const rows = readFileSync(F, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && !x.old && x.at >= since);
    const by = {}; for (const x of rows) { const k = (x.chain || '') + '|' + (x.token || x.sym); const o = by[k] || (by[k] = { sym: x.sym, chain: x.chain, src: x.src, buy: 0, sell: 0, notes: [] }); if (x.side === '买') o.buy += +x.usd || 0; else { o.sell += +x.usd || 0; if (x.note) o.notes.push(x.note); } }
    const list = Object.values(by).filter((o) => o.buy > 0); const closed = list.filter((o) => o.sell > 0); const win = closed.filter((o) => o.sell >= o.buy).length;
    const B = list.reduce((a, o) => a + o.buy, 0), Sx = rows.filter((x) => x.side === '卖').reduce((a, x) => a + (+x.usd || 0), 0);
    const best = [...closed].sort((a, b) => b.sell - b.buy - (a.sell - a.buy))[0], worst = [...closed].sort((a, b) => a.sell - a.buy - (b.sell - b.buy))[0];
    const tips = []; const n = (re) => rows.filter((x) => re.test(x.note || '')).length;
    if (n(/捆绑|抽池/) >= 2) tips.push('Robinhood 有好几笔是被捆绑钱包砸盘或抽池才跑掉的 → 可以把「捆绑钱包最多持有」调低一点');
    if (n(/回落/) >= 3 && win / Math.max(1, closed.length) < 0.4) tips.push('很多笔是从高点回落才卖、而且胜率偏低 → 可以把「回本前回落全卖」调小，早一点停损');
    if (closed.length >= 5 && win / closed.length >= 0.6) tips.push('胜率不错，想多赚可以把每笔金额调高一点（风险也会变大）');
    if (!rows.length) tips.push('这周没有交易：门槛可能太严，或雷达没在跑');
    const msg = `📊 罗宾猫雷达 · 每周检讨（${new Date(since + 8 * 3600e3).toISOString().slice(5, 10)}～${key.slice(5)}）\n交易 ${rows.length} 笔｜买进 ${B.toFixed(1)}U｜卖出拿回 ${Sx.toFixed(1)}U\n已结束的 ${closed.length} 个，赚的 ${win} 个（胜率 ${closed.length ? Math.round(win / closed.length * 100) : 0}%）` + (best ? `\n最赚：${best.sym} ${(best.sell - best.buy >= 0 ? '+' : '')}${(best.sell - best.buy).toFixed(1)}U` : '') + (worst && worst !== best ? `\n最亏：${worst.sym} ${(worst.sell - worst.buy).toFixed(1)}U` : '') + (tips.length ? '\n\n建议（要改的话到「设定」自己改，或跟你的 AI 说）：\n• ' + tips.join('\n• ') : '') + '\n\n（还没卖的持仓不算进胜率；所有数字来自交易日记，雷达「持仓 → 交易日记」可以自己查）';
    writeFileSync(join(DIR, 'data', `weekly_${key}.txt`), msg); tg?.(`🦋${msg}`.replace(/^🦋/u, '🦋 ')).catch?.(() => {}); log('每周检讨已产生');
  } catch (e) { log('每周检讨出错 ' + e.message); } }
  setInterval(() => weekly(false), 60e3).unref();
  return { weekly };
}
