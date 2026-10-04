# 零一背包最优选择与同值方案计数后端

纯后端项目（API + CLI），使用 TypeScript、Node.js 与 SQLite，在 Windows 本地运行，
不依赖 Docker、WSL、付费服务或任何外部在线 API。只做数学选择结果，不涉及支付、发货等外部流程。

## 功能概述

- 整数容量零一背包精确求解：自行实现动态规划，不使用贪心近似或现成求解器。
- 每个物品有唯一编号、正整数重量、非负整数价值，每件至多选一次。
- 输出：最优价值、一套稳定的最优物品集合、达到最优价值的**不同编号子集数量**。
- 方案计数使用 BigInt，以十进制字符串输出（可表示任意大的计数）。
- 同一物品版本可指定一组容量做对照，逐容量输出最优价值、总重、方案数与所选编号，并附重量/价值核验。
- SQLite 保存物品版本与分析快照；快照记录算法版本与原始参数；物品集导入后不可修改，
  修改物品只能导入新版本，绝不覆盖已完成结果。
- 明确的参数校验与错误码，资源上限公开，超限明确拒绝而非无限占用内存。

## 计数的含义（重要）

`bestCount` 表示**达到最优价值 `bestValue` 的不同物品编号子集数量**：

- 两件物品即使重量、价值完全相同，只要编号不同，就视为不同选择。
  例如物品 (2,3)、(3,4)、(4,5) 容量 5 时唯一最优子集是 {1,2}（价值 7）；
  再加入编号 4 的 (3,4) 后，{1,2} 与 {1,4} 都是最优子集，`bestCount` 变为 2。
- 零价值物品会产生额外最优子集（装上它不改变价值），不会被忽略。
- 容量为 0 时只有空集一种方案；物品重量恒为正，空集不会因初始化被重复计数。

**展示集合与计数是两个独立步骤。** 计数汇总所有最优子集；展示只返回其中一套：
按物品编号升序形成 0/1 选择向量，取字典序最小者（0 小于 1，即尽量跳过小编号物品）。
该平局规则不减少方案总数，且输入物品顺序不同不会改变计数与所选集合。

## 算法说明

1. **价值与计数 DP**（一维，容量倒序保证每件至多选一次）：
   - `value[c]` 为容量 c 的最优价值，`count[c]` 为达到该价值的子集数（BigInt，初始全为 1，即空集）。
   - 对每件物品、每个容量 c：候选 `cand = value[c-w] + v`。
     - `cand > value[c]`：采用“选中”候选，`count[c] = count[c-w]`；
     - `cand == value[c]`：**同值合并**，`count[c] += count[c-w]`；
     - 否则保留旧值。
2. **规范回溯**：另建后缀价值表 `S[i][c]`（仅用物品 i..n-1 的最优值），
   按编号升序逐件决策：跳过仍能达到剩余最优值就记 0（字典序最小），否则必须选中记 1。
   回溯路径记录每件物品的保留/跳过候选值与决策原因，可通过解释接口查看。
3. 价值用 Float64 精确表示：受 `maxValue × maxItems ≤ 2×10^12 < 2^53` 限制，无精度问题。

## 安全范围与资源限制（默认值）

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| `maxItems` | 2000 | 物品数上限 |
| `maxCapacity` | 200000 | 容量上限（非负整数） |
| `maxStates` | 5,000,000 | 回溯状态表 `(n+1)*(W+1)` 格子上限，超限返回 `LIMIT_EXCEEDED` |
| `maxWeight` | 1,000,000 | 单件重量上限（正整数） |
| `maxValue` | 1,000,000,000 | 单件价值上限（非负整数） |

大表不会整体返回给终端：API/CLI 只输出结果摘要与回溯路径（每件物品一步），
完整快照存于 SQLite，可按需用 `export` 导出。

## 环境要求

- Node.js ≥ 22.6（推荐 23+；使用内置 `node:sqlite` 与 TypeScript 类型擦除运行，无需原生编译）
- Windows 本地运行；数据目录为项目内 `./data`

## 常用命令

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm test           # 运行测试（含独立枚举核对）
npm run build      # 编译到 dist/
npm run typecheck  # 仅类型检查
npm start          # 启动 API 服务（默认自动选择空闲端口）
npm run demo       # 运行内置演示
```

CLI（`node src/cli.ts <命令>`，构建后也可用 `node dist/cli.js`）：

```powershell
node src/cli.ts serve --port 3000            # 指定端口；省略则自动选空闲端口
node src/cli.ts import examples/items.json --name 经典三物品
node src/cli.ts solve --set 1 --capacity 5
node src/cli.ts solve --items examples/items.json --capacity 5
node src/cli.ts compare --set 1 --capacities 0,2,4,5,7,9
node src/cli.ts explain --analysis 1
node src/cli.ts history
node src/cli.ts export --analysis 1 --out report.json
node src/cli.ts demo
```

## HTTP API

默认监听 `127.0.0.1`，端口 0 表示由操作系统分配空闲端口（启动时打印实际端口）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与当前限制 |
| GET | `/api/limits` | 查看资源限制 |
| POST | `/api/item-sets` | 导入物品集 `{name, items:[{id,weight,value}]}`，返回新版本 id |
| GET | `/api/item-sets` / `/api/item-sets/:id` | 列出 / 读取物品版本 |
| POST | `/api/solve` | 求解 `{setId, capacity}` 或 `{items, capacity}`，返回结果并保存快照 |
| POST | `/api/compare` | 容量对照 `{setId, capacities:[...]}`，逐项状态 |
| GET | `/api/analyses` / `/api/analyses/:id` | 历史报告列表 / 详情 |
| GET | `/api/analyses/:id/explain` | 回溯解释（含计数含义中文说明） |
| GET | `/api/analyses/:id/export` | JSON 导出（附件下载） |

### 批量对照的逐项状态

`POST /api/compare` 返回 `status: ok | partial | failed` 与 `summary {total, ok, failed}`，
每个容量单独记录 `status: ok | error` 及错误码。**部分成功不会被误报为全部完成**；
全部失败时 HTTP 状态为 422。

### 错误码

| 错误码 | HTTP | 触发场景 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 负价值、零重量、非整数容量/编号、非法 JSON 等 |
| `CONFLICT` | 409 | 物品编号重复 |
| `NOT_FOUND` | 404 | 未知物品版本 / 报告 / 路由 |
| `LIMIT_EXCEEDED` | 413 | 物品数、容量、状态表规模等超限 |
| `INTERNAL_ERROR` | 500 | 未预期错误 |

## 测试与演示内容

`npm test` 覆盖：空集（容量 0）、全部装不下、恰好满容量、容量有余、同值不同重量、
大量同类物品的大整数计数（如 C(30,15)=155117520、2^60）、输入顺序无关性、
容量增加时最优价值不下降，并对 200 组随机小规模用例**独立枚举全部子集**，
逐一核对最大价值、方案计数与规范展示向量。

`npm run demo` 演示：经典三物品容量 5（选 {1,2} 价值 7）、加入同重量同价值不同编号
物品后方案数从 1 变 2、零价值物品的平局计数、多容量对照，以及写入 SQLite 后
模拟服务重启再读取报告与回溯。

## 已知限制

- 仅单背包、整数容量；不扩展为切割排样、多容器装载或库存预留。
- 回溯需要 `(n+1)*(W+1)` 的后缀价值表，受 `maxStates` 限制；超大规模实例会被拒绝。
- `node:sqlite` 在 Node 22/23 中标记为 experimental，升级 Node 大版本时建议先跑 `npm test`。
- 服务仅监听本机回环地址，无鉴权，面向本地单机使用。
