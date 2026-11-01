// 罗宾猫雷达 · 桌面程式主程序
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, shell, clipboard, dialog } = require('electron');
let QR = null; try { QR = require('qrcode'); } catch {}
const qrCache = { url: '', img: '' };
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');               // 打狗工具资料夹（GangPaper）
const DATA = path.join(ROOT, 'data');
const SET = path.join(DATA, 'radar_settings.json');
const ICON = path.join(__dirname, 'ui', 'logo.png');
let win = null, tray = null, quitting = false;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

// 从打狗工具的状态档整理出看盘 / 持仓 / 状态
let cache = { at: 0, v: null };
function snapshot() {
  if (Date.now() - cache.at < 3000 && cache.v) return cache.v;
  const S = readJSON(path.join(DATA, 'watch_state.json'), {});
  const now = Date.now(), px = S.lastBnbUsd || 0;
  const board = Object.entries(S.paid || {}).filter(([c, P]) => now - (P.at || 0) < 172800e3).map(([c, P]) => {
    const prog = Math.round((P.progress || 0) * 100), ag = P.agents || 0, grp = Object.keys(S.grpHits?.[c]?.chats || {}).length;
    const done = Object.values(P.done || {}).some((x) => x === 'minted' || x === 'free');
    const why = String(P.lastReason || '');
    let verdict = 'watch', note = `进度要 60%、AI 钱包要 100 个`;
    if (done) { verdict = 'done'; note = '已打'; }
    else if (/不打|騙|贔|貔貅|大量部署|黑名單|不是 Agent/.test(why)) { verdict = 'no'; note = why.replace(/，?照規則不打|，先不打.*$/, ''); }
    else if (prog >= 60 && ag >= 100) { verdict = 'ok'; note = '符合条件'; }
    return { c, name: P.name || c.slice(0, 8), prog, ag, grp, verdict, note, at: P.at || 0, col: done ? 'done' : prog >= 30 ? 'hot' : 'new' };
  }).filter((x) => x.verdict !== 'no' || x.grp > 0 || x.ag > 20).sort((a, b) => (b.ag + b.prog * 3 + b.grp * 30) - (a.ag + a.prog * 3 + a.grp * 30)).filter((x, i) => i < 90 || x.verdict === 'done');
  const hold = (S.dyn || []).filter((t) => !t.closed).map((t) => {
    const keyMe = Object.keys(S.tokens || {}).find((k) => k === t.sym || k.endsWith(':' + t.sym));
    const st = S.tokens?.[keyMe] || {};
    return { sym: t.sym, addr: t.addr, cost: t.cost || 0, value: st.last?.v ?? null, done: !!st.done, stage: st.stage || 0, wallet: t.only };
  }).filter((h) => !h.done).slice(-40).reverse();
  for (const [c, P] of Object.entries(S.rh?.pos || {})) { const ws = Object.values(P.w || {}).filter((w) => !w.closed); if (!ws.length) continue; hold.unshift({ sym: P.sym, addr: c, chain: 'rh', cost: ws.reduce((a, w) => a + (w.cost || 0), 0), value: ws.some((w) => w.val != null) ? ws.reduce((a, w) => a + (w.val || 0), 0) : null, stage: Math.min(...ws.map((w) => w.stage || 0)) }); } /* Robinhood 持仓 */
  const hb = readText(path.join(DATA, 'watch_heartbeat.txt'));
  const login = readJSON(path.join(DATA, 'radar_login.json'), null); if (login && Date.now() - (login.at || 0) > 600e3) login.stale = 1;
  if (login?.state === 'qr' && login.url && qrCache.url === login.url) login.img = qrCache.img;
  const rhMint = Object.entries(S.rh?.mint || {}).filter(([, M]) => M.recent != null || Object.keys(M.m || {}).length >= 10).map(([c, M]) => ({ c, name: M.name || '', sym: M.sym || '', nft: !!M.nft, total: Object.keys(M.m || {}).length, recent: M.recent ?? null, real: M.real ?? null, fresh: M.freshPct ?? null, price: M.priceUsd ?? null, cost: M.costUsd ?? null, ok: !!M.ok, why: M.why || '还没检查', done: !!(M.done && Object.keys(M.done).length), age: Math.round((Date.now() - (M.first || Date.now())) / 60e3) })).sort((a, b) => (b.real || 0) - (a.real || 0) || b.total - a.total).slice(0, 60);
  const smart = { related: Object.entries(S.smartW?.related || {}).map(([a, r]) => ({ a, of: r.of, ch: r.ch })), events: (S.smartW?.events || []).slice(-30).reverse() };
  const bscNft = Object.entries(S.bscNft?.m || {}).filter(([, M]) => Object.keys(M.m || {}).length >= 10).map(([c, M]) => ({ c, name: M.name || '', sym: M.sym || '', nft: true, total: Object.keys(M.m || {}).length, recent: M.recent ?? null, real: M.real ?? null, fresh: M.freshPct ?? null, cost: M.costUsd ?? null, ok: !!M.ok, why: M.why || '还没检查', done: !!(M.done && Object.keys(M.done).length), age: Math.round((Date.now() - (M.first || Date.now())) / 60e3) })).sort((a, b) => (b.real || 0) - (a.real || 0) || b.total - a.total).slice(0, 60);
  const v = { board, hold, hb, bnbUsd: px, rhMint, bscNft, smart, official: officialCheck(), set: readJSON(SET, {}), paused: fs.existsSync(path.join(DATA, 'pause_buy.txt')), wallets: readJSON(path.join(DATA, 'radar_wallets.json'), { list: [] }).list || [], login };
  cache = { at: Date.now(), v }; return v;
}

