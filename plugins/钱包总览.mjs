// 钱包总览（官方范本，只看不买）：两条链的余额一次看完，钱不够打下一笔会提醒你。
// 每分钟更新，显示在雷达「🧩 我的面板」。想加别的资料？叫你的 AI 照这个档案改（api.balances 读余额、api.fetchJson 读公开行情、api.panel 交给雷达显示）。
export const meta = {
  id: 'wallets', name: '钱包总览', nameEn: 'Wallet overview', everySec: 60, dayUsd: 0,
  desc: '只看不买：每个钱包在 BSC、Robinhood 的余额合计，不够打下一笔会提醒。', descEn: 'View only: balances on BSC and Robinhood per wallet, with low-balance warnings.',
  settings: [
    { k: 'warnBsc', def: 15, min: 0, max: 1e9, unit: 'U', zh: 'BSC 余额低于多少提醒', en: 'Warn if BSC balance below', dzh: 'BNB＋USDT＋USDC 合计', den: 'BNB + USDT + USDC total' },
    { k: 'warnRh', def: 10, min: 0, max: 1e9, unit: 'U', zh: 'Robinhood ETH 低于多少提醒', en: 'Warn if Robinhood ETH below', dzh: '', den: '' },
  ],
};
export async function tick(api) {
  const c = api.settings(); const b = await api.balances(); const items = [];
  if (!b || !Array.isArray(b.w) || !b.w.length) { api.panel({ title: '钱包总览', items: [{ type: 'alert', text: '还读不到钱包余额：请先在「设定 → 钱包」登入，雷达开着约 1 分钟后就会出现。', tone: 'warn' }] }); return; }
  const bp = Number(b.bnbUsd) || 0, ep = Number(b.ethUsd) || 0; const f = (v, d) => (Number(v) || 0).toFixed(d);
  let tb = 0, tr = 0; const rows = [];
  for (const w of b.w) { const bsc = (w.bsc?.BNB || 0) * bp + (w.bsc?.USDT || 0) + (w.bsc?.USDC || 0); const rh = (w.rh?.ETH || 0) * ep; tb += bsc; tr += rh;
    rows.push([w.name, f(w.bsc?.BNB, 4), f(w.bsc?.USDT, 2), f(w.bsc?.USDC, 2), f(w.rh?.ETH, 5), '$' + f(bsc + rh, 1)]);
    if (bsc < c.warnBsc) items.push({ type: 'alert', text: `[${w.name}] BSC 只剩约 ${f(bsc, 1)}U，低于你设的 ${c.warnBsc}U。不够的话叫你的 AI 换一些 BNB 进来（手续费也要 BNB）。`, tone: 'dn' });
    if (w.rh?.ETH != null && rh < c.warnRh) items.push({ type: 'alert', text: `[${w.name}] Robinhood 链上 ETH 约 ${f(rh, 1)}U，低于 ${c.warnRh}U。雷达不能帮你跨链，要用的话叫你的 AI 把 BNB 跨到 Robinhood 换成 ETH。`, tone: 'dn' }); }
  items.unshift({ type: 'stat', label: '全部合计', value: '$' + f(tb + tr, 1), sub: `${b.w.length} 个钱包` }, { type: 'stat', label: 'BSC', value: '$' + f(tb, 1), sub: `BNB $${f(bp, 0)}` }, { type: 'stat', label: 'Robinhood', value: '$' + f(tr, 1), sub: `ETH $${f(ep, 0)}` });
  items.push({ type: 'table', cols: ['钱包', 'BNB', 'USDT', 'USDC', 'ETH（Robinhood）', '合计'], rows });
  const s = api.state; s.h = Array.isArray(s.h) ? s.h : []; s.h.push([Date.now(), +(tb + tr).toFixed(2)]); if (s.h.length > 1440) s.h.splice(0, s.h.length - 1440);
  if (s.h.length > 1) items.push({ type: 'line', label: '钱包总值走势（美元）', points: s.h });
  api.panel({ title: '钱包总览', items });
}
