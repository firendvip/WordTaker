// AI 文案处理服务：严格只走云端中继（relay）。
// 系统提示词只存在于中继的私有环境变量中，客户端不持有、也不构建任何提示词。
// 中继未配置/不可达时直接返回失败，由上层的「回退粘贴识别原文」逻辑兜底。
// 从 ipcHandlers.js 拆出，便于维护与单测。

// 已去除「请求时间超时主动 abort」兜底（按用户要求）：长语音转写润色可能耗时较久，
// 时间超时 abort 会把长文本润色请求中途中断并回退直贴原文（已确诊 BUG）。
// 现在不再因时间到而中断请求；仍保留对瞬时错误(429/5xx)与网络异常的重试。
async function fetchNoTimeout(url, options = {}) {
  return await fetch(url, options);
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在 fetch 之上加指数退避重试：仅对瞬时错误(429/5xx)与网络异常重试，最多 2 次。
// 不再设置时间超时，长请求会一直等待上游返回。
const MAX_FETCH_ATTEMPTS = 2;
async function fetchWithRetry(url, options = {}) {
  const backoff = [2000];
  let lastErr;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    const isLast = attempt >= MAX_FETCH_ATTEMPTS - 1;
    try {
      const res = await fetchNoTimeout(url, options);
      if ((res.status === 429 || res.status >= 500) && !isLast) {
        await _sleep(backoff[attempt]);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (!isLast) { await _sleep(backoff[attempt]); continue; }
      throw e;
    }
  }
  throw lastErr || new Error("fetch failed");
}

// 阶梯提醒阈值（云端剩余字数跨过时各提醒一次；充值回升后天然重新武装）。
const QUOTA_ALERT_THRESHOLDS = [1000, 500, 100];
// 「上一次记录的剩余」持久化键；默认给一个很大的数，保证首次不误报。
const QUOTA_ALERT_PREV_KEY = 'quota_alert_prev_remaining';
const QUOTA_ALERT_PREV_DEFAULT = 1e12;
// 额度快照最大有效期（超过则重新拉取；充值后 15s 内会自动过期→自动切回云端）。
const QUOTA_SNAP_MAX_AGE_MS = 15000;
// 「请登录」类系统通知的节流间隔：每次录音都提示会烦，10 分钟内只提示一次。
const LOGIN_NOTIFY_THROTTLE_MS = 10 * 60 * 1000;

class AiService {
  constructor({ databaseManager, logger, llmManager = null }) {
    this.databaseManager = databaseManager;
    this.logger = logger;
    // 本地 LLM 管理器（可选注入）。polish_engine 为 local-* 时经它推理。
    this.llmManager = llmManager;
    // 内存额度快照：{ cloudRemaining, subActive, fetchedAt }。用于逐句降级判断。
    this._quotaSnap = null;
    // 提醒回调（main.js 注入，通常指向 trayManager.startAttention）。未注入则安全降级。
    this._notifier = null;
    // 上次「请登录」类通知时间戳（内存态，重启重置），配合 LOGIN_NOTIFY_THROTTLE_MS 节流。
    this._lastLoginNotifyAt = 0;
  }

  // 注入提醒回调（payload:{title, body}）。main.js 里传 (p)=>trayManager.startAttention(p)。
  setNotifier(fn) {
    this._notifier = typeof fn === 'function' ? fn : null;
  }

  // 统一触发提醒：优先走注入的 notifier；未注入时兜底直接弹系统通知，绝不抛出。
  _notify(title, body) {
    try {
      if (this._notifier) { this._notifier({ title, body }); return; }
      const { Notification } = require('electron');
      if (Notification) new Notification({ title: title || '弦外小猫', body: body || '', silent: false }).show();
    } catch (e) {
      this.logger.warn && this.logger.warn('提醒触发失败:', e?.message || e);
    }
  }

  // 确保额度快照新鲜：无快照或超过 maxAgeMs 就 GET /quota 刷新。任何异常保留旧快照、不抛出。
  async ensureQuotaFresh(maxAgeMs = QUOTA_SNAP_MAX_AGE_MS) {
    const now = Date.now();
    if (this._quotaSnap && (now - this._quotaSnap.fetchedAt) < maxAgeMs) return this._quotaSnap;
    try {
      const backendClient = require('./backendClient');
      const q = await backendClient.getQuota();
      const remaining = Number.isFinite(Number(q.cloudRemaining)) ? Number(q.cloudRemaining) : null;
      const subActive = !!(q.subscription && q.subscription.active);
      this._quotaSnap = { cloudRemaining: remaining, subActive, fetchedAt: now };
      // 充值回升的「重新武装」：以权威 getQuota 为准，若余额高于当前提醒基准则抬回，
      // 使后续再次下降到各档时能重新提醒（并发安全：getQuota 才是唯一可信的回升来源）。
      if (!subActive && remaining != null) {
        const prevRaw = this.databaseManager.getSetting(QUOTA_ALERT_PREV_KEY, QUOTA_ALERT_PREV_DEFAULT);
        const prev = Number.isFinite(Number(prevRaw)) ? Number(prevRaw) : QUOTA_ALERT_PREV_DEFAULT;
        if (remaining > prev) this.databaseManager.setSetting(QUOTA_ALERT_PREV_KEY, remaining);
      }
    } catch (e) {
      this.logger.warn && this.logger.warn('刷新额度快照失败，沿用旧快照:', e?.message || e);
    }
    return this._quotaSnap;
  }

  // 云端润色成功后调用：更新快照，并做「阶梯提醒」（仅未订阅时）。remaining 为最新剩余。
  _onCloudSuccess(remaining, subActive) {
    const cur = Number.isFinite(Number(remaining)) ? Number(remaining) : null;
    this._quotaSnap = { cloudRemaining: cur, subActive: !!subActive, fetchedAt: Date.now() };
    if (subActive || cur == null) return; // 订阅用户不提醒
    try {
      const prevRaw = this.databaseManager.getSetting(QUOTA_ALERT_PREV_KEY, QUOTA_ALERT_PREV_DEFAULT);
      const prev = Number.isFinite(Number(prevRaw)) ? Number(prevRaw) : QUOTA_ALERT_PREV_DEFAULT;
      // 并发保护：云端响应可能乱序到达。这里只在余额「下降」（消耗）时处理跨档并下移基准；
      // 余额回升（充值）一律不在此处理，交由 ensureQuotaFresh 用权威 getQuota 重新武装，
      // 避免乱序到达的旧响应（较高 cur）把 prev 覆盖高，造成漏报或重复提醒。
      if (cur >= prev) return;
      // 找本次跨过的最紧迫（最小）档：prev > T 且 cur <= T
      let crossed = null;
      for (const T of QUOTA_ALERT_THRESHOLDS) {
        if (prev > T && cur <= T) crossed = crossed == null ? T : Math.min(crossed, T);
      }
      if (crossed != null) {
        this._notify('弦外小猫', `云端剩余字数不足 ${crossed} 字（当前 ${cur} 字），可到 设置→账户 充值。`);
      }
      this.databaseManager.setSetting(QUOTA_ALERT_PREV_KEY, cur);
    } catch (e) {
      this.logger.warn && this.logger.warn('阶梯提醒处理失败:', e?.message || e);
    }
  }

  // 当前润色引擎：cloud（云端AI，默认） / local-4b（本地）。
  // 默认 cloud。任何异常一律回退默认引擎。
  async getPolishEngine() {
    try {
      const engine = await this.databaseManager.getSetting('polish_engine', 'cloud');
      const valid = ['cloud', 'local-4b'];
      return valid.includes(engine) ? engine : 'cloud';
    } catch (e) {
      return 'cloud';
    }
  }

  // 当前润色「角色」解析为 LLM mode：gaoeq→'gaoeq'，normal→'normal'，其余（含 vibecoding）→'copywriting'。
  async getPolishMode() {
    try {
      const role = await this.databaseManager.getSetting('llm_active_role', 'normal');
      if (role === 'gaoeq') return 'gaoeq';
      if (role === 'normal') return 'normal';
      return 'copywriting';
    } catch (e) {
      return 'copywriting';
    }
  }

  // 读取并解析「词转词」规则：返回 [{from,to}, ...]，仅保留 from/to 均非空的项。
  // 任何解析异常一律降级为空数组，绝不抛出，保证不影响主润色链路。
  async getWordMapRules() {
    try {
      const raw = await this.databaseManager.getSetting('wtw_rules_json', '[]');
      const arr = JSON.parse(typeof raw === 'string' ? raw : '[]');
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          from: typeof r.from === 'string' ? r.from.trim() : '',
          to: typeof r.to === 'string' ? r.to.trim() : '',
        }))
        .filter((r) => r.from && r.to);
    } catch (e) {
      return [];
    }
  }

  // 「转英文」：把选中文本翻译成地道英文。严格只走中转（key 与提示词都留在服务器端）。
  async translateToEnglish(text) {
    if (typeof text !== 'string' || !text.trim()) return { success: false, error: '无有效文本' };
    return await this.processTextWithAI(text, 'translate-en');
  }

  // 录音开始时预热到中转/直连的网络连接（TLS+TCP），与说话时间重叠，
  // 之后真正的润色请求复用同一连接，省去握手（短句场景收益最明显）。
  async prewarm() {
    try {
      const relayEnabled = await this.databaseManager.getSetting('llm_relay_enabled', false);
      const relayUrl = await this.databaseManager.getSetting('llm_relay_url', '');
      if (relayEnabled && relayUrl) {
        // 中转支持 OPTIONS→204，最轻量地建连
        await fetchNoTimeout(relayUrl, { method: 'OPTIONS' });
      } else {
        const baseUrl = await this.databaseManager.getSetting('ai_base_url', 'https://api.deepseek.com');
        await fetchNoTimeout(baseUrl, { method: 'HEAD' });
      }
    } catch (e) {
      // 预热失败无所谓，正常请求会自行建连
    }
  }

  // 流式润色：经 Web 函数中转，边收边回调 onDelta(增量文本)。返回 { success, text:全文 }。
  // 仅在中转为「Web 函数」(支持流式)时可用；普通事件函数中转不要走这里。
  async processTextViaRelayStream(text, mode, relayUrl, onDelta) {
    try {
      const token = await this.databaseManager.getSetting('llm_relay_token', '');
      const deviceId = await this.databaseManager.getSetting('device_id', '');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-App-Token'] = token;
      if (deviceId) headers['X-Device-Id'] = deviceId;

      // 词转词规则：非空时随请求带上 word_map（relay 端将来更新后据此替换）
      const wordMap = await this.getWordMapRules();

      this.logger.info('AI文案处理(中转·流式)请求:', { mode, inputLength: text.length, wordMapCount: wordMap.length });

      const body = { text, mode, stream: true };
      if (wordMap.length > 0) body.word_map = wordMap;

      // 流式不重试(重试会重复输出)。已去除时间超时：长文本流式润色可能持续较久，
      // 不再因时间到而 abort/cancel 请求，让流自然读到 done 结束。
      const response = await fetchNoTimeout(relayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body) {
        return { success: false, error: `中转服务错误: ${response.status}` };
      }

      // 已去除流式空闲看门狗(STREAM_IDLE_TIMEOUT_MS)与硬上限(STREAM_HARD_CAP_MS)：
      // 这两个超时会因时间到而 cancel reader，导致长文本润色被中途截断（已确诊 BUG）。
      // 现在只按正常的 done / 空返回判断成败。
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let sawDone = false; // 是否收到 done 终止标记；未收到即视为流被截断=错误
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line);
              if (j.d) { full += j.d; if (typeof onDelta === 'function') onDelta(j.d); }
              else if (j.done) { sawDone = true; if (typeof j.text === 'string' && j.text) full = j.text; }
            } catch { /* 跳过坏行 */ }
          }
        }
      } finally {
        try { reader.cancel(); } catch (e) { /* 忽略 */ }
      }
      const out = full.trim();
      if (!out) return { success: false, error: '流式返回为空' };
      // 流在未收到 done 终止标记的情况下结束=被上游截断，按错误返回防止吞掉不完整结果
      if (!sawDone) return { success: false, error: '流式响应未完成（缺少结束标记）' };
      this.logger.info('AI文案处理(中转·流式)完成:', { outputLength: out.length });
      return { success: true, text: out, engine: 'cloud' };
    } catch (error) {
      this.logger.error('流式中转请求失败:', error?.message || error);
      return { success: false, error: '无法连接文案中转服务(流式)' };
    }
  }

  // 流式润色路由（供 process-text-stream 使用），四引擎互不兜底：
  //   cloud   → 中转流式（需 relay 已配置，调用方已校验）
  //   local-* → 本地 LLM 流式（onDelta 逐段回调）
  // 返回 { success, text?, error? }。所选引擎失败直接返回错误，绝不换引擎。
  // 云端逐句降级决策（仅 engine==='cloud' 时调用）：
  //  返回 { action: 'cloud' | 'local' | 'passthrough' }
  //   - cloud      → 正常走云端（已订阅、或余额足够、或快照缺失时保守走云端）
  //   - local      → 余额不足且本地模型就绪 → 本句临时改用本地
  //   - passthrough → 余额不足且本地未就绪 → 原文直接上屏（不润色，保证不丢字）
  //  只在此判断，不改数据库里的 polish_engine 用户设置。
  async _resolveCloudDegrade(text) {
    const snap = await this.ensureQuotaFresh();
    if (!snap) return { action: 'cloud' }; // 拿不到额度信息，保守走云端（云端自身会处理额度错误）
    if (snap.subActive) return { action: 'cloud' }; // 订阅=不限量，不降级
    const remaining = snap.cloudRemaining;
    const needed = (typeof text === 'string' ? text.length : 0);
    if (remaining == null || remaining >= needed) return { action: 'cloud' };
    // 余额不足：本地就绪→降级本地；否则→原文直贴
    const localReady = !!(this.llmManager && typeof this.llmManager.isModelReady === 'function'
      && this.llmManager.isModelReady('local-4b'));
    // 关键决策落日志：enhanced_by_ai=false 的「额度用尽」根因必须能从 app.log 一眼看出。
    this.logger.warn('云端降级决策: 余额不足', {
      action: localReady ? 'local' : 'passthrough',
      cloudRemaining: remaining,
      needed,
    });
    return { action: localReady ? 'local' : 'passthrough' };
  }

  // 原文直贴（passthrough）返回结构：与润色成功一致，text=原文，engine 标注 'passthrough'。
  _passthroughResult(text) {
    return { success: true, text: (typeof text === 'string' ? text : ''), engine: 'passthrough' };
  }

  // 「请登录」类通知节流：10 分钟内只提示一次（每次录音都弹会烦）。
  // 现仅供 401 过期/额度类错误场景复用（未登录已不再前置拦截云端请求）。
  _notifyLoginThrottled(body) {
    const now = Date.now();
    if (now - this._lastLoginNotifyAt < LOGIN_NOTIFY_THROTTLE_MS) return;
    this._lastLoginNotifyAt = now;
    this._notify('弦外小猫', body);
  }

  // 本地 4B 模型是否就绪（登录降级/额度降级共用判断）。
  _isLocalReady() {
    return !!(this.llmManager && typeof this.llmManager.isModelReady === 'function'
      && this.llmManager.isModelReady('local-4b'));
  }

  async processTextStreamRouted(text, mode, relayUrl, onDelta) {
    const engine = await this.getPolishEngine();
    if (engine === 'cloud') {
      // 未登录也可用云端：backendClient 匿名带 X-Device-Id（设备赠送额度），不做登录前置拦截。
      // 逐句降级判断（余额不足→本地/直贴），只影响 cloud 分支
      const d = await this._resolveCloudDegrade(text);
      if (d.action === 'local') {
        this._notify('弦外小猫', '云端字数不足，本句已自动改用本地模型。充值后会自动切回云端。');
        // 本地流式：processTextViaLocal 支持 onDelta 逐段回调
        return await this.processTextViaLocal('local-4b', text, mode, onDelta);
      }
      if (d.action === 'passthrough') {
        this._notify('弦外小猫', '云端字数已用尽，本地模型未安装：本句已直接上屏（未润色）。请到 设置→转写与润色→模型 下载本地模型，或去 设置→账户 充值。');
        return this._passthroughResult(text);
      }
      return await this.processTextViaRelayStream(text, mode, relayUrl, onDelta);
    }
    return await this.processTextViaLocal(engine, text, mode, onDelta);
  }

  async processTextViaRelay(text, mode, relayUrl) {
    try {
      const token = await this.databaseManager.getSetting('llm_relay_token', '');
      const deviceId = await this.databaseManager.getSetting('device_id', '');
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-App-Token'] = token;
      if (deviceId) headers['X-Device-Id'] = deviceId; // 供中转端按设备限流

      // 词转词规则：非空时随请求带上 word_map，relay 端将来更新后据此替换（当前 relay 会忽略，无害）
      const wordMap = await this.getWordMapRules();

      this.logger.info('AI文案处理(中转)请求:', { mode, inputLength: text.length, wordMapCount: wordMap.length });

      const body = { text, mode };
      if (wordMap.length > 0) body.word_map = wordMap;

      const response = await fetchWithRetry(relayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        let msg = `中转服务错误: ${response.status}`;
        try {
          const j = JSON.parse(errText);
          if (j && j.error) msg = j.error;
        } catch { /* 保留默认 */ }
        return { success: false, error: msg };
      }

      const data = await response.json();
      if (data && data.success && typeof data.text === 'string' && data.text.trim()) {
        this.logger.info('AI文案处理(中转)响应:', { outputLength: data.text.length });
        return { success: true, text: data.text.trim() };
      }
      return { success: false, error: (data && data.error) || '中转返回数据异常' };
    } catch (error) {
      this.logger.error('中转请求失败:', error?.message || error);
      return { success: false, error: '无法连接文案中转服务' };
    }
  }

  // 按 polish_engine 路由润色，四引擎「互不兜底」：
  //   cloud     → 现有云端中继(relay)
  //   local-*   → 本地 LLM（llmManager）
  // 所选引擎失败一律返回 { success:false, error }，绝不回退到其它引擎或云端。
  async processTextWithAI(text, mode = 'optimize') {
    const engine = await this.getPolishEngine();
    if (engine === 'cloud') {
      // 未登录也可用云端：backendClient 匿名带 X-Device-Id（设备赠送额度），不做登录前置拦截。
      // 逐句降级判断（余额不足→本地/直贴），只影响 cloud 分支
      const d = await this._resolveCloudDegrade(text);
      if (d.action === 'local') {
        this._notify('弦外小猫', '云端字数不足，本句已自动改用本地模型。充值后会自动切回云端。');
        return await this.processTextViaLocal('local-4b', text, mode);
      }
      if (d.action === 'passthrough') {
        this._notify('弦外小猫', '云端字数已用尽，本地模型未安装：本句已直接上屏（未润色）。请到 设置→转写与润色→模型 下载本地模型，或去 设置→账户 充值。');
        return this._passthroughResult(text);
      }
      return await this.processTextViaCloud(text, mode);
    }
    // 本地引擎
    return await this.processTextViaLocal(engine, text, mode);
  }

  // 云端路径：一律走收费后端(ai-input-method-server)计费润色。
  //  - 成功 → 返回润色文本，并把 cloudRemaining/subscription/dailyUsed 带回（供账户面板/提示）。
  //  - 额度不足/超日上限（INSUFFICIENT_QUOTA / DAILY_CAP_EXCEEDED）→ 结构化失败(reason)，
  //    上层贴原文 + 通知，不硬跑、不自动转本地。
  //  - 后端不可达（network/timeout）→ 按 BACKEND_CLOUD_FALLBACK_RELAY 降级回退旧 relay。
  async processTextViaCloud(text, mode = 'optimize') {
    let backendClient, backendConfig;
    try {
      backendClient = require('./backendClient');
      backendConfig = require('./backendConfig');
    } catch (e) {
      this.logger.error('后端 client 加载失败，回退 relay:', e?.message || e);
      return await this.processViaRelayFallback(text, mode, '后端模块加载失败');
    }

    try {
      // 词转词规则：非空时随请求带上 word_map，让默认云端计费通路也生效（与 relay 一致）
      const wordMap = await this.getWordMapRules();
      const out = await backendClient.polish(text, mode, wordMap);
      if (out && typeof out.text === 'string' && out.text.trim()) {
        this.logger.info('AI文案处理(后端·云端)完成:', {
          outputLength: out.text.length,
          cloudRemaining: out.cloudRemaining,
        });
        // 更新额度快照 + 阶梯提醒（未订阅时跨过 1000/500/100 各提醒一次）
        this._onCloudSuccess(out.cloudRemaining, !!(out.subscription && out.subscription.active));
        return {
          success: true,
          text: out.text.trim(),
          engine: 'cloud',
          cloudRemaining: out.cloudRemaining,
          subscription: out.subscription,
          dailyUsed: out.dailyUsed,
          dailyCap: out.dailyCap,
        };
      }
      return { success: false, error: '后端返回数据异常' };
    } catch (err) {
      const kind = err && err.kind;
      const code = err && err.code;

      // 401 NOT_LOGGED_IN（token 过期/失效）：清 token + 降级本地/直贴 + 通知重新登录。
      if (code === 'NOT_LOGGED_IN' || (kind === 'http' && err.status === 401)) {
        try {
          require('./tokenStore').clear();
        } catch (e) { /* 清除失败不阻断降级 */ }
        const localReady = this._isLocalReady();
        this.logger.warn('云端润色 401，登录已过期，清 token 并降级:', {
          action: localReady ? 'local' : 'passthrough',
        });
        // 过期通知直接发（一次性事件：清 token 后后续走未登录节流路径），并同步节流时间戳防紧跟着重复弹
        this._lastLoginNotifyAt = Date.now();
        this._notify('弦外小猫', localReady
          ? '登录已过期，请重新登录。本句已自动改用本地模型。'
          : '登录已过期，请重新登录。本句已直接上屏（未润色）。');
        if (localReady) return await this.processTextViaLocal('local-4b', text, mode);
        return this._passthroughResult(text);
      }

      // 额度不足 / 超日上限：结构化失败，绝不回退 relay、绝不转本地。
      if (code === 'INSUFFICIENT_QUOTA' || code === 'DAILY_CAP_EXCEEDED') {
        const reason = code === 'DAILY_CAP_EXCEEDED' ? 'daily_cap_exceeded' : 'insufficient_quota';
        this.logger.warn('云端额度受限:', { code, message: err.message });
        return {
          success: false,
          error: err.message || '云端额度不足',
          reason,
        };
      }

      // 后端不可达（连接失败/超时）：按开关降级回退旧 relay，保证云端仍可用。
      if (kind === 'network' || kind === 'timeout') {
        const fallbackOn = backendConfig.BACKEND_CLOUD_FALLBACK_RELAY !== false;
        this.logger.warn(`后端不可达(${kind})，${fallbackOn ? '降级回退 relay' : '不回退'}:`, err.message);
        if (fallbackOn) {
          return await this.processViaRelayFallback(text, mode, `后端不可达(${kind})`);
        }
        return { success: false, error: '云端服务暂不可用' };
      }

      // 其它后端错误（如 4xx/5xx 非额度类）：直接失败，不回退。
      this.logger.error('后端润色失败:', { kind, code, message: err?.message });
      return { success: false, error: err?.message || '云端润色失败' };
    }
  }

  // 降级回退：走旧 relay（原云端中继逻辑）。relay 未配置则返回失败。
  async processViaRelayFallback(text, mode, why) {
    const relayEnabled = await this.databaseManager.getSetting('llm_relay_enabled', false);
    const relayUrl = await this.databaseManager.getSetting('llm_relay_url', '');
    if (!relayEnabled || !relayUrl) {
      this.logger.warn(`${why}，且未配置 relay，云端不可用`);
      return { success: false, error: '云端服务暂不可用' };
    }
    return await this.processTextViaRelay(text, mode, relayUrl);
  }

  // 本地 LLM 路径：所选本地引擎推理；管理器缺失/模型未就绪/推理失败一律返回错误，
  // 绝不回退云端或其它本地模型（无兜底）。onDelta 可选（非流式主路径不传）。
  async processTextViaLocal(engine, text, mode = 'optimize', onDelta = null) {
    if (!this.llmManager) {
      this.logger.error('本地 LLM 管理器未初始化');
      return { success: false, error: '本地 LLM 不可用' };
    }
    try {
      this.logger.info('AI文案处理(本地)请求:', { engine, mode, inputLength: text.length });
      const result = await this.llmManager.polish(engine, text, mode, onDelta);
      if (result && result.success && typeof result.text === 'string' && result.text.trim()) {
        this.logger.info('AI文案处理(本地)完成:', { engine, outputLength: result.text.length });
        return { success: true, text: result.text.trim(), engine };
      }
      const failure = { success: false, error: (result && result.error) || '本地润色失败' };
      // 透传结构化失败原因（如 input_too_long），供上层给出明确提示。
      if (result && typeof result.reason === 'string') failure.reason = result.reason;
      return failure;
    } catch (error) {
      this.logger.error('本地润色异常:', error?.message || error);
      return { success: false, error: error?.message || '本地润色异常' };
    }
  }

  // 检查AI状态
  async checkAIStatus(testConfig = null) {
    try {
      this.logger.info('开始测试AI配置...', testConfig ? '使用临时配置' : '使用已保存配置');
      
      // 如果提供了测试配置，使用测试配置；否则使用已保存的配置
      let apiKey, baseUrl, model;
      
      if (testConfig) {
        apiKey = testConfig.ai_api_key;
        baseUrl = testConfig.ai_base_url || 'https://api.deepseek.com';
        model = testConfig.ai_model || 'deepseek-v4-flash';
        this.logger.info('使用临时测试配置:', { baseUrl, model, hasKey: !!apiKey });
      } else {
        apiKey = await this.databaseManager.getSetting('ai_api_key');
        baseUrl = await this.databaseManager.getSetting('ai_base_url') || 'https://api.deepseek.com';
        model = await this.databaseManager.getSetting('ai_model') || 'deepseek-v4-flash';
        this.logger.info('使用已保存配置:', { baseUrl, model, hasKey: !!apiKey });
      }
      
      if (!apiKey) {
        this.logger.warn('AI测试失败: 未配置API密钥');
        return {
          available: false,
          error: '未配置API密钥',
          details: '请输入AI API密钥'
        };
      }
      
      this.logger.info('AI配置信息:', {
        baseUrl: baseUrl,
        model: model
      });
      
      // 发送一个更有意义的测试请求
      const testMessage = '请回复"测试成功"来确认AI服务正常工作';
      const requestData = {
        model: model,
        messages: [
          {
            role: 'user',
            content: testMessage
          }
        ],
        max_tokens: 50,
        temperature: 0.1
      };

      this.logger.info('发送AI测试请求:', { model });

      const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
      });

      this.logger.info('AI API响应状态:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('AI API错误响应:', errorText);
        
        let errorData = { error: response.statusText };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || response.statusText };
        }
        
        let errorMessage = errorData.error?.message || errorData.error || `HTTP ${response.status}`;
        if (response.status === 401) {
          errorMessage = 'API密钥无效或已过期';
        } else if (response.status === 403) {
          errorMessage = 'API密钥权限不足';
        } else if (response.status === 429) {
          errorMessage = 'API调用频率超限';
        } else if (response.status === 500) {
          errorMessage = 'AI服务器内部错误';
        }
        
        throw new Error(errorMessage);
      }

      const data = await response.json();
      // 日志脱敏：只记录状态/模型/用量，绝不记录完整响应体或回复内容
      this.logger.info('AI API成功响应:', { status: response.status, model: data.model, usage: data.usage });

      if (!data.choices || data.choices.length === 0) {
        throw new Error('AI API返回格式异常：缺少choices字段');
      }

      const aiResponse = data.choices[0].message?.content || '';
      this.logger.info('AI回复内容长度:', aiResponse.length);

      return {
        available: true,
        model: model,
        status: 'connected',
        response: aiResponse,
        usage: data.usage,
        details: `成功连接到 ${model}，响应时间正常`
      };
    } catch (error) {
      this.logger.error('AI配置测试失败:', error);
      
      let errorMessage = '连接失败';
      if (error.message.includes('401')) {
        errorMessage = 'API密钥无效';
      } else if (error.message.includes('403')) {
        errorMessage = 'API密钥权限不足';
      } else if (error.message.includes('429')) {
        errorMessage = 'API调用频率超限';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = '无法连接到AI服务器，请检查网络和Base URL';
      } else if (error.message.includes('ECONNREFUSED')) {
        errorMessage = '连接被拒绝，请检查Base URL是否正确';
      } else if (error.message.includes('timeout')) {
        errorMessage = '请求超时，请检查网络连接';
      } else {
        errorMessage = error.message || '未知错误';
      }

      return {
        available: false,
        error: errorMessage,
        details: `测试失败原因: ${error.message}`
      };
    }
  }

  // 清理处理器
}

module.exports = AiService;