ipcMain.handle('snapshot', async () => { const v = snapshot(); const L = v.login; if (L?.state === 'qr' && L.url && /^https:\/\/app\.binance\.com\//.test(L.url) && qrCache.url !== L.url && QR) { qrCache.url = L.url; qrCache.img = await QR.toDataURL(L.url, { margin: 1, width: 220 }).catch(() => ''); L.img = qrCache.img; } return v; });
ipcMain.handle('login', (e, i) => { try { fs.unlinkSync(path.join(DATA, 'radar_login.json')); } catch {} fs.writeFileSync(path.join(DATA, 'radar_login_req.json'), JSON.stringify({ i: Number(i) || 0, at: Date.now() })); cache.at = 0; return true; });
ipcMain.handle('copyGuide', () => { try { clipboard.writeText(fs.readFileSync(path.join(ROOT, 'AI说明书.md'), 'utf8')); return true; } catch { return false; } });
// 链上新池（BSC / Robinhood Chain）：GeckoTerminal 免费接口，2 分钟缓存，被限流就沿用旧资料
const POOLS = {};
async function pools(net) {
  if (!['bsc', 'robinhood'].includes(net)) return { list: [] };
  const c = POOLS[net]; if (c && Date.now() - c.at < 120e3) return c.v;
  const out = new Map(); let err = '';
  for (const k of ['trending_pools', 'new_pools']) {
    try { const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/${k}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (!j.data) { err = '资料源忙，稍后自动更新'; continue; }
      for (const p of j.data) { const a = p.attributes || {}; const tok = String(p.relationships?.base_token?.data?.id || '').split('_').pop(); if (!/^0x[0-9a-fA-F]{40}$/.test(tok)) continue;
        const liq = +a.reserve_in_usd || 0; if (liq < 3000) continue; if (out.has(tok.toLowerCase())) continue;
        out.set(tok.toLowerCase(), { c: tok.toLowerCase(), sym: String(a.name || '').split(' / ')[0].slice(0, 20), pool: a.address, liq, mc: +(a.market_cap_usd || a.fdv_usd) || 0, age: a.pool_created_at ? Math.round((Date.now() - Date.parse(a.pool_created_at)) / 60e3) : null, h1: +(a.price_change_percentage?.h1) || 0, vol: +(a.volume_usd?.h24) || 0, buys: a.transactions?.h1?.buys || 0, sells: a.transactions?.h1?.sells || 0, nativeUsd: +a.quote_token_price_usd || 0, trend: k === 'trending_pools' }); }
    } catch (e) { err = '资料源连不上'; }
  }
  if (out.size < 5) { /* GeckoTerminal 被限流时，改用 DexScreener 补资料 */
    try { const seen = new Set(); for (const u of ['token-profiles/latest/v1', 'token-boosts/latest/v1', 'token-boosts/top/v1']) { const j = await (await fetch('https://api.dexscreener.com/' + u, { signal: AbortSignal.timeout(12000) })).json(); for (const x of j || []) if (x.chainId === net && /^0x[0-9a-fA-F]{40}$/.test(x.tokenAddress)) seen.add(x.tokenAddress.toLowerCase()); }
      const qs = await (await fetch(`https://api.dexscreener.com/latest/dex/search?q=${net === 'bsc' ? 'WBNB' : 'robinhood'}`, { signal: AbortSignal.timeout(12000) })).json().catch(() => ({}));
      for (const p of qs.pairs || []) if (p.chainId === net) seen.add(String(p.baseToken?.address || '').toLowerCase());
      const ids = [...seen].filter((a) => /^0x[0-9a-f]{40}$/.test(a) && !out.has(a)).slice(0, 30);
      if (ids.length) { const ps = await (await fetch(`https://api.dexscreener.com/tokens/v1/${net}/${ids.join(',')}`, { signal: AbortSignal.timeout(12000) })).json();
        for (const p of ps || []) { const tok = String(p.baseToken?.address || '').toLowerCase(); const liq = +(p.liquidity?.usd) || 0; if (!tok || out.has(tok) || liq < 3000) continue;
          out.set(tok, { c: tok, sym: String(p.baseToken?.symbol || '').slice(0, 20), pool: p.pairAddress, liq, mc: +(p.marketCap || p.fdv) || 0, age: p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 60e3) : null, h1: +(p.priceChange?.h1) || 0, vol: +(p.volume?.h24) || 0, buys: p.txns?.h1?.buys || 0, sells: p.txns?.h1?.sells || 0, nativeUsd: 0, trend: (p.boosts?.active || 0) > 0 }); } }
      if (out.size) err = '';
    } catch (e) {}
  }
  const list = [...out.values()].sort((a, b) => (b.trend - a.trend) || (b.vol - a.vol)).slice(0, 60);
  const v = { list: list.length ? list : (c?.v.list || []), err: list.length ? '' : err, at: Date.now() };
  POOLS[net] = { at: list.length ? Date.now() : Date.now() - 90e3, v }; return v;
}
ipcMain.handle('pools', (e, net) => pools(net));
ipcMain.handle('schema', () => { const a = readJSON(path.join(__dirname, 'settings_schema.json'), { items: [], groups: [] }); const m = readJSON(path.join(DATA, 'plugins_meta.json'), {}); return { groups: [...(a.groups || []), ...(m.groups || [])], items: [...(a.items || []), ...(m.items || [])] }; });
function readJournal() { const t = readText(path.join(DATA, 'journal.jsonl')); const out = []; for (const l of t.split('\n').slice(-20000)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} } return out; }
ipcMain.handle('journal', () => readJournal().reverse());
ipcMain.handle('exportJournal', async (e, rows) => { const r = await dialog.showSaveDialog(win, { defaultPath: '罗宾猫雷达_交易日记.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }); if (r.canceled || !r.filePath) return false;
  const q = (x) => '"' + String(x ?? '').replace(/"/g, '""') + '"'; const H = ['时间', '链', '来源', '买卖', '币', '合约', '钱包', '金额(U)', '拿到', '备注'];
  const list = Array.isArray(rows) ? rows : readJournal(); fs.writeFileSync(r.filePath, '\ufeff' + [H.map(q).join(','), ...list.map((x) => [new Date(x.at).toLocaleString('zh-CN', { hour12: false }), x.chain, x.src, x.side, x.sym, x.token, x.wallet, x.usd, x.got, x.note].map(q).join(','))].join('\r\n')); return true; });
ipcMain.handle('checkToken', async (e, addr) => { addr = String(addr).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(addr)) return { err: '合约地址格式不对' };
  try { const j = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${addr}&chainID=56`, { signal: AbortSignal.timeout(15000) })).json(); return { sym: j.token?.symbol || '', name: j.token?.name || '', honeypot: j.honeypotResult?.isHoneypot ?? null, buyTax: j.simulationResult?.buyTax ?? null, sellTax: j.simulationResult?.sellTax ?? null, ok: !!j.simulationSuccess }; } catch (e) { return { err: '查不到（' + e.message.slice(0, 40) + '）' }; } });
// 官方版检查：比对 Nancy 的数位签名，确认档案没被换掉（防假冒、防被植入）
const OFFICIAL_PUB = 'MCowBQYDK2VwAyEAMWj2tCjS9GNHCqNpx9v3+JOlkEG2yZWLrw1jfg7LhIw=';
let offi = { at: 0, v: null };
function officialCheck() { if (Date.now() - offi.at < 60e3 && offi.v) return offi.v; let v;
  try { const crypto = require('crypto'); const man = fs.readFileSync(path.join(__dirname, 'official.json')); const sig = Buffer.from(fs.readFileSync(path.join(__dirname, 'official.sig'), 'utf8').trim(), 'base64');
    const pub = crypto.createPublicKey({ key: Buffer.from(OFFICIAL_PUB, 'base64'), format: 'der', type: 'spki' });
    if (!crypto.verify(null, man, pub, sig)) v = { state: 'bad', why: '签名不对' };
    else { const M = JSON.parse(man); const changed = []; for (const [f, h] of Object.entries(M.files || {})) { let x = ''; try { x = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'); } catch {} if (x !== h) changed.push(f); } v = changed.length ? { state: 'changed', files: changed, at: M.at } : { state: 'ok', at: M.at }; }
  } catch (e) { v = { state: 'unsigned', why: e.message.slice(0, 80) }; }
  offi = { at: Date.now(), v }; return v; }
const DONATE = '0x45d8c67067a5ca209ace41fe0aca86f82847d4a6'; /* Nancy 的打赏地址（EVM）。写死在程式里，官方版签名会保护它不被换掉 */
ipcMain.handle('donate', async () => ({ addr: DONATE, img: QR ? await QR.toDataURL(DONATE, { margin: 1, width: 220 }).catch(() => '') : '' }));
ipcMain.handle('copyText', (e, t) => { if (String(t) === DONATE) { clipboard.writeText(DONATE); return true; } return false; });
ipcMain.handle('plugins', () => readJSON(path.join(DATA, 'plugins_meta.json'), { found: [] }).found || []);
ipcMain.handle('approvePlugin', (e, file, hash) => { if (!/^[^\\/]+\.mjs$/.test(String(file)) || !/^[0-9a-f]{64}$/.test(String(hash))) return false; const f = path.join(DATA, 'plugins_ok.json'); const o = readJSON(f, {}); o[file] = hash; fs.writeFileSync(f, JSON.stringify(o)); try { const w = path.join(ROOT, 'watch.mjs'); const t = new Date(); fs.utimesSync(w, t, t); } catch {} return true; }); /* 允许后让打狗工具重新载入 */

ipcMain.handle('saveSettings', (e, s) => { fs.writeFileSync(SET, JSON.stringify({ ...readJSON(SET, {}), ...s, savedAt: Date.now() }, null, 1)); cache.at = 0; return true; });
ipcMain.handle('pause', (e, on) => { const f = path.join(DATA, 'pause_buy.txt'); if (on) fs.writeFileSync(f, String(Date.now())); else try { fs.unlinkSync(f); } catch {} cache.at = 0; return on; });
ipcMain.handle('order', (e, o) => { // 交给打狗工具执行（它会照安全检查、每日额度处理）
  const q = path.join(DATA, 'radar_orders.json'); const arr = readJSON(q, []); arr.push({ ...o, at: Date.now() }); fs.writeFileSync(q, JSON.stringify(arr)); return true; });
ipcMain.handle('open', (e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('notify', (e, t, b) => { try { new Notification({ title: t, body: b, icon: ICON }).show(); } catch {} });

function createWindow() {
  win = new BrowserWindow({ width: 1320, height: 840, minWidth: 1100, minHeight: 680, title: '罗宾猫雷达', icon: ICON, backgroundColor: '#0b0d11', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));                 // 安全：不开任何新视窗
  win.webContents.on('will-navigate', (e) => e.preventDefault());                    // 安全：不允许跳到别的网站
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });   // 关视窗 = 缩到右下角，继续在背景跑
}
app.whenReady().then(() => {
  createWindow();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('罗宾猫雷达 · 监控中');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开罗宾猫雷达', click: () => { win.show(); win.focus(); } }, { type: 'separator' }, { label: '结束', click: () => { quitting = true; app.quit(); } }]));
  tray.on('click', () => { win.show(); win.focus(); });
});
// 程式更新后自动套用：介面档改了就重新整理，主程式改了就自己重开（不用玩家手动重启）
let rlT = null; const watchFile = (f, full) => { try { fs.watchFile(f, { interval: 3000 }, (cur, prev) => { if (cur.mtimeMs === prev.mtimeMs) return; clearTimeout(rlT); rlT = setTimeout(() => { if (full) { app.relaunch(); quitting = true; app.exit(0); } else if (win) win.webContents.reloadIgnoringCache(); }, 1500); }); } catch {} }; /* 用定时比对修改时间（fs.watch 在共享资料夹收不到通知，改了不会更新） */
app.whenReady().then(() => { watchFile(path.join(__dirname, 'ui', 'index.html'), false); watchFile(path.join(__dirname, 'main.cjs'), true); watchFile(path.join(__dirname, 'preload.cjs'), true); watchFile(path.join(__dirname, 'settings_schema.json'), false); });
app.on('window-all-closed', (e) => e.preventDefault?.());
