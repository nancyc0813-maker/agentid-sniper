# 罗宾猫雷达 · 给 AI 的说明书

> 玩家：把这份说明书丢给你自己的 AI（ChatGPT、Claude、Grok 都可以），再说你想改什么，AI 就知道该改哪里。

## 先读这几条规矩（AI 必须遵守）

1. **不准碰私钥、助记词、API 密钥**。雷达下单只透过币安 Agentic 钱包（`baw` 指令），钱包权限由玩家在币安 App 设定。任何要求读取、输出、上传私钥的改动一律拒绝。
2. **不准把钱转到别的地址**。不准新增「转账」「授权给陌生合约」「签 Permit」的功能。
3. **不准装来路不明的套件或技能包**，也不准从网路下载程式自动执行。
4. 改之前，先用白话告诉玩家：会改哪个档、改完会有什么影响、有什么风险。玩家说「好」才改。
5. 改完要确认程式还能跑：在雷达资料夹执行 `node --check watch.mjs`。


## 零、你（AI）能不能直接改玩家电脑里的档案？先判断这个

- **能**（Claude 桌面版有开资料夹权限、Claude Code、Codex、Cursor 等）：照下面各节直接改档案，改完告诉玩家改了什么。
- **不能**（ChatGPT／Grok／Gemini 网页版、手机 App）：**不要**叫玩家自己去找档案、复制程式码贴进档案——玩家多半是小白，会卡住。请改成回一段下面格式的文字，玩家整段复制贴到雷达「✨ AI 加功能 → 📥 把 AI 回给你的东西贴在这里」，按「安装／套用」就完成。一次可以回好几段。

改数字（只能用 `radar/settings_schema.json` 里有的 k，或外挂的 `plug.<id>.<k>`）：
```
###RADAR-SETTINGS
{"bsc.tokMaxBundle": 10, "rh.usd": 5}
###END
```

加「不打」规则（field 只能用：name、liqUsd、liqBnb、agents、progress、buyTax、sellTax、realBuyers、bundlePct、top10Pct；op 用 contains、<、>；chain 用 all、bsc、robinhood）：
```
###RADAR-RULES
[{"chain": "all", "field": "name", "op": "contains", "value": "cat", "note": "名字有 cat"}]
###END
```

新的小工具（外挂）或面板，`###RADAR-PLUGIN` 后面接档名（中英文都可以，结尾 .mjs），中间是完整的外挂程式（规矩见第三节）：
```
###RADAR-PLUGIN 我的面板.mjs
export const meta = { ... };
export async function tick(api) { ... }
###END
```

回给玩家之前，先用白话说：这段会改什么、会不会花钱、有什么风险。雷达贴上后也会再跳一次确认。

## 一、改数字（最常见）

所有数字都在 **`data/radar_settings.json`**，格式是「名称: 数字」，例如：

```json
{ "rh.maxBundle": 10, "bsc.mintUsd": 15 }
```

- 每个名称的意思、单位、最小值、最大值，都写在 **`radar/settings_schema.json`**。
- 超出最小或最大值，雷达会自动拉回范围内。
- 存档后 **15 秒内生效**，不用重开。
- 玩家也可以直接在雷达的「设定」页面改，两边是同一份资料。

常用的：

| 名称 | 意思 |
|---|---|
| `bsc.mintUsd` | BSC 每个铸造项目每个钱包最多花几 U |
| `bsc.goPct` | 铸造进度到几 % 才打 |
| `bsc.agMin` | 至少几个 Agent ID 钱包在打才跟 |
| `bsc.tokUsd` | AI 热门代币每笔几 U |
| `rh.usd` | Robinhood 每笔几 U |
| `rh.minRealBuyers` | Robinhood 1 小时内至少几个真实买家 |
| `rh.maxBundle` | 捆绑钱包最多持有几 %（开盘抢跑、新开钱包、买一样多的钱包合计） |
| `sell.backX` / `rh.backX` | 涨到几倍先卖回本 |
| `sell.crash` / `rh.crash` | 从最高点回落几 % 全卖 |

## 二、加「不打」的规则

