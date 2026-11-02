// 罗宾猫雷达 · 聪明钱包（11/2）：用户标记的钱包（做市商、大户）＋自动找到的「相关钱包」，只要对某个币有动作就通知
// 全部本地跑：直接查链上转账纪录（BSC、Robinhood Chain），不用任何 AI、不花钱
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SKIP = new Set(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xe9e7cea3dedca5984780bafc599bd69add087d56', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', '0x0bd7d308f8e1639fab988df18a8011f41eacad73']); // WBNB、稳定币、Robinhood WETH：不算「对项目动作」
const FUND = new Set(['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x0bd7d308f8e1639fab988df18a8011f41eacad73']);
const lc = (x) => String(x || '').toLowerCase(); const pad = (a) => '0x' + lc(a).slice(2).padStart(64, '0');
export function startSmart({ rpc, log, tg, S, save, radarSet }) {
  const RH = 'https://rpc.mainnet.chain.robinhood.com';
  const rhRpc = async (m, p) => { const j = await (await fetch(RH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(20000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const CH = { bsc: { rpc, step: 1200, name: 'BSC' }, robinhood: { rpc: rhRpc, step: 6000, name: 'Robinhood' } };
  S.smartW = S.smartW || {}; const Z = S.smartW; Z.last = Z.last || {}; Z.related = Z.related || {}; Z.seen = Z.seen || {}; Z.events = Z.events || []; /* 用自己的栏位，不跟旧资料打架 */
  const list = () => { const o = {}; for (const x of Array.isArray(radarSet()['smart.wallets']) ? radarSet()['smart.wallets'] : []) { const a = lc(x?.addr); if (/^0x[0-9a-f]{40}$/.test(a)) o[a] = String(x.label || '聪明钱包').slice(0, 30); } if (radarSet()['smart.related'] !== 0) for (const [a, r] of Object.entries(Z.related)) if (!o[a] && o[r.of]) o[a] = (o[r.of] || '') + ' 的相关钱包'; return o; };
  const symCache = {};
  async function symOf(ch, c) { const k = ch + c; if (symCache[k]) return symCache[k]; try { const h = await CH[ch].rpc('eth_call', [{ to: c, data: '0x95d89b41' }, 'latest']); const b = Buffer.from(h.slice(2), 'hex'); const n = b.length >= 96 ? Number(BigInt('0x' + b.slice(32, 64).toString('hex'))) : 0; symCache[k] = (n ? b.slice(64, 64 + Math.min(n, 20)).toString('utf8') : b.toString('utf8')).replace(/\0/g, '').trim() || c.slice(0, 8); } catch { symCache[k] = c.slice(0, 8); } return symCache[k]; }
  let busy = false;
  async function tick() {
    if (busy) return; busy = true; try {
      const L = list(); const addrs = Object.keys(L); if (!addrs.length) return;
      for (const [ch, C] of Object.entries(CH)) {
        let head; try { head = parseInt(await C.rpc('eth_blockNumber', []), 16); } catch { continue; }
        let from = Z.last[ch] ? Z.last[ch] + 1 : head - 200; if (head - from > C.step) from = head - C.step; if (from > head) continue;
        const q = (topics) => C.rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16), topics }]).catch(() => null);
        const padded = addrs.slice(0, 200).map(pad); const outL = await q([T, padded]); const inL = await q([T, null, padded]);
        if (outL == null && inL == null) continue; Z.last[ch] = head;
        const acts = {};
        for (const [l, dir] of [...(inL || []).map((l) => [l, '买']), ...(outL || []).map((l) => [l, '卖'])]) {
          const tok = lc(l.address); const who = lc('0x' + (dir === '买' ? l.topics[2] : l.topics[1]).slice(26)); const other = lc('0x' + (dir === '买' ? l.topics[1] : l.topics[2]).slice(26));
          if (!L[who]) continue;
          if (dir === '卖' && FUND.has(tok) && !L[other] && other !== '0x' + '0'.repeat(40)) { // 聪明钱包把钱转给别人 → 可能是它的小号
            const code = await C.rpc('eth_getCode', [other, 'latest']).catch(() => '0x'); if (code === '0x' && !Z.related[other] && Object.keys(Z.related).length < 100) { Z.related[other] = { of: Z.related[who]?.of || who, at: Date.now(), ch }; log(`[聪明钱包] 找到相关钱包 ${other}（${L[who]} 转钱给它）`); } }
          if (SKIP.has(tok)) continue;
          const k = ch + '|' + tok + '|' + dir; (acts[k] = acts[k] || { ch, tok, dir, who: new Set(), n: 0 }).who.add(who); acts[k].n++;
        }
        for (const A of Object.values(acts)) {
          const key = A.ch + A.tok + A.dir; const prev = Z.seen[key]; if (prev && Date.now() - prev < 30 * 60e3) continue; Z.seen[key] = Date.now(); /* 同一个币同方向 30 分钟只通知一次 */
          const sym = await symOf(A.ch, A.tok); const names = [...A.who].map((a) => L[a]).slice(0, 3).join('、');
          const ev = { at: Date.now(), ch: A.ch, tok: A.tok, sym, dir: A.dir, who: [...A.who], names }; Z.events.push(ev); if (Z.events.length > 300) Z.events.splice(0, Z.events.length - 300);
          await tg(`🦋 聪明钱包${A.dir === '买' ? '在买' : '在卖'}：${sym}（${CH[A.ch].name}）\n${names}${A.who.size > 1 ? ` 等 ${A.who.size} 个钱包` : ''}｜${A.n} 笔\n${A.tok}`).catch(() => {});
        }
      }
      for (const [k, t] of Object.entries(Z.seen)) if (Date.now() - t > 6 * 3600e3) delete Z.seen[k];
      save();
    } catch (e) { log('[聪明钱包] 出错 ' + e.message); } finally { busy = false; }
  }
  setInterval(tick, 30e3).unref(); setTimeout(tick, 20e3); log('[聪明钱包] 监控启动');
}
