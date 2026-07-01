const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { safeStorage } = require("electron");

// 这些设置项在落盘时用系统密钥链加密（macOS Keychain / Win DPAPI / Linux libsecret）。
// 兼容旧的明文值：读取时若无加密标记则原样返回，下次保存自动转为密文。
const ENCRYPTED_SETTING_KEYS = new Set(["ai_api_key", "llm_relay_token"]);

// 这些是敏感密钥：getAllSettings（会经 IPC 回到渲染层）绝不返回明文，
// 只返回"是否已设置"的布尔标记。主进程侧仍用 getSetting 取真实值（如 aiService）。
const REDACTED_SETTING_KEYS = new Set(["ai_api_key", "llm_relay_token"]);

function maybeEncrypt(key, value) {
  if (!ENCRYPTED_SETTING_KEYS.has(key) || typeof value !== "string" || value === "") {
    return JSON.stringify(value);
  }
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(value).toString("base64");
      return JSON.stringify({ __enc: "v1", data: enc });
    }
  } catch (e) {
    // 加密不可用则回退明文
  }
  return JSON.stringify(value);
}

function maybeDecrypt(parsed) {
  if (parsed && typeof parsed === "object" && parsed.__enc === "v1" && typeof parsed.data === "string") {
    try {
      return safeStorage.decryptString(Buffer.from(parsed.data, "base64"));
    } catch (e) {
      return "";
    }
  }
  return parsed;
}

// 中转 (relay) 打包期默认配置；分发前在 relayConfig.js 填好即可。
let RELAY_DEFAULTS = { RELAY_ENABLED: false, RELAY_URL: "", RELAY_TOKEN: "" };
try {
  RELAY_DEFAULTS = { ...RELAY_DEFAULTS, ...require("./relayConfig") };
} catch (e) {
  // 缺失则用上面的安全默认（关闭中转）
}

// 提示词已移出仓库与安装包：客户端不再内置任何系统/润色提示词。
// 所有 AI 文案处理严格只走云端中继(relay)，提示词只存在于中继的私有
// 环境变量(PROMPTS_B64)中。因此 llm_prompt_template 的默认值为空字符串。

class DatabaseManager {
  constructor(logger = null) {
    this.db = null;
    this.dbPath = null;
    this.logger = logger;
  }

  initialize(dataDirectory) {
    this.dbPath = path.join(dataDirectory, "transcriptions.db");
    
    // 确保数据目录存在
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.createTables();
    this.seedDefaultSettings();
  }

