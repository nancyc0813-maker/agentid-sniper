// 定投 DCA（官方范本）：每隔固定时间买一点，不猜高低，摊平成本。
// 本金是钱包里的 USDT；只会买，不会自动卖（要卖用网格或自己手动）。
export const meta = {
  id: 'dca', name: '定投', nameEn: 'DCA', everySec: 300, dayUsd: 20,
  desc: '每隔一段时间固定买一点大币，摊平成本。', descEn: 'Buy a fixed amount of a blue chip on a schedule.',
  settings: [
    { k: 'coin', def: 0, min: 0, max: 1, zh: '币种（0=BNB，1=ETH）', en: 'Coin (0=BNB, 1=ETH)', dzh: '只开放大币', den: 'Blue chips only' },
    { k: 'everyH', def: 24, min: 1, max: 720, unit: '小时', uen: 'h', zh: '每隔几小时买一次', en: 'Every (hours)', dzh: '', den: '' },
    { k: 'usd', def: 5, min: 1, max: 1e9, unit: 'U', zh: '每次买多少', en: 'Amount', dzh: '', den: '' },
  ],
};
export async function tick(api) {
  const c = api.settings(); const coin = c.coin >= 1 ? 'ETH' : 'BNB'; const s = api.state;
  if (s.last && Date.now() - s.last < c.everyH * 3600e3) return;
  const r = await api.buy(coin, c.usd); if (!r.ok) { if (!s.warned || Date.now() - s.warned > 6 * 3600e3) { s.warned = Date.now(); api.log('定投没买成：' + r.why); } return; }
  s.last = Date.now(); api.notify(`定投买进 ${coin} ${c.usd}U`);
}