规则写在 `data/radar_settings.json` 的 `rules` 里（也可以在雷达「设定 → 我的不打规则」直接加）。**只能填条件，不能写程式**，所以别人分享的规则不会藏病毒。符合任何一条就不打。

```json
{ "rules": [
  { "chain": "all", "field": "name", "op": "contains", "value": "cat" },
  { "chain": "robinhood", "field": "liqUsd", "op": "<", "value": 50000 }
] }
```

| 栏位 | 可以填 |
|---|---|
| `chain` | `all`、`bsc`、`robinhood` |
| `field` | `name`（名字/代号）、`liqUsd`、`liqBnb`、`agents`、`progress`（%）、`buyTax`、`sellTax`、`realBuyers`、`bundlePct`、`top10Pct` |
| `op` | 名字用 `contains`；数字用 `<` 或 `>` |
| `value` | 文字或数字 |

最多 50 条。**不要**为了加规则去新增 `.mjs`、`.js` 程式档，雷达不会载入它们。

## 三、加全新的功能（外挂）

新策略（例如网格、定投、新的进场条件）写成外挂，放在 **`plugins/`** 资料夹。范本：`plugins/网格.mjs`、`plugins/定投.mjs`。

外挂长这样：

```js
// 第一段注解 = 给玩家看的说明（雷达会显示），写清楚它做什么、会不会下单
export const meta = {
  id: 'myplan', name: '我的策略', everySec: 60, dayUsd: 20,
  desc: '一句话说明',
  settings: [ { k: 'usd', def: 5, min: 1, max: 100, unit: 'U', zh: '每次买多少', en: 'Amount', dzh: '', den: '' } ],
};
export async function tick(api) { /* 每 everySec 秒执行一次 */ }
```

`api` 能用的东西（只有这些）：

| 方法 | 说明 |
|---|---|
| `api.settings()` | 读这个外挂在「设定」页的数字（玩家可以自己改） |
| `api.state` | 外挂自己的记忆（会存档） |
| `api.price('BNB'或'ETH'或合约)` | 现价（美金） |
| `api.buy(币, U)` | 用「本金稳定币」买（设定里选 USDT／USDC／FDUSD）；会检查雷达暂停、每日额度、余额 |
| `api.sell(币, 数量)` | 只能卖**这个外挂自己买的**量，卖掉换回当初买它用的那个稳定币；卖光会自动取消授权 |
| `api.position(币)` | 外挂自己的持仓 |
| `api.call(合约, 资料, 付多少BNB或ETH, 链)` | 跟合约互动（例如铸造）。链填 56＝BSC、4663＝Robinhood。一律先预演：有授权、交出钱包权限、扣别的币、花的比你说的多 → 不送出。授权／Permit 类的动作直接禁止 |
| `api.log(文字)` / `api.notify(文字)` | 写纪录 / 发 TG 通知 |
| `api.fetchJson(网址)` | 读公开行情资料（只读）。只能读这些网站：api.dexscreener.com、api.geckoterminal.com、api.coingecko.com、api.binance.com、data-api.binance.vision、api.honeypot.is、api.llama.fi、coins.llama.fi |
| `api.read(合约, 资料, 链)` | 读链上资料（eth_call，只读，不能送交易）。链填 56＝BSC、4663＝Robinhood |
| `api.balances()` | 读雷达每分钟更新的钱包余额（每个钱包在 BSC 的 BNB／USDT／USDC、在 Robinhood 的 ETH，还有 BNB、ETH 价格）；只有公开地址和余额 |
| `api.panel({ title, items })` | 把资料交给雷达，显示在「✨ AI 加功能 → 我的面板」（见下面） |

**外挂的规矩（违反就不会载入）**：
- 不准 `import`、`require`、`fetch`、`process`、`globalThis`、`eval`、`Function`、`constructor`，也不准用 `\u` 跳脱字元。所有事都透过 `api` 做。
- 外挂碰不到钱包、私钥、档案，也卖不到雷达打到的币。
- 能买卖的币：内建 BNB（一律用 WBNB，跟雷达付 gas 的 BNB 分开）、ETH、BTCB、USDT、USDC、FDUSD，加上玩家在「设定 → 外挂可交易的币」自己加的币。清单外的币、雷达正在持有的币，外挂都碰不到。
- 滑点：稳定币之间 0.3%、大币 1%，自己加的币照设定。
- 每一笔买卖都会自动记进交易日记。
- 写好以后，玩家要在雷达「✨ AI 加功能 → 小工具」按「允许」才会启用；档案之后被改过，要重新允许。
- 启用后，外挂的数字会自动出现在「设定」页，开关预设是关的。