  createTables() {
    // 创建转录记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        raw_text TEXT,
        processed_text TEXT,
        confidence REAL,
        language TEXT DEFAULT 'zh-CN',
        duration REAL,
        file_size INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建设置表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at
      ON transcriptions(created_at DESC)
    `);
  }

  // 初始化默认设置（仅在键不存在时写入，不覆盖用户已有配置）
  seedDefaultSettings() {
    const defaults = {
      ai_base_url: 'https://api.deepseek.com',
      ai_model: 'deepseek-v4-flash',
      enable_ai_optimization: true,
      // 文案模式：识别后必走 LLM，贴模型结果而非原文
      copywriting_mode_enabled: true,
      // 提示词模板默认置空：提示词已移出客户端，全部由云端中继(relay)在服务器端注入。
      llm_prompt_template: '',
      llm_temperature: 0.7,
      llm_max_tokens: 600,
      // LLM 失败时是否回退粘贴识别原文（默认是，保证"说完一定有文本贴到光标"）
      llm_fallback_paste_raw: true,
      // 透传到请求体的额外字段：关闭 DeepSeek 思考模式（v4-flash 默认会思考，关闭后约快 1.3 秒）
      llm_extra_body: { thinking: { type: 'disabled' } },
      // 录音触发键：mac 单击左 Option / Windows 双击左 Alt（裸修饰键经 uiohook 监听）
      recording_trigger: process.platform === 'win32'
        ? { type: 'modifier-tap', key: 'LeftAlt', taps: 2 }
        : { type: 'modifier-tap', key: 'LeftOption', taps: 1 },
      // 取消录音快捷键（默认 Esc，可在设置里改为裸修饰键单/双击）
      cancel_key: 'Escape',
      // 取消键为裸修饰键时的连击次数（加速键如 Esc 时忽略此值）
      cancel_taps: 1,
      // 短句优化：识别结果 ≤ 该字数且干净时，跳过润色直接贴原文（0=关闭）
      skip_polish_max_chars: 10,
      // 润色「角色」：normal（默认，常规改写）/ vibecoding（走 llm_prompt_template）/ gaoeq（高情商改写）
      llm_active_role: 'normal',
      // 「转英文」全局触发键：默认单击左 Ctrl（裸修饰键经 uiohook 监听）
      translate_trigger: { type: 'modifier-tap', key: 'LeftCtrl', taps: 2 },
      translate_fallback_select_all: false,
      // 提示音：唤起/结束的合成音方案与音量（none 为无声）
      sound_scheme: 'soft',
      sound_volume: 0.3,
      // 识别引擎：sensevoice(快，默认) / paraformer(稳，回退)
      asr_engine: 'sensevoice',
      // 文案优化中转：开启后客户端不持有 DeepSeek key，只调用自建 Worker
      llm_relay_enabled: !!RELAY_DEFAULTS.RELAY_ENABLED,
      llm_relay_url: RELAY_DEFAULTS.RELAY_URL || '',
      llm_relay_token: RELAY_DEFAULTS.RELAY_TOKEN || '',
      // 本机匿名设备标识：用于中转端按设备限流（不含任何个人信息，仅一串随机 UUID）
      device_id: crypto.randomUUID(),
      // 流式润色（边生成边上屏）：需中转为「Web 函数」版才支持；默认关，部署后再开
      llm_streaming_enabled: false,
      // 保留最近一次生成结果到剪贴板：开启后粘贴完不恢复用户原剪贴板，留下最新生成文本；默认关（保持原"粘贴后恢复"行为）
      keep_result_in_clipboard: false,
      // 胶囊中心动画皮肤：'music'（默认）| 'voiceink'
      pill_skin: 'music',
      // 胶囊跟随输入焦点：开（默认）出现在焦点输入框下方/无焦点时鼠标下方；关则固定屏幕底部居中
      pill_follow_focus: true,
      // 托盘图标样式：'smile'（中笑镂空单色模板，默认）| 'color'（彩色猫头）
      tray_icon_style: 'smile',
      // 词转词规则：JSON 字符串数组 [{from,to}, ...]，AI 处理时识别到 from（含读音/拼写相近）自动替换为 to
      wtw_rules_json: '[]',
      // 首启引导：安装后首次启动时自动打开「设置-权限」页一次；首启后置 true，之后不再自动弹
      onboarding_completed: false
    };
    try {
      const existsStmt = this.db.prepare('SELECT 1 FROM settings WHERE key = ?');
      for (const [key, value] of Object.entries(defaults)) {
        if (!existsStmt.get(key)) {
          this.setSetting(key, value);
        }
      }
    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error('初始化默认设置失败:', error);
      }
    }
  }

  saveTranscription(data) {
    // 验证必需的数据
    if (!data || typeof data !== 'object') {
      throw new Error('转录数据无效');
    }

    // 确保text字段存在且不为空
    const text = data.text || data.raw_text || '';
    if (!text || text.trim().length === 0) {
      throw new Error('转录文本不能为空');
    }

    // 文本软上限保护：超长音频转写可能产出极大文本，超过上限会拖慢/卡死写入。
    // 任一字段超过 ~10MB 字符则记 warning 并截断后再入库；正常长度不受影响。
    const MAX_TEXT_CHARS = 10 * 1024 * 1024;
    const capText = (value, field) => {
      if (typeof value === 'string' && value.length > MAX_TEXT_CHARS) {
        if (this.logger && this.logger.warn) {
          this.logger.warn(
            `转录文本字段 ${field} 超过软上限 ${MAX_TEXT_CHARS} 字符（实际 ${value.length}），已截断后入库`
          );
        }
        return value.slice(0, MAX_TEXT_CHARS);
      }
      return value;
    };

    const safeText = capText(text.trim(), 'text');
    const safeRawText = capText(data.raw_text || null, 'raw_text');
    const safeProcessedText = capText(data.processed_text || null, 'processed_text');

    const stmt = this.db.prepare(`
      INSERT INTO transcriptions (
        text, raw_text, processed_text, confidence,
        language, duration, file_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    return stmt.run(
      safeText,
      safeRawText,
      safeProcessedText,
      data.confidence || 0,
      data.language || 'zh-CN',
      data.duration || 0,
      data.file_size || 0
    );
  }

  getTranscriptions(limit = 50, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT * FROM transcriptions 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset);
  }

