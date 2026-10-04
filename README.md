# 零一背包最优选择与同值方案计数后端

纯后端项目（API + CLI），使用 TypeScript、Node.js 内置 `node:sqlite`（无原生编译依赖、无 Docker、无外部在线服务），在 Windows 本地运行。

## 功能

- 整数容量零一背包精确求解：自实现动态规划，不使用贪心近似或现成求解器。
- 输出最优价值、一套稳定的最优物品集合、以及达到最优价值的**不同编号子集数量**（BigInt 计算，十进制字符串输出）。
- 回溯解释：逐物品给出"保留/跳过"两个候选的价值与方案数、最优值比较、同值计数相加的理由。
- 多容量对照：同一物品版本对一组容量逐项求解，逐项返回状态，部分失败不误报为全部成功。
- SQLite 持久化：物品版本与分析快照不可变保存，记录算法版本与原始参数，重启后历史报告与回溯仍可读取，后续导入新物品不会覆盖已完成结果。

## 计数语义（重要）

- 每个物品有唯一编号。即使两件物品重量、价值完全相同，只要编号不同，就视为**不同选择**，分别计入方案数。
- 方案数 = 在容量约束下达到最优总价值的不同编号子集个数，以十进制字符串输出（可超过 2^53）。
- 零容量只有空集一个方案；物品重量必须为正整数；零价值物品合法，且会产生额外最优子集（例如最优集之外还能再塞进零价值物品），不会被忽略，空集也不会因初始化被重复计算。
- 展示集合与计数是两个独立步骤：计数覆盖全部最优子集；展示时按物品编号排序形成 0/1 选择向量，取**字典序最小**（0 小于 1）的那一套。该平局规则只决定展示哪一套，不减少方案总数。输入物品顺序不影响计数与所选集合。

## 安全范围与限制（默认值）

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| 物品数 | 5000 | `maxItems` |
| 最大容量 | 200000 | `maxCapacity`，必须为非负整数 |
| 单件重量 | 1..1000000 | 正整数 |
| 单件价值 | 0..1000000 | 非负整数，价值总和不超过 2^53-1 |
| 状态表规模 | (n+1)×(C+1) ≤ 5,000,000 | 超限明确拒绝（`LIMIT_EXCEEDED`），不会无限占用内存 |
| 单次对照容量数 | 100 | |

## 构建、测试、启动、演示

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（含枚举对拍）
npm start          # 启动 API 服务（默认自动选择空闲端口并打印）
npm run demo       # 运行内置演示（经典三物品、同值不同编号、零价值、大整数计数）
```

要求 Node.js ≥ 22.5（内置 `node:sqlite`），本项目在 Node 25 上验证通过。数据目录默认为项目内 `./data`，可用环境变量 `KNAPSACK_DATA_DIR` 覆盖。

## CLI

```powershell
node dist/src/cli.js serve --port 0            # 0 = 自动选择空闲端口
node dist/src/cli.js import items.json --note "说明"
node dist/src/cli.js versions
node dist/src/cli.js solve --version 1 --capacity 5
node dist/src/cli.js compare --version 1 --capacities 0,3,5,7,10
node dist/src/cli.js explain --snapshot 1      # 回溯解释
node dist/src/cli.js verify --snapshot 1       # 选中集合重量/价值核验
node dist/src/cli.js history
node dist/src/cli.js export --snapshot 1 --out report.json
node dist/src/cli.js limits
```

物品文件格式：`{"items":[{"id":1,"weight":2,"value":3}, ...], "note":"可选"}`。

## HTTP API

所有错误返回 `{"error":{"code":"...","message":"..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/limits` | 算法版本与各项限制 |
| POST | `/api/items` | 导入物品集，创建物品版本。Body: `{items:[{id,weight,value}], note?}` |
| GET | `/api/versions` | 列出物品版本 |
| POST | `/api/solve` | 求解并保存快照。Body: `{versionId, capacity}` |
| POST | `/api/compare` | 多容量对照。Body: `{versionId, capacities:[...]}`，逐项返回 `status: ok/error` |
| GET | `/api/explain/{snapshotId}` | 回溯解释（每物品的保留/跳过候选、比较与决策理由） |
| GET | `/api/verify/{snapshotId}` | 按物品版本重算选中集合的重量与价值并核验 |
| GET | `/api/history` | 历史快照列表 |
| GET | `/api/export/{snapshotId}` | 导出完整 JSON 报告（含算法版本与原始参数） |

错误码：`VALIDATION`、`BAD_JSON`、`DUPLICATE_ID`、`NEGATIVE_VALUE`、`ZERO_WEIGHT`、`NON_INTEGER_CAPACITY`、`UNKNOWN_VERSION`、`UNKNOWN_SNAPSHOT`、`LIMIT_EXCEEDED`、`NOT_FOUND`、`INTERNAL`。

## 算法说明

1. 物品按编号排序（输入顺序不影响结果）。状态 `V[i][w]` 表示只考虑第 i..n-1 件物品、容量 w 时的最大价值，自底向上填表。
2. 每个状态比较两个候选：保留（`V[i+1][w-wi]+vi`，装不下时为 -∞）与跳过（`V[i+1][w]`），取较大者。
3. 计数表 `C[i][w]` 只累加达到该状态最优值的候选：保留最优则加 `C[i+1][w-wi]`，跳过最优则加 `C[i+1][w]`，两者同值则相加（BigInt，支持任意大方案数）。空集在末行只初始化一次，不会重复计数。
4. 回溯时按"同值优先跳过"生成展示向量：位置越靠前 0 越小，因此得到字典序最小的 0/1 向量；`explain` 输出每一步的两个候选价值、方案数与决策理由，可清楚区分"价值最优"与"平局展示"两个阶段。
5. 计数表只保留两行并记录回溯路径上的关键格子，不把整个大表返回给终端。

## 测试

`npm test` 覆盖：空集、零容量、全部装不下、恰好满容量、容量有余、同值不同重量、同重量同价值不同编号、零价值物品平局、30/60 个同类物品的大整数计数（C(30,15)、C(60,30)）、随机小规模与独立枚举全部子集逐一核对（最大价值/方案数/规范向量）、容量单调性（容量增加最优价值不下降）、输入顺序无关性、参数校验错误码、逐项对照的部分失败状态、以及重启后快照与回溯可读取且不被新数据覆盖。

## 已知限制

- 只做单背包数学选择结果，不含切割排样、多容器、库存预留、支付发货等业务。
- 状态表受 `maxStates` 限制，超大规模输入会被拒绝而非近似求解。
- `node:sqlite` 在 Node 25 仍标记为 experimental（启动时有提示），功能稳定可用；如需消除警告可换 `better-sqlite3`。
