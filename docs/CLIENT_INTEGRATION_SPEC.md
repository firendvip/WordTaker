# WordTaker 客户端接入收费后端 — 规格（决策真源）

> 把桌面软件接进 `ai-input-method-server`（账号/额度/计费/邀请/兑换码）。各实现 agent 先读本文件。
> 后端契约见 `ai-input-method-server/docs/BILLING_SPEC.md`。后端本地已在 `http://localhost:3777` 运行。

## 决策（已定）
1. **免登录自动匿名**：客户端在 userData 存一个稳定 `deviceId`(UUID)。所有后端请求带 `x-device-id`（+ `x-platform: mac`、可选 `x-fingerprint`）。匿名设备天然享免费额度（注册赠 1 万字云端）。
2. **云端AI 一律走新后端计费**：engine=cloud 时，润色请求改为 `POST {AI_BACKEND_URL}/api/v1/polish`（带 device 头 + 登录后带 `Authorization: Bearer <jwt>`），后端做鉴权→额度校验→调 DeepSeek→扣字数，返回润色文本 + `cloudRemaining/subscription/dailyUsed`。
   - 额度不足/超日上限：后端返回失败（insufficient_quota / daily_cap_exceeded）→ 客户端**贴原文 + 通知**（提示去购买或改用本地模型），不硬跑、不静默。
   - **降级**：后端不可达时回退旧 relay（保证云端仍可用），并 log；配置项可关。
3. **本地模型不变**：离线免费，不经后端、不计费。
4. **后端地址可配置**：`AI_BACKEND_URL`（默认 `http://localhost:3777`，dev 联调；云端部署后改为 `https://api.look3.cn`）。单一来源，别散落硬编码。
5. **登录**：可选，用于绑定账号（跨设备）、购买、兑换、邀请。**仅支持手机短信验证码**（中国大陆 11 位手机号、6 位数字验证码）；验证通过即登录，未注册手机号由后端自动创建账号。邮箱、密码、微信登录在桌面 UI、preload、IPC 和客户端请求封装中均不提供。JWT 存主进程 userData（非仅 localStorage），渲染层只拿账号摘要。
6. **JWT/身份存储与传输**：token 与 deviceId 由主进程持有并注入请求头；渲染层只经 electronAPI 调用，不直接持有密钥。

## 客户端要对接的后端接口
- 润色（计费）：`POST /api/v1/polish` 头 `x-device-id/x-platform/x-fingerprint`(+Bearer) 体 `{text, mode}` → `{data:{text/润色结果, visibleChars, cloudRemaining, subscription, dailyUsed}}`（字段名以实际响应为准，agent 核对）。
- 额度查询：`GET /api/v1/polish/quota`（device 头，匿名可用）或 `GET /api/v1/quota/status`（Bearer）→ 云端剩余/订阅/当日已用。
- 登录：`POST /api/v1/auth/sms/send`、`POST /api/v1/auth/sms/login`、`GET /api/v1/auth/me`。发码成功须返回 `{success:true,data:{sent:true}}`；登录成功须返回 `{success:true,data:{accessToken,account,...}}`。登录/注册可带 `inviteCode`、`deviceId`。客户端成功发码后倒计时 60 秒；服务端继续负责发码频控、过期、尝试次数限制和一次性消费。固定验证码只允许后端本地 mock 联调，生产必须走真实短信服务。
- 兑换码：`POST /api/v1/redeem {code}`（Bearer）。
- 套餐/下单：`GET /api/v1/payment/plans`、`POST /api/v1/payment/order {planCode,channel}`、`POST /api/v1/payment/mock/pay {orderId}`（dev 直付）。
- 邀请：邀请码在 `auth/me` 的 account.inviteCode。

## 客户端 UI 范围
- **账户/会员 面板**（设置内新增「账户」tab）：登录/退出、云端剩余字数、订阅状态、我的邀请码(可复制/分享)、兑换码输入、套餐购买(dev mock 支付按钮)。
- **登录界面**：只有手机号、短信验证码与可选邀请码；无登录方式切换或其他登录入口。
- **剩余字数可见**：账户 tab 展示；可选在主界面/胶囊附近轻量提示。

## 阶段
- CP1：传输层(config+deviceId+主进程 API client+JWT存储+preload IPC) + 云端润色改走后端(计费+降级) + 额度查询。
- CP2：手机验证码登录 UI + 账号状态。
- CP3：账户/会员 tab（剩余字数/订阅/邀请码/兑换码/购买 mock）。
- CP4：真机测试闭环 + 版本 1.11.0 + CHANGELOG + look3.cn/catlog。

## 非目标
- 短信供应商配置和凭据、真实支付网关、后端云端部署由对应服务负责，客户端不持有供应商密钥。本次仅收敛 WordTaker 桌面登录方式，不修改共用认证服务中其他项目的登录方式，不进行旧账号迁移或删除历史数据。
