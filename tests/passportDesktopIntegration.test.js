import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Electron passport integration contract", () => {
  it("keeps the default package unregistered and isolates the exact protocol to candidate builds", () => {
    const packageJson = JSON.parse(read("package.json"));
    expect(packageJson.build.protocols || []).toEqual([]);
    const candidate = read("electron-builder.passport-candidate.cjs");
    expect(candidate).toContain("wordtakerPassportCandidate: true");
    expect(candidate).toContain("protocols:");
    expect(candidate).toContain('"wangsan-wordtaker"');
    expect(candidate.match(/wangsan-wordtaker/g)).toHaveLength(1);
    expect(candidate).toContain("Wangsan WordTaker OAuth");
    expect(candidate).not.toContain("client_secret");
    expect({
      name: "Wangsan WordTaker OAuth",
      schemes: ["wangsan-wordtaker"],
    }).toEqual(expect.any(Object));
  });

  it("handles macOS open-url and Windows/Linux second-instance argv in main", () => {
    const source = read("main.js");
    expect(source).toContain('app.on("open-url"');
    expect(source).toMatch(/second-instance[\s\S]{0,300}argv/);
    expect(source).toContain("setAsDefaultProtocolClient");
    expect(source).toMatch(/passportAuthManager\s*\.handleCallback/);
  });

  it("exposes only high-level passport IPC and never tokens or a client secret to renderer", () => {
    const preload = read("preload.js");
    expect(preload).toContain("authPassportLogin");
    expect(preload).toContain("onPassportAuthResult");
    expect(preload).toContain("createPassportPreloadApi");
    expect(preload).not.toMatch(/getAccessToken|getRefreshToken|getIdToken/);
    expect(preload).not.toContain("client_secret");
  });

  it("makes unified browser login primary while retaining clearly labelled legacy AIM fallback", () => {
    const accountPanel = read("src/components/account/AccountPanel.jsx");
    expect(accountPanel).toContain("望三通行证登录");
    expect(accountPanel).toContain("旧版登录（兼容）");
    expect(accountPanel).toContain("authPassportLogin");
    const loggedInPanel = accountPanel.slice(
      accountPanel.indexOf("if (isLoggedIn)"),
      accountPanel.indexOf("// 未登录：会员区块"),
    );
    expect(loggedInPanel).toContain('account.authProvider !== "passport"');
    expect(loggedInPanel).toContain("handlePassportLogin");
    expect(loggedInPanel).toContain("验证望三通行证");
    expect(accountPanel).not.toMatch(/localStorage\.(setItem|getItem)[\s\S]{0,80}(token|auth)/i);
  });

  it("waits for AIM identity proof before exposing Passport account or quota state", () => {
    const accountPanel = read("src/components/account/AccountPanel.jsx");
    const authResultHandler = accountPanel.slice(
      accountPanel.indexOf("onPassportAuthResult"),
      accountPanel.indexOf("// 启动时读取本地登录态"),
    );
    expect(authResultHandler).toContain(
      'if (result.provider === "legacy") setAccount(result.account || {})',
    );
    expect(authResultHandler).not.toContain("refreshQuota()");
    expect(authResultHandler).toContain("refreshAccount().then");
    expect(accountPanel).toMatch(/IDENTITY_CONFLICT[\s\S]{0,300}clearQuota\(\)/);

    const quotaHook = read("src/components/account/useCloudQuota.js");
    expect(quotaHook).toContain("requestGenerationRef");
    expect(quotaHook).toContain("requestGeneration !== requestGenerationRef.current");
  });

  it("ships a default-off G6 kill switch that gates login, callback and UI", () => {
    const main = read("main.js");
    const handlers = read("src/helpers/ipcHandlers.js");
    const accountPanel = read("src/components/account/AccountPanel.jsx");
    expect(main).toContain("WORDTAKER_PASSPORT_ENABLED");
    expect(main).toMatch(/deliverPassportCallback[\s\S]{0,180}!PASSPORT_ROLLOUT_ENABLED/);
    expect(main).toMatch(
      /if \(PASSPORT_ROLLOUT_ENABLED\) \{[\s\S]{0,500}setAsDefaultProtocolClient/,
    );
    expect(handlers).toContain("PASSPORT_DISABLED");
    expect(handlers).toMatch(/if \(this\.passportEnabled\) \{[\s\S]{0,900}auth-passport-login/);
    expect(handlers).toMatch(
      /auth-logout[\s\S]{0,420}if \(this\.passportAuthManager\)[\s\S]{0,120}\.logout\(\)/,
    );
    expect(accountPanel).toContain("passportEnabled &&");
  });

  it("proves AIM mapping only through passport auth/me and never auto-creates or blends accounts", () => {
    const backendClient = read("src/helpers/backendClient.js");
    const handlers = read("src/helpers/ipcHandlers.js");
    const mapper = read("src/helpers/passportAimMapper.js");
    expect(backendClient).not.toContain("markPassportAimApiAccepted(");
    expect(backendClient).toContain('authPurpose: "aim-mapping"');
    expect(backendClient).toContain("getAccessTokenCandidates({ method, purpose: authPurpose })");
    expect(handlers).toContain("this.passportAimMapper.resolve()");
    expect(mapper).toContain("evaluateAimMapping({");
    expect(mapper).toContain("const authProvider = authResult?.authProvider || null");
    expect(mapper).toContain("authenticatedIdentity: authResult?.authIdentity || null");
    expect(mapper).toContain('code: invalidated ? "IDENTITY_CONFLICT"');
    expect(mapper).toContain(
      "tokenStore.markPassportAimApiAccepted(true, decision.aimUserId)",
    );
    expect(mapper).not.toMatch(/(?:create|insert)(?:User|Account)\s*\(/);
  });

  it("restricts auth IPC/results to the settings main frame and describes local logout only", () => {
    const main = read("main.js");
    const handlers = read("src/helpers/ipcHandlers.js");
    const accountPanel = read("src/components/account/AccountPanel.jsx");
    expect(main).toContain("windowManager.settingsWindow");
    expect(main).toContain("isTrustedSettingsUrl(rendererUrl");
    expect(main).not.toMatch(/BrowserWindow\.getAllWindows\(\)[\s\S]{0,180}passport-auth-result/);
    expect(handlers).toContain("event?.senderFrame !== settingsContents.mainFrame");
    expect(handlers).toMatch(/auth-logout[\s\S]{0,180}isTrustedRenderer/);
    expect(accountPanel).toContain("已退出弦外小猫，不影响其他应用的登录状态");
    expect(accountPanel).not.toMatch(/全局退出|global logout/i);
    const windows = read("src/helpers/windowManager.js");
    const settingsFactory = windows.slice(
      windows.indexOf("async createSettingsWindow"),
      windows.indexOf("showControlPanel()"),
    );
    expect(settingsFactory).toContain(
      'this.settingsWindow.webContents.on("will-navigate", blockUntrustedNavigation)',
    );
    expect(settingsFactory).toContain(
      'this.settingsWindow.webContents.on("will-redirect", blockUntrustedNavigation)',
    );
    expect(settingsFactory).toContain(
      'this.settingsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))',
    );
  });

  it("applies the same trusted-renderer and durable-storage boundary to legacy fallback auth", () => {
    const handlers = read("src/helpers/ipcHandlers.js");
    for (const channel of [
      "auth-sms-send",
      "auth-sms-login",
      "auth-email-send",
      "auth-email-login",
      "auth-wechat-login",
    ]) {
      const offset = handlers.indexOf(`ipcMain.handle(\"${channel}\"`);
      expect(offset).toBeGreaterThan(-1);
      expect(handlers.slice(offset, offset + 320)).toContain("isTrustedRenderer(event)");
    }
    expect(handlers).toMatch(/const stored = tokenStore\.setLegacy[\s\S]{0,220}SECURE_STORAGE_REQUIRED/);
    expect(handlers).toMatch(
      /tokenStore\.setLegacy[\s\S]{0,500}passportAuthManager\?\.drainPendingRevocations/,
    );
    expect(handlers).not.toMatch(
      /if \(this\.passportEnabled\) \{\s*this\.passportAuthManager\?\.drainPendingRevocations/,
    );
    const mapper = read("src/helpers/passportAimMapper.js");
    expect(mapper).toMatch(/error\?\.status === 409[\s\S]{0,1200}invalidatePassport\(\)/);
  });

  it("invalidates every actually rejected credential through the auth epoch coordinator", () => {
    const main = read("main.js");
    const backendClient = read("src/helpers/backendClient.js");
    expect(main).toContain("createAuthFailureHandler");
    expect(main).toContain("backendClient.setAuthFailureHandler");
    expect(main).toContain("createPassportAimMapper");
    expect(main).toContain("passportAimMapper.resolve()");
    expect(backendClient).toContain("rejectedProviders");
    expect(backendClient).toContain("authIdentity");
  });

  it("preflights sensitive AIM writes with a forced userinfo check", () => {
    const main = read("main.js");
    const backendClient = read("src/helpers/backendClient.js");
    const mapper = read("src/helpers/passportAimMapper.js");
    expect(backendClient).toContain("SENSITIVE_AUTH_PATHS");
    expect(backendClient).toContain("sensitiveAuthPreflightHandler");
    const sensitivePaths = backendClient.slice(
      backendClient.indexOf("const SENSITIVE_AUTH_PATHS"),
      backendClient.indexOf("function setAuthFailureHandler"),
    );
    expect(sensitivePaths).toContain('"/polish"');
    expect(sensitivePaths).toContain('"/payment/order"');
    expect(sensitivePaths).toContain('"/redeem"');
    expect(main).toContain("setSensitiveAuthPreflightHandler");
    expect(main).toContain("shouldPreflightSensitivePassport");
    expect(main).toContain("authSnapshot.credentials");
    expect(main).toContain("refreshAuthSnapshot: true");
    expect(main).toContain("approvedCredential: result.authEvidence");
    expect(mapper).toContain("ensureSessionReady({ forceProfile: sensitive })");
    expect(read("src/helpers/ipcHandlers.js")).toContain(
      "tokenStore.getLegacy() || (this.passportEnabled && tokenStore.getPassport())",
    );
    const ipcHandlers = read("src/helpers/ipcHandlers.js");
    const billingStart = ipcHandlers.indexOf("setupBillingHandlers() {");
    const billingHandlers = ipcHandlers.slice(
      billingStart,
      ipcHandlers.indexOf("setupAuthHandlers() {", billingStart),
    );
    expect(billingHandlers).not.toContain('code: "UNAUTHORIZED"');
    expect(billingHandlers.match(/code: "AUTH_REQUIRED"/g)).toHaveLength(3);
    for (const channel of ["create-order", "mock-pay", "redeem-code"]) {
      const offset = billingHandlers.indexOf(`ipcMain.handle("${channel}"`);
      expect(offset).toBeGreaterThan(-1);
      expect(billingHandlers.slice(offset, offset + 260)).toContain(
        "this.isTrustedSettingsRenderer(event)",
      );
    }
  });
});
