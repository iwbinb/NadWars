# NadWars

NadWars 是运行在 **Monad 测试网**上的多人能源攻防策略游戏。玩家在六边形地图上建造供电网络、争夺据点、切断敌方能源，并通过修复和跨区支援争取胜利。新对局持续 **180 秒（3 分钟）**，由智能合约执行规则和结算积分。

在线体验：[nadwars.arenovo.com](https://nadwars.arenovo.com)

## 主要功能

- 八人标准战：两支队伍、四个战区，共享最终比分；另有双人练习模式。
- 链上建造、攻击、断电、修复和跨区支援，按通电据点的占领时间计分。
- 连接 EVM 钱包，通过会话授权执行操作；支持 Gas 代付。
- 实时房间同步、断线恢复、对局回放和交易记录查询。
- 四个战区分别维护状态，减少跨区共享写入；比赛结果以 Monad 合约为准。

## 安装与运行

需要 Node.js 24+、npm，以及支持 Monad 的 Foundry 1.8.0（或支持以下参数的版本）。

```sh
npm ci

# 启动本地 Monad 开发链，保持该终端运行
anvil --network monad --hardfork MonadTen --host 127.0.0.1 --port 18547 \
  --chain-id 31337 --block-time 1 --gas-price 100000000000 \
  --base-fee 100000000000 --quiet
```

在另一个终端启动应用：

```sh
npm run dev -- --host 127.0.0.1 --port 5188 --strictPort
```

打开 `http://127.0.0.1:5188`，连接本地临时钱包并创建房间。使用独立浏览器会话加入同一房间，完成授权和准备后开始对战；标准战需要八位玩家，练习模式需要两位。本地临时钱包仅使用开发链测试币。

构建与基础检查：

```sh
npm run build
npm run test:client
npm run test:protocol

# 修改合约后重新编译并同步前端产物
cd contracts
forge build
cd ..
npm run contracts:sync
```

Cloudflare 部署使用根目录 `wrangler.jsonc` 配置后端，使用 `pages/wrangler.jsonc` 配置 Pages。先将其中的服务名称改为自己的项目名称，再构建和发布：

```sh
npm run build
npx wrangler deploy
npm run pages:build
npm run pages:deploy
```

Pages 的 `NADWARS_API` 绑定需指向后端 Worker。代付功能需要通过 Worker Secret `RELAY_KEYS` 配置四个专用测试网钱包私钥组成的 JSON 数组，并给钱包充值测试币；未配置代付时，将 `SPONSOR_ENABLED` 设为 `false`。私钥不可写入源码或 `VITE_*` 环境变量。

## 技术栈

- 前端：React、Vite、viem。
- 合约：Solidity 0.8.30、Foundry、Monad EVM。
- 服务：Cloudflare Pages、Workers、Durable Objects、WebSocket。
