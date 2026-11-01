// 罗宾猫雷达 · 外挂沙盒（每个外挂一个独立小程式）
// 用 Node 权限模式启动：只能读自己和这个外挂档，不能写档、不能读其他档案、不能开别的程式；环境变数也是空的
// 外挂要做的事（下单、查价）全部透过讯息交给主程式，主程式会照额度、暂停开关、帐本检查
import { pathToFileURL } from 'node:url';
const file = process.argv[2];
let seq = 0; const wait = new Map();
const call = (name, args) => new Promise((res, rej) => { const id = ++seq; wait.set(id, { res, rej }); process.send({ t: 'call', id, name, args }); });
process.on('message', async (m) => {
  if (m.t === 'ret') { const w = wait.get(m.id); if (!w) return; wait.delete(m.id); m.err ? w.rej(new Error(m.err)) : w.res(m.v); return; }
  if (m.t === 'tick') {
    const state = m.state || {}; const S = m.settings || {};
    const api = Object.freeze({ id: m.id, state, settings: () => ({ ...S }), log: (x) => process.send({ t: 'log', m: String(x).slice(0, 300) }), notify: (x) => process.send({ t: 'notify', m: String(x).slice(0, 500) }), panel: (x) => { try { const j = JSON.stringify(x); if (j.length < 200000) process.send({ t: 'panel', p: JSON.parse(j) }); } catch {} },
      price: (t) => call('price', [t]), fetchJson: (u) => call('fetchJson', [u]), balances: () => call('balances', []), read: (to, d, ch) => call('read', [to, d, ch]), buy: (t, u) => call('buy', [t, u]), sell: (t, q) => call('sell', [t, q]), call: (to, data, v, ch) => call('call', [to, data, v, ch]), position: (t) => call('position', [t]), spentToday: () => call('spentToday', []) });
    try { await mod.tick(api); process.send({ t: 'done', state }); } catch (e) { process.send({ t: 'done', state, err: String(e?.message || e).slice(0, 200) }); }
  }
});
process.on('disconnect', () => process.exit(0)); /* 主程式重开或关掉，外挂沙盒跟着结束，不会留下孤儿程式 */
let mod;
try { mod = await import(pathToFileURL(file).href); if (!mod.meta?.id || typeof mod.tick !== 'function') throw new Error('缺 meta 或 tick'); process.send({ t: 'meta', meta: JSON.parse(JSON.stringify(mod.meta)) }); }
catch (e) { process.send({ t: 'fail', err: String(e?.message || e).slice(0, 200) }); process.exit(1); }
