// 钱包总览（官方范本，只看不买）：两条链的余额一次看完，钱不够打下一笔会提醒你。
// 每分钟更新，显示在雷达「🧩 我的面板」。想加别的资料？叫你的 AI 照这个档案改（api.balances 读余额、api.fetchJson 读公开行情、api.panel 交给雷达显示）。
export const meta = {
  id: 'wallets', name: '钱包总览', nameEn: 'Wallet overview', everySec: 60, dayUsd: 0,
  desc: '只看不买：每个钱包在 BNB Chain、Robinhood 的余额合计；钱不够打下一笔（照你设定的每笔金额自动算）会在面板标出来。', descEn: 'View only: balances on BSC and Robinhood per wallet, with low-balance warnings.',
};
export async function tick(api) {
  const b = await api.balances(); const items = [];
  if (!b || !Array.isArray(b.w) || !b.w.length) { api.panel({ title: '钱包总览', items: [{ type: 'alert', text: '还读不到钱包余额：请先在「设定 → 钱包」登入，雷达开着约 1 分钟后就会出现。', tone: 'warn' }] }); return; }
  const bp = Number(b.bnbUsd) || 0, ep = Number(b.ethUsd) || 0; const f = (v, d) => (Number(v) || 0).toFixed(d);
  /* 她 11/2 05:11：不另外设提醒门槛（跟雷达自己的余额提醒重复），直接照「每笔金额」算够不够打下一笔 */
  const cp = b.caps || {}; const gasU = (Number(cp.gasBnb) || 0.003) * bp; const needB = Math.max(Number(cp.bscMint) || 0, Number(cp.bscTok) || 0) + gasU; const needR = Math.max(Number(cp.rh) || 0, Number(cp.rhMint) || 0) + 1;
  let tb = 0, tr = 0, part = false; const rows = []; const g = (v, d) => (v == null ? '—' : f(v, d));
  for (const w of b.w) { if (w.bsc?.BNB == null || w.bsc?.USDT == null || w.bsc?.USDC == null || w.rh?.ETH == null) part = true; const bsc = (w.bsc?.BNB || 0) * bp + (w.bsc?.USDT || 0) + (w.bsc?.USDC || 0); const rh = (w.rh?.ETH || 0) * ep; tb += bsc; tr += rh;
    rows.push([w.name, g(w.bsc?.BNB, 4), g(w.bsc?.USDT, 2), g(w.bsc?.USDC, 2), g(w.rh?.ETH, 5), '$' + f(bsc + rh, 1)]);
    if (needB > 0 && bsc < needB) items.push({ type: 'alert', text: `[${w.name}] BNB Chain 只剩约 ${f(bsc, 1)}U，不够打下一笔（要约 ${f(needB, 1)}U）。叫你的 AI 换一些 BNB 进来（手续费也要 BNB）。`, tone: 'dn' });
    if (w.rh?.ETH != null && needR > 1 && rh < needR) items.push({ type: 'alert', text: `[${w.name}] Robinhood 链上 ETH 约 ${f(rh, 1)}U，不够打下一笔（要约 ${f(needR, 1)}U）。雷达不能帮你跨链，叫你的 AI 把 BNB 跨到 Robinhood 换成 ETH。`, tone: 'dn' }); }
  items.unshift({ type: 'stat', label: '全部合计', value: '$' + f(tb + tr, 1), sub: `${b.w.length} 个钱包` }, { type: 'stat', label: 'BNB Chain', value: '$' + f(tb, 1), sub: `BNB $${f(bp, 0)}` }, { type: 'stat', label: 'Robinhood', value: '$' + f(tr, 1), sub: `ETH $${f(ep, 0)}` });
  items.push({ type: 'table', cols: ['钱包', 'BNB', 'USDT', 'USDC', 'ETH（Robinhood）', '合计'], rows });
  const s = api.state; s.h = Array.isArray(s.h) ? s.h : []; if (!s.clean1) { { const v = s.h.map((p) => p[1]).sort((a, b) => a - b); const med = v[Math.floor(v.length / 2)] || 0; s.h = s.h.filter((p) => !(med > 0 && p[1] < med * 0.85)); } s.clean1 = 1; } /* 清掉以前读不到余额造成的假下跌 */ if (!part) s.h.push([Date.now(), +(tb + tr).toFixed(2)]); else items.push({ type: 'text', text: '有些余额这一分钟读不到（节点没回应），下一分钟会再读。' }); if (s.h.length > 1440) s.h.splice(0, s.h.length - 1440);
  if (s.h.length > 1) items.push({ type: 'line', label: '钱包总值走势（美元）', points: s.h });
  api.panel({ title: '钱包总览', items });
}
