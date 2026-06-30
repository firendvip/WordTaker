// AI 文案处理服务：严格只走云端中继（relay）。
// 系统提示词只存在于中继的私有环境变量中，客户端不持有、也不构建任何提示词。
// 中继未配置/不可达时直接返回失败，由上层的「回退粘贴识别原文」逻辑兜底。
// 含超时、指数退避重试。从 ipcHandlers.js 拆出，便于维护与单测。

// LLM 请求默认超时（毫秒）：防止 relay/DeepSeek 挂起导致请求永久 pending、卡死后续录音
const LLM_REQUEST_TIMEOUT_MS = 20000;

// 带超时的 fetch：超时后 abort，触发各调用处已有的 AbortError 处理分支
async function fetchWithTimeout(url, options = {}, timeoutMs = LLM_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 在 fetchWithTimeout 之上加指数退避重试：仅对瞬时错误(429/5xx)与网络异常重试，最多 2 次。
// 最坏耗时收敛到 ≲40s：2 次 × 20s 单次超时 + 1 次 ≤2s 退避 = 约 42s 上界，实际 AbortError 多在 20s 内触发，远低于此。
const MAX_FETCH_ATTEMPTS = 2;
async function fetchWithRetry(url, options = {}, timeoutMs = LLM_REQUEST_TIMEOUT_MS) {
  const backoff = [2000];
  let lastErr;
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    const isLast = attempt >= MAX_FETCH_ATTEMPTS - 1;
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
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

class AiService {
  constructor({ databaseManager, logger }) {
    this.databaseManager = databaseManager;
    this.logger = logger;
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
        await fetchWithTimeout(relayUrl, { method: 'OPTIONS' }, 5000);
      } else {
        const baseUrl = await this.databaseManager.getSetting('ai_base_url', 'https://api.deepseek.com');
        await fetchWithTimeout(baseUrl, { method: 'HEAD' }, 5000);
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

      // 流式不重试(重试会重复输出);用带超时的 fetch
      const response = await fetchWithTimeout(relayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body) {
        return { success: false, error: `中转服务错误: ${response.status}` };
      }

      // 流式空闲看门狗：headers 到达后 fetch 的超时已失效，若上游中途停滞，
      // 读循环会永久挂起。每收到一个分片就重置计时，超时则取消 reader 解挂。
      const STREAM_IDLE_TIMEOUT_MS = 20000;
      // 流式总时长硬上限：即便分片持续到达（空闲看门狗不触发），也强制在 40s 封顶，
      // 避免上游慢速涓流导致整体长时间挂起、卡死后续录音。
      const STREAM_HARD_CAP_MS = 40000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let full = '';
      let idleTimer = null;
      let timedOut = false;
      let hardCapped = false;
      let sawDone = false; // 是否收到 done 终止标记；未收到即视为流被截断=错误
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          try { reader.cancel(); } catch (e) { /* 忽略 */ }
        }, STREAM_IDLE_TIMEOUT_MS);
      };
      const hardCapTimer = setTimeout(() => {
        hardCapped = true;
        timedOut = true;
        try { reader.cancel(); } catch (e) { /* 忽略 */ }
      }, STREAM_HARD_CAP_MS);
      try {
        resetIdle();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle();
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
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardCapTimer);
        try { reader.cancel(); } catch (e) { /* 忽略 */ }
      }
      const out = full.trim();
      // 超时（空闲或硬上限）一律按错误返回，绝不把部分/空内容当成功
      if (hardCapped) return { success: false, error: '流式响应超过最长时限' };
      if (timedOut) return { success: false, error: '流式响应超时' };
      if (!out) return { success: false, error: '流式返回为空' };
      // 流在未收到 done 终止标记的情况下结束=被上游截断，按错误返回防止吞掉不完整结果
      if (!sawDone) return { success: false, error: '流式响应未完成（缺少结束标记）' };
      this.logger.info('AI文案处理(中转·流式)完成:', { outputLength: out.length });
      return { success: true, text: out };
    } catch (error) {
      this.logger.error('流式中转请求失败:', error?.message || error);
      return { success: false, error: '无法连接文案中转服务(流式)' };
    }
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

  // 严格只走云端中继：客户端既不持有 DeepSeek key，也不构建任何系统提示词。
  // 中继未启用/未配置时直接返回失败，由上层「回退粘贴识别原文」逻辑兜底。
  async processTextWithAI(text, mode = 'optimize') {
    const relayEnabled = await this.databaseManager.getSetting('llm_relay_enabled', false);
    const relayUrl = await this.databaseManager.getSetting('llm_relay_url', '');
    if (!relayEnabled || !relayUrl) {
      this.logger.warn('AI文案处理不可用：未配置云端中继(relay)');
      return { success: false, error: '未配置云端中继，无法进行 AI 文案处理' };
    }
    return await this.processTextViaRelay(text, mode, relayUrl);
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
