# 蛐蛐文案优化中转 (Cloudflare Worker)

让你把软件分发给别人时，**别人能用你的 DeepSeek 额度，却拿不到你的 key**。
真正的 key 只存在这个 Worker 的服务器密钥里，从不下发到用户机器。

```
客户端  ──{ text }──►  你的 Worker  ──{ text + 你的key }──►  DeepSeek
        ◄──{ 润色结果 }──            ◄──────────────────────
```

## 一、部署（约 5 分钟）

需要一个 Cloudflare 账号（免费）。在本目录 `relay/` 下执行：

```bash
# 1. 登录（首次会打开浏览器授权）
npx wrangler login

# 2. 设置真实 DeepSeek key（作为服务器密钥，不会进代码/仓库）
npx wrangler secret put DEEPSEEK_API_KEY
#   粘贴：你的真实 DeepSeek key（sk- 开头那串，切勿写进任何文件/仓库）

# 3. 设置客户端访问令牌（自己随便生成一串，比如用下面命令）
#   openssl rand -hex 24
npx wrangler secret put APP_TOKEN
#   粘贴你生成的令牌

# 4. 发布
npx wrangler deploy
```

部署成功后会得到一个地址，例如：

```
https://ququ-relay.<你的子域>.workers.dev
```

## 二、把地址和令牌填进客户端

编辑 [`src/helpers/relayConfig.js`](../src/helpers/relayConfig.js)：

```js
module.exports = {
  RELAY_ENABLED: true,                                   // 打开中转
  RELAY_URL: "https://ququ-relay.<你的子域>.workers.dev", // 上一步得到的地址
  RELAY_TOKEN: "你在第3步设置的 APP_TOKEN",
};
```

然后重新打包分发。这样：

- 分发出去的客户端里 **没有 DeepSeek key**，只有中转地址和访问令牌。
- 令牌即使被扒出，也只能受限地调用你的中转（做中文润色），**拿不到原始 key**，且你可以随时 `wrangler secret put APP_TOKEN` 轮换吊销。

> 已经装过旧版的用户，本机数据库里可能还残留旧的 `ai_api_key`。分发新版前可在打包脚本里清掉，或在 `relayConfig.js` 开启中转后，客户端走中转路径、不再读取本地 key。

## 三、防止额度被盗刷

1. **DeepSeek 后台设月度消费上限 / 充值告警** —— 最硬的兜底。
2. **令牌轮换** —— 发现异常随时改 `APP_TOKEN` 并发新版。
3. **限流（可选）** —— 绑定 KV 后按 IP 限流：
   ```bash
   npx wrangler kv namespace create RATE_KV
   # 把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]] 并取消注释，再 deploy
   ```
   `RATE_LIMIT_PER_MIN` 控制每 IP 每分钟次数（默认 20）。
4. **Cloudflare 仪表盘的 Rate limiting rules** —— 也可在面板上对该 Worker 路由加规则，零代码。

## 四、本地联调

```bash
npx wrangler dev
# 另开一个终端：
curl -X POST http://127.0.0.1:8787 \
  -H "Content-Type: application/json" \
  -H "X-App-Token: 你的APP_TOKEN" \
  -d '{"text":"那个我我觉得这个方案呢应该是可以的吧"}'
# 预期返回 { "success": true, "text": "我觉得这个方案可以。" }
```

## 安全说明（重要，别给自己虚假的安全感）

- 这个中转方案能保证的是：**DeepSeek key 不下发到用户端，无法被提取**。这正是你的核心诉求。
- 它**不能**保证“别人完全无法消耗你的额度” —— 拿到客户端的人本就被允许调用你的中转。能做的是**限制用途（只做中文润色）+ 限流 + 令牌可吊销 + 上游设消费上限**，把风险压到可控。
- 不要把 `DEEPSEEK_API_KEY` 写进 `wrangler.toml` 或任何会进仓库的文件 —— 一律用 `wrangler secret put`。
