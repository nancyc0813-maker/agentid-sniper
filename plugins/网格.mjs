// 网格交易（官方范本）：价格在区间内每跌一格买一份、每涨一格卖一份，赚来回的价差。
// 只适合 BNB、ETH 这种大币；土狗不要用网格（一天跌 90% 会整个套住）。
// 本金是钱包里的 USDT；只卖网格自己买的部位，碰不到雷达打到的币。
export const meta = {
  id: 'grid', name: '网格交易', nameEn: 'Grid trading', everySec: 60, dayUsd: 50,
  desc: '在价格区间内低买高卖。只用于大币，本金是 USDT。', descEn: 'Buy low / sell high inside a range. Blue chips only; funded with USDT.',
  settings: [
    { k: 'coin', def: 0, min: 0, max: 1, zh: '币种（0=BNB，1=ETH）', en: 'Coin (0=BNB, 1=ETH)', dzh: '只开放大币', den: 'Blue chips only' },
    { k: 'low', def: 0, min: 0, max: 100000, unit: 'U', zh: '区间下限', en: 'Range low', dzh: '0 = 自动（开始时的现价往下 15%）。跌破就不再买', den: '0 = auto (start price −15%). No buys below' },
    { k: 'high', def: 0, min: 0, max: 100000, unit: 'U', zh: '区间上限', en: 'Range high', dzh: '0 = 自动（开始时的现价往上 15%）。涨破就不再卖', den: '0 = auto (start price +15%). No sells above' },
    { k: 'levels', def: 10, min: 2, max: 50, unit: '格', uen: 'levels', zh: '分几格', en: 'Levels', dzh: '格子越多，交易越频繁、每次赚越少', den: 'More levels = more, smaller trades' },
    { k: 'perUsd', def: 5, min: 1, max: 1e9, unit: 'U', zh: '每格买多少', en: 'Per level', dzh: '每跌一格买进的金额', den: 'Buy size per level' },
  ],
};
export async function tick(api) {
  const c = api.settings(); const coin = c.coin >= 1 ? 'ETH' : 'BNB';
  const px = await api.price(coin); const s0 = api.state;
  if (s0.coin !== coin || !(s0.autoLow > 0)) { s0.autoLow = px * 0.85; s0.autoHigh = px * 1.15; }
  const low = c.low > 0 ? c.low : s0.autoLow, high = c.high > 0 ? c.high : s0.autoHigh; c.low = low; c.high = high;
  if (!(c.high > c.low)) return api.log('区间设定不对：上限要大于下限');
  const step = (c.high - c.low) / c.levels;
  const lv = Math.max(0, Math.min(c.levels, Math.floor((px - c.low) / step)));
  const s = api.state; if (s.coin !== coin) { s.coin = coin; s.lv = lv; s.lots = []; api.log(`开始：${coin} 现价 ${px.toFixed(2)}，区间 ${c.low.toFixed(2)}～${c.high.toFixed(2)}，在第 ${lv} 格`); api.notify(`网格开始：${coin} 区间 ${c.low.toFixed(0)}～${c.high.toFixed(0)}，分 ${c.levels} 格，每格 ${c.perUsd}U`); return; }
  if (px < c.low || px > c.high) return; // 区间外不动作
  if (lv < s.lv) { // 跌了 → 每跌一格买一份
    for (let i = 0; i < s.lv - lv; i++) { const r = await api.buy(coin, c.perUsd); if (!r.ok) { api.log('买不了：' + r.why); break; } s.lots.push({ qty: r.qty, at: px }); api.notify(`${coin} 跌到 ${px.toFixed(2)}，买进 ${c.perUsd}U`); }
  } else if (lv > s.lv) { // 涨了 → 每涨一格卖一份（先卖最便宜买的）
    s.lots.sort((a, b) => a.at - b.at);
    for (let i = 0; i < lv - s.lv && s.lots.length; i++) { const lot = s.lots[0]; if (px < lot.at + step * 0.9) break; const r = await api.sell(coin, lot.qty); if (!r.ok) { api.log('卖不了：' + r.why); break; } s.lots.shift(); api.notify(`${coin} 涨到 ${px.toFixed(2)}，卖出一份，回收 ${r.usd.toFixed(2)}U`); }
  }
  s.lv = lv;
}