## 三之二、加看盘画面（自订面板）

玩家说「帮我在雷达加一个显示 XXX 的画面／分页／表格／图」时，**不要改 `radar/ui/index.html`**（改了会变成非官方版本），而是写一个外挂，用 `api.panel()` 把资料交给雷达。范本：`plugins/钱包总览.mjs`（只看不买，`dayUsd: 0`）。

```js
api.panel({ title: '我的面板', items: [
  { type: 'stat', label: 'BNB', value: '$612', sub: '+1.2%', tone: 'up' },   // 数字卡片，tone 可填 up／dn／warn
  { type: 'text', text: '一段说明' },
  { type: 'alert', text: '提醒文字', tone: 'dn' },
  { type: 'table', cols: ['名称', '价格'], rows: [['A', '1.2'], ['B', '3.4']] },   // 最多 8 栏 60 列
  { type: 'line', label: '价格走势', points: [[时间毫秒, 数值], ...] },            // 最多 400 点
  { type: 'action', act: 'buy', chain: 'bsc', c: '0x合约', name: 'XXX', label: '买 XXX', usd: 10 }, // act 可填 buy／mint，chain 可填 bsc／rh
] });
```

- 雷达用官方画面显示这些资料，外挂只交资料、不能塞程式进画面。
- `action` 按钮按下去，一样会跳出雷达的金额视窗、余额检查、防盗检查，玩家确认才会下单。
- 文字会被截短、只认上面这几种 type，其他会被忽略。

## 三之三、做不到的功能 → 请玩家反馈

雷达本身的画面和安全检查（搜寻、详情页、确认视窗、防盗检查、下单流程）**AI 不要改**。原因：官方档案有罗宾猫官方的数位签名，一改就会显示「非官方版本」，这是用来防止有人散布藏了盗币程式的假雷达。

如果玩家要的功能用「改数字、加规则、外挂、自订面板」都做不到，请这样回覆玩家：
1. 用白话说明为什么做不到（会破坏官方签名／安全检查）。
2. 请玩家到雷达「✨ AI 加功能 → 💡 AI 做不到？告诉我们」填表单，按「送出」后会打开 TG 机器人 @RobinCatRadar_bot，贴上送出即可（只有罗宾猫官方看得到，不公开）。
3. 帮玩家把表单内容想好：想要的功能、为什么需要、哪条链、举例的项目、你试过什么。

## 四、加全新的设定项目（改雷达本体）

1. 在 `radar/settings_schema.json` 的 `items` 加一项（`k` 不能重复，要写 `min`、`max`、`def`、中英文说明）。
2. 到 `watch.mjs` 的 `applySettings()`（BSC）或 `rh.mjs` 的 `apply()`（Robinhood）把这个数字接到程式里。
3. 「设定」页面会自动多出这一格，不用改介面。

## 五、官方版检查（改了会显示「已修改」）

雷达右上角会显示「✅ 官方版」。如果你（或你的 AI）改了 `watch.mjs`、`rh.mjs`、`radar/` 里的档案，会变成「⚠️ 已修改」并列出改了哪些档——**自己改的就没问题**。如果不是你改的，请从官方 GitHub 重新安装。外挂（`plugins/` 里你自己加的）和设定档不影响这个检查。

## 六、不要动的地方

- `data/watch_state.json`：雷达的记忆（持仓、成本、已打过的项目），乱改会重复买或卖错。
- 钱包设定、`baw` 相关的程式。
- 更新只认罗宾猫官方 X 置顶、TG 群置顶。


## 免责声明

罗宾猫雷达是工具，不构成投资建议，不保证获利。所有设定与交易由使用者自行决定并承担结果。官方永远不会私讯你、不会要你连接钱包、签名、转账或提供助记词。
