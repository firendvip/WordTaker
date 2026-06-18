/**
 * 文案优化中转 (relay) 的打包期默认配置。
 *
 * 分发给别人前在这里填好你的中转地址与访问令牌，
 * 这样客户端就走「中转」路径：只把待润色文本发到你的中转，
 * 由中转在服务器端补上真实 DeepSeek key 后转发。
 *
 * 客户端里【不包含】真实 DeepSeek key —— 用户无法提取。
 * RELAY_TOKEN 只是访问你中转的令牌，可随时在服务器端轮换吊销。
 *
 * 部署见 relay/tencent-scf/部署步骤.md。
 *
 * 注意：这些值会作为数据库默认设置“仅在缺失时”写入，不会覆盖用户已有配置；
 * 如需强制刷新，分发前清空用户数据库。
 */
module.exports = {
  // 是否默认启用中转。分发版应为 true。
  RELAY_ENABLED: true,
  // 腾讯云云函数 SCF 的函数URL（国内链路）
  RELAY_URL: "https://1311262545-c75hkqrhhx.ap-guangzhou.tencentscf.com",
  // 访问令牌，对应中转的 APP_TOKEN
  RELAY_TOKEN: "64caa0fbd432f49a65269be31e581b19aceab557205b7b24",
};