  getTranscriptionById(id) {
    const stmt = this.db.prepare("SELECT * FROM transcriptions WHERE id = ?");
    return stmt.get(id);
  }

  deleteTranscription(id) {
    const stmt = this.db.prepare("DELETE FROM transcriptions WHERE id = ?");
    return stmt.run(id);
  }

  clearAllTranscriptions() {
    const stmt = this.db.prepare("DELETE FROM transcriptions");
    return stmt.run();
  }

  searchTranscriptions(query, limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM transcriptions 
      WHERE text LIKE ? OR raw_text LIKE ? OR processed_text LIKE ?
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    const searchTerm = `%${query}%`;
    return stmt.all(searchTerm, searchTerm, searchTerm, limit);
  }

  // 更新已存在记录的文本/润色结果（用于"先落库原文、润色后再补"）
  updateTranscription(id, fields = {}) {
    if (!id) return { changes: 0 };
    const stmt = this.db.prepare(
      "UPDATE transcriptions SET text = COALESCE(?, text), processed_text = COALESCE(?, processed_text) WHERE id = ?"
    );
    return stmt.run(
      typeof fields.text === "string" ? fields.text : null,
      typeof fields.processed_text === "string" ? fields.processed_text : null,
      id
    );
  }

  getTranscriptionStats() {
    const totalStmt = this.db.prepare("SELECT COUNT(*) as total FROM transcriptions");
    const todayStmt = this.db.prepare(`
      SELECT COUNT(*) as today FROM transcriptions 
      WHERE date(created_at) = date('now')
    `);
    const weekStmt = this.db.prepare(`
      SELECT COUNT(*) as week FROM transcriptions 
      WHERE created_at >= date('now', '-7 days')
    `);

    return {
      total: totalStmt.get().total,
      today: todayStmt.get().today,
      week: weekStmt.get().week
    };
  }

  setSetting(key, value) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `);
      const info = stmt.run(key, maybeEncrypt(key, value));
      return { success: true, changes: info.changes };
    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error("写入设置失败:", error);
      }
      return { success: false, error: error.message };
    }
  }

  getSetting(key, defaultValue = null) {
    const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
    const result = stmt.get(key);

    if (result) {
      try {
        return maybeDecrypt(JSON.parse(result.value));
      } catch (error) {
        return result.value;
      }
    }

    return defaultValue;
  }

  getAllSettings() {
    const stmt = this.db.prepare("SELECT key, value FROM settings");
    const rows = stmt.all();

    const settings = {};
    for (const row of rows) {
      // 敏感密钥不外泄明文：只暴露"是否已设置"的布尔（KEYLEAK-1）。
      if (REDACTED_SETTING_KEYS.has(row.key)) {
        let hasValue = false;
        try {
          const v = maybeDecrypt(JSON.parse(row.value));
          hasValue = typeof v === "string" ? v.length > 0 : !!v;
        } catch (error) {
          hasValue = !!row.value;
        }
        settings[`${row.key}_set`] = hasValue;
        continue;
      }
      try {
        settings[row.key] = maybeDecrypt(JSON.parse(row.value));
      } catch (error) {
        settings[row.key] = row.value;
      }
    }

    return settings;
  }

  resetSettings() {
    const stmt = this.db.prepare("DELETE FROM settings");
    const r = stmt.run();
    // 清空后立即重新播种默认值，避免行为不一致（file1-4.6）
    try { this.seedDefaultSettings(); } catch (e) { /* 忽略 */ }
    return r;
  }

  backup(backupPath) {
    if (!this.db) return false;
    
    try {
      this.db.backup(backupPath);
      return true;
    } catch (error) {
      if (this.logger && this.logger.error) {
        this.logger.error("数据库备份失败:", error);
      }
      return false;
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = DatabaseManager;