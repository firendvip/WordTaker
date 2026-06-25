const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const PythonInstaller = require("./pythonInstaller");
const { runCommand, TIMEOUTS } = require("../utils/process");

// 简单的全局缓存，避免频繁检查
let globalModelCheckCache = null;
let globalModelCheckTime = 0;
const GLOBAL_CACHE_TIME = 2000; // 减少到2秒缓存，确保及时更新
const INIT_WAIT_TIMEOUT_MS = 60000; // 等待初始化最长 60s，超时则拒绝，避免无限等待卡死

class FunASRManager {
  constructor(logger = null) {
    this.logger = logger || console; // 使用传入的logger或默认console
    this.pythonCmd = null; // 缓存 Python 可执行文件路径
    this.funasrInstalled = null; // 缓存安装状态
    this.isInitialized = false; // 跟踪启动初始化是否完成
    this.pythonInstaller = new PythonInstaller();
    this.modelsInitialized = false; // 跟踪模型是否已初始化
    this.initializationPromise = null; // 缓存初始化Promise
    this.serverProcess = null; // FunASR服务器进程
    this.serverReady = false; // 服务器是否就绪
    this.serverStartError = null; // 最近一次启动失败原因（供 checkStatus 暴露，避免静默失败）
    this.modelsDownloaded = null; // 缓存模型下载状态
    
    // 简化缓存
    this._cachedPythonEnv = null;
    this._lastEmbeddedCheck = null;
    
    // 模型配置
    this.modelConfigs = {
      "asr": {
        "name": "damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "cache_path": "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "expected_size": 840 * 1024 * 1024  // 840MB
      },
      "vad": {
        "name": "damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "cache_path": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "expected_size": 1.6 * 1024 * 1024  // 1.6MB
      },
      "punc": {
        "name": "damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        "cache_path": "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        "expected_size": 278 * 1024 * 1024  // 278MB
      }
    };
  }


  getFunASRServerPath() {
    // 获取FunASR服务器脚本路径
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "funasr_server.py");
    } else {
      return path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "funasr_server.py"
      );
    }
  }

  // 嵌入式 Python 根目录（python/）。开发态在仓库根，打包态在 app.asar.unpacked 下。
  getEmbeddedPythonDir() {
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "python");
    }
    return path.join(process.resourcesPath, "app.asar.unpacked", "python");
  }

  getEmbeddedPythonPath() {
    // 获取嵌入式Python可执行文件路径（跨平台）。
    // python-build-standalone 的目录布局按平台不同：
    //   macOS/Linux: python/bin/python3.11
    //   Windows:     python/python.exe
    const pythonDir = this.getEmbeddedPythonDir();
    if (process.platform === "win32") {
      return path.join(pythonDir, "python.exe");
    }
    return path.join(pythonDir, "bin", "python3.11");
  }

  // 嵌入式 Python 的 site-packages 路径（跨平台）。
  //   macOS/Linux: python/lib/python3.11/site-packages
  //   Windows:     python/Lib/site-packages
  getEmbeddedSitePackages(pythonHome) {
    if (process.platform === "win32") {
      return path.join(pythonHome, "Lib", "site-packages");
    }
    return path.join(pythonHome, "lib", "python3.11", "site-packages");
  }

  setupIsolatedEnvironment() {
    // 设置Python环境变量，根据实际使用的Python来决定
    const embeddedPythonPath = this.getEmbeddedPythonPath();
    const isUsingEmbedded = fs.existsSync(embeddedPythonPath);
    
    if (isUsingEmbedded) {
      // 使用嵌入式Python时设置完全隔离的环境变量
      // pythonHome = python/ 根目录（跨平台：mac 在 bin/ 上两级，win 在 python.exe 同级）
      const pythonHome = this.getEmbeddedPythonDir();
      const sitePackages = this.getEmbeddedSitePackages(pythonHome);

      process.env.PYTHONHOME = pythonHome;
      process.env.PYTHONPATH = sitePackages;
      process.env.PYTHONDONTWRITEBYTECODE = '1';
      process.env.PYTHONIOENCODING = 'utf-8';
      process.env.PYTHONUNBUFFERED = '1';
      
      this.logger.info && this.logger.info('设置嵌入式Python环境', {
        PYTHONHOME: process.env.PYTHONHOME,
        PYTHONPATH: process.env.PYTHONPATH,
        pythonExecutable: embeddedPythonPath
      });
    } else {
      // 使用系统Python时，清除可能干扰的嵌入式Python环境变量
      delete process.env.PYTHONHOME;
      delete process.env.PYTHONPATH;
      
      // 设置基础环境变量
      process.env.PYTHONDONTWRITEBYTECODE = '1';
      process.env.PYTHONIOENCODING = 'utf-8';
      process.env.PYTHONUNBUFFERED = '1';
      
      this.logger.info && this.logger.info('设置系统Python环境', {
        note: '清除嵌入式Python环境变量，使用系统Python默认环境',
        pythonExecutable: this.pythonCmd || '未确定'
      });
    }
    
    // 清除可能干扰的系统Python环境变量
    delete process.env.PYTHONUSERBASE;
    delete process.env.PYTHONSTARTUP;
    delete process.env.VIRTUAL_ENV;
  }

  buildPythonEnvironment() {
    // 构建完整的Python环境变量，根据实际使用的Python路径来配置
    const embeddedPythonPath = this.getEmbeddedPythonPath();
    const isUsingEmbedded = fs.existsSync(embeddedPythonPath);
    
    // 缓存环境变量，避免重复构建和日志输出
    if (this._cachedPythonEnv && this._lastEmbeddedCheck === isUsingEmbedded) {
      return this._cachedPythonEnv;
    }
    
    let env = {
      ...process.env,
      // 基础Python环境变量
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      
      // 设置用户数据目录用于日志
      ELECTRON_USER_DATA: require('electron').app.getPath('userData')
    };
    
    if (isUsingEmbedded) {
      // 使用嵌入式Python时的完整隔离环境
      const pythonHome = this.getEmbeddedPythonDir();
      const sitePackages = this.getEmbeddedSitePackages(pythonHome);

      env.PYTHONHOME = pythonHome;
      env.PYTHONPATH = sitePackages;
      if (process.platform === 'win32') {
        // Windows 嵌入式 Python 的扩展模块/原生 DLL 都在 python 根目录与 Lib 下，
        // 需把 python 根目录加到 PATH 头部，否则 torch/numpy 等 .pyd 找不到依赖 DLL。
        env.PATH = `${pythonHome};${path.join(pythonHome, 'Scripts')};${env.PATH || ''}`;
      } else {
        // macOS/Linux 共享库在 python/lib 下
        env.LD_LIBRARY_PATH = path.join(pythonHome, 'lib');
        env.DYLD_LIBRARY_PATH = path.join(pythonHome, 'lib'); // macOS
      }

      // 只在首次构建或环境变化时记录日志
      if (!this._cachedPythonEnv || this._lastEmbeddedCheck !== isUsingEmbedded) {
        this.logger.info && this.logger.info('构建嵌入式Python环境变量', {
          PYTHONHOME: env.PYTHONHOME,
          PYTHONPATH: env.PYTHONPATH,
          LD_LIBRARY_PATH: env.LD_LIBRARY_PATH,
          DYLD_LIBRARY_PATH: env.DYLD_LIBRARY_PATH,
          pythonExecutable: embeddedPythonPath
        });
      }
    } else {
      // 使用系统Python时，清除可能干扰的嵌入式Python环境变量
      // 不设置PYTHONHOME和PYTHONPATH，让系统Python使用自己的环境
      if (!this._cachedPythonEnv || this._lastEmbeddedCheck !== isUsingEmbedded) {
        this.logger.info && this.logger.info('构建系统Python环境变量', {
          note: '使用系统Python默认环境',
          pythonExecutable: this.pythonCmd || '未确定'
        });
      }
    }
    
    // 清除可能干扰的系统Python环境变量
    delete env.PYTHONUSERBASE;
    delete env.PYTHONSTARTUP;
    delete env.VIRTUAL_ENV;

    // Windows-ARM64：嵌入式 Python 是纯 ONNX 环境（无 torch/funasr，因 torch 无 win-arm64 轮子）。
    // 通知 funasr_server.py 走纯 ONNX 路径，只加载 SenseVoice，避免 import torch 在 ARM 机崩溃。
    // 该标志由打包的应用架构决定（arm64 包 → process.arch === 'arm64'），x64 不受影响。
    if (process.platform === 'win32' && process.arch === 'arm64') {
      env.WORDTAKER_ONNX_ONLY = '1';
      if (!this._cachedPythonEnv) {
        this.logger.info && this.logger.info('Windows-ARM64：启用纯 ONNX 模式 (WORDTAKER_ONNX_ONLY=1)');
      }
    }

    // 缓存结果
    this._cachedPythonEnv = env;
    this._lastEmbeddedCheck = isUsingEmbedded;
    
    return env;
  }

  findDamoRoot(startDir, depth = 0, maxDepth = 5) {
    // 添加深度限制，避免在深层目录结构中搜索过久
    if (depth > maxDepth || !fs.existsSync(startDir)) {
      return null;
    }

    try {
      const entries = fs.readdirSync(startDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = path.join(startDir, entry.name);
          
          if (entry.name === 'damo') {
            // 检查是否包含至少一个目标模型子目录
            try {
              const models = fs.readdirSync(fullPath);
              const hasExpectedModel = models.some(m =>
                m.startsWith('speech_paraformer-') ||
                m.startsWith('speech_fsmn_vad-') ||
                m.startsWith('punc_ct-transformer-')
              );
              if (hasExpectedModel) {
                return fullPath;
              }
            } catch (error) {
              // 忽略无法读取的目录
              this.logger.debug && this.logger.debug('无法读取目录:', fullPath, error.message);
            }
          }
          
          // 递归继续查找 - 修复：添加 this 关键字
          const found = this.findDamoRoot(fullPath, depth + 1, maxDepth);
          if (found) return found;
        }
      }
    } catch (error) {
      // 处理权限错误或其他文件系统错误
      this.logger.debug && this.logger.debug('搜索目录时出错:', startDir, error.message);
    }
    
    return null;
  }

  /**
   * 获取模型缓存路径
   */
  getModelCachePath() {
    const baseCachePath =
      process.env.MODELSCOPE_CACHE || path.join(os.homedir(), '.cache', 'modelscope');

    // 可能的候选路径 - 添加 hub/models/damo 路径
    const candidates = [
      path.join(baseCachePath, 'damo'),
      path.join(baseCachePath, 'hub', 'damo'),
      path.join(baseCachePath, 'hub', 'models', 'damo'),  // 新增：支持 hub/models/damo 结构
      path.join(baseCachePath, 'models', 'damo'),
    ];

    // 先检查常见路径
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.logger.info && this.logger.info('找到模型缓存路径:', candidate);
        return candidate;
      }
    }

    // 如果没找到，则递归搜索 - 修复：添加 this 关键字
    this.logger.info && this.logger.info('常见路径未找到，开始递归搜索:', baseCachePath);
    const found = this.findDamoRoot(baseCachePath);
    if (found) {
      this.logger.info && this.logger.info('递归搜索找到模型路径:', found);
      return found;
    }

    throw new Error(`未找到有效的 damo 模型目录，请检查 MODELSCOPE_CACHE 或模型安装路径`);
  }


  async checkModelFiles() {
    /**
     * 检查所有模型文件是否存在（使用简单缓存避免频繁检查）
     */
    const now = Date.now();
    
    // 使用全局缓存避免频繁检查，但如果服务器状态可能已变化则强制检查
    if (globalModelCheckCache &&
        (now - globalModelCheckTime) < GLOBAL_CACHE_TIME &&
        !this.serverReady) { // 如果服务器已就绪，允许重新检查
      return globalModelCheckCache;
    }
    
    try {
      const cachePath = this.getModelCachePath();
      this.logger.info && this.logger.info('检查模型缓存路径:', cachePath);
      
      if (!fs.existsSync(cachePath)) {
        this.logger.info && this.logger.info('模型缓存目录不存在');
        this.modelsDownloaded = false;
        const result = {
          success: true,
          models_downloaded: false,
          missing_models: ["asr", "vad", "punc"],
          details: {}
        };
        
        // 更新全局缓存
        globalModelCheckCache = result;
        globalModelCheckTime = now;
        return result;
      }
      
      const results = {};
      const missingModels = [];
      
      for (const [modelType, config] of Object.entries(this.modelConfigs)) {
        const modelDir = path.join(cachePath, config.cache_path);
        const found = this.findModelFile(modelDir);
        const modelFile = found || path.join(modelDir, "model.pt");

        if (found) {
          const stats = fs.statSync(found);
          const fileSize = stats.size;
          const isComplete = fileSize >= config.expected_size * 0.95; // 允许5%误差
          
          results[modelType] = {
            exists: true,
            path: modelFile,
            size: fileSize,
            expected_size: config.expected_size,
            complete: isComplete
          };
          
          if (!isComplete) {
            missingModels.push(modelType);
          }
        } else {
          results[modelType] = {
            exists: false,
            path: modelFile,
            size: 0,
            expected_size: config.expected_size,
            complete: false
          };
          missingModels.push(modelType);
        }
      }
      
      const allDownloaded = missingModels.length === 0;
      this.modelsDownloaded = allDownloaded;
      
      this.logger.info && this.logger.info('模型检查完成:', {
        allDownloaded,
        missingModels,
        details: results
      });
      
      const result = {
        success: true,
        models_downloaded: allDownloaded,
        missing_models: missingModels,
        details: results
      };
      
      // 更新全局缓存
      globalModelCheckCache = result;
      globalModelCheckTime = now;
      return result;
      
    } catch (error) {
      this.logger.error && this.logger.error('检查模型文件失败:', error);
      this.modelsDownloaded = false;
      const result = {
        success: false,
        error: error.message,
        models_downloaded: false,
        missing_models: ["asr", "vad", "punc"],
        details: {}
      };
      
      // 错误情况下不缓存，允许重试
      return result;
    }
  }

  // 在模型目录中查找有效模型文件，兼容多种格式（.pt / .onnx / .bin），
  // 避免只认 model.pt 时把 SenseVoice ONNX 等格式误报为"缺失"。
  findModelFile(modelDir) {
    const candidates = ["model.pt", "model_quant.onnx", "model.onnx", "pytorch_model.bin"];
    for (const name of candidates) {
      const p = path.join(modelDir, name);
      if (fs.existsSync(p)) return p;
    }
    try {
      const f = fs.readdirSync(modelDir).find(
        (n) => n.endsWith(".onnx") || n.endsWith(".pt") || n.endsWith(".bin")
      );
      if (f) return path.join(modelDir, f);
    } catch (e) {
      // 目录不存在等
    }
    return null;
  }

  async getDownloadProgress() {
    /**
     * 获取模型下载进度
     */
    try {
      const cachePath = this.getModelCachePath();
      
      if (!fs.existsSync(cachePath)) {
        return {
          success: true,
          overall_progress: 0,
          models: {
            "asr": { progress: 0, downloaded: 0, total: this.modelConfigs.asr.expected_size },
            "vad": { progress: 0, downloaded: 0, total: this.modelConfigs.vad.expected_size },
            "punc": { progress: 0, downloaded: 0, total: this.modelConfigs.punc.expected_size }
          }
        };
      }
      
      const totalExpected = Object.values(this.modelConfigs).reduce((sum, config) => sum + config.expected_size, 0);
      let totalDownloaded = 0;
      const modelProgress = {};
      
      for (const [modelType, config] of Object.entries(this.modelConfigs)) {
        const modelDir = path.join(cachePath, config.cache_path);
        const found = this.findModelFile(modelDir);

        let fileSize = 0;
        if (found) {
          const stats = fs.statSync(found);
          fileSize = stats.size;
          totalDownloaded += fileSize;
        }
        
        const progress = Math.min(100, (fileSize / config.expected_size) * 100);
        
        modelProgress[modelType] = {
          progress: Math.round(progress * 10) / 10, // 保留1位小数
          downloaded: fileSize,
          total: config.expected_size
        };
      }
      
      const overallProgress = Math.min(100, (totalDownloaded / totalExpected) * 100);
      
      return {
        success: true,
        overall_progress: Math.round(overallProgress * 10) / 10,
        models: modelProgress
      };
      
    } catch (error) {
      this.logger.error && this.logger.error('获取下载进度失败:', error);
      return {
        success: false,
        error: error.message,
        overall_progress: 0,
        models: {}
      };
    }
  }

  getDownloadScriptPath() {
    /**
     * 获取下载脚本路径
     */
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "download_models.py");
    } else {
      return path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "download_models.py"
      );
    }
  }

  async downloadModels(progressCallback = null) {
    /**
     * 下载模型文件（使用独立的Python脚本并行下载）
     */
    try {
      this.logger.info && this.logger.info('开始下载FunASR模型...');
      
      // 先检查模型状态
      const checkResult = await this.checkModelFiles();
      if (checkResult.models_downloaded) {
        this.logger.info && this.logger.info('模型已存在，无需下载');
        return { success: true, message: "模型已存在，无需下载" };
      }
      
      const pythonCmd = await this.findPythonExecutable();
      const scriptPath = this.getDownloadScriptPath();
      
      this.logger.info && this.logger.info('启动模型下载脚本:', {
        pythonCmd,
        scriptPath,
        scriptExists: fs.existsSync(scriptPath)
      });
      
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`下载脚本未找到: ${scriptPath}`);
      }
      
      return new Promise((resolve, reject) => {
        // 确保使用正确的Python环境
        const pythonEnv = this.buildPythonEnvironment();
        
        const downloadProcess = spawn(pythonCmd, [scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: pythonEnv
        });
        
        let hasError = false;
        
        downloadProcess.stdout.on("data", (data) => {
          const lines = data.toString().split('\n').filter(line => line.trim());
          
          for (const line of lines) {
            try {
              const result = JSON.parse(line);
              
              if (result.error) {
                hasError = true;
                reject(new Error(result.error));
                return;
              }
              
              // 处理进度更新
              if (result.stage && progressCallback) {
                progressCallback({
                  stage: result.stage,
                  model: result.model,
                  progress: result.progress,
                  overall_progress: result.overall_progress,
                  completed: result.completed,
                  total: result.total
                });
              }
              
              // 处理最终结果
              if (result.success !== undefined) {
                if (result.success) {
                  this.modelsDownloaded = true;
                  resolve({ success: true, message: result.message || "模型下载完成" });
                } else {
                  hasError = true;
                  reject(new Error(result.error || "模型下载失败"));
                }
                return;
              }
              
            } catch (parseError) {
              // 忽略非JSON输出
              this.logger.debug && this.logger.debug('下载脚本非JSON输出:', line);
            }
          }
        });
        
        downloadProcess.stderr.on("data", (data) => {
          const errorOutput = data.toString();
          this.logger.error && this.logger.error('模型下载错误输出:', errorOutput);
        });
        
        downloadProcess.on("close", (code) => {
          if (!hasError) {
            if (code === 0) {
              this.modelsDownloaded = true;
              resolve({ success: true, message: "模型下载完成" });
            } else {
              reject(new Error(`模型下载进程退出，代码: ${code}`));
            }
          }
        });
        
        downloadProcess.on("error", (error) => {
          if (!hasError) {
            reject(new Error(`启动下载进程失败: ${error.message}`));
          }
        });
        
        // 设置超时（30分钟）
        setTimeout(() => {
          if (!hasError) {
            downloadProcess.kill();
            reject(new Error('模型下载超时'));
          }
        }, 30 * 60 * 1000);
      });
      
    } catch (error) {
      this.logger.error && this.logger.error('模型下载失败:', error);
      throw error;
    }
  }

  async restartServer() {
    /**
     * 重启FunASR服务器（用于模型下载完成后）
     */
    try {
      this.logger.info && this.logger.info('重启FunASR服务器...');
      
      // 停止现有服务器
      if (this.serverProcess) {
        await this._stopFunASRServer();
        this.logger.info && this.logger.info('已停止现有FunASR服务器');
      }
      
      // 重置状态并清除缓存
      this.serverReady = false;
      this.modelsInitialized = false;
      this.initializationPromise = null;
      this._clearModelCache();
      
      // 检查模型文件状态
      const modelStatus = await this.checkModelFiles();
      if (!modelStatus.models_downloaded) {
        throw new Error('模型文件未下载，无法启动服务器');
      }
      
      // 重新启动服务器
      this.initializationPromise = this._startFunASRServer();
      await this.initializationPromise;
      
      this.logger.info && this.logger.info('FunASR服务器重启完成');
      return { success: true, message: 'FunASR服务器重启成功' };
      
    } catch (error) {
      this.logger.error && this.logger.error('重启FunASR服务器失败:', error);
      return { success: false, error: error.message };
    }
  }

  _clearModelCache() {
    /**
     * 清除模型检查缓存
     */
    globalModelCheckCache = null;
    globalModelCheckTime = 0;
  }

  async initializeAtStartup() {
    try {
      this.logger.info && this.logger.info('FunASR管理器启动初始化开始');
      
      const pythonCmd = await this.findPythonExecutable();
      this.logger.info && this.logger.info('Python可执行文件找到', { pythonCmd });
      
      const funasrStatus = await this.checkFunASRInstallation();
      this.logger.info && this.logger.info('FunASR安装状态检查完成', funasrStatus);
      
      this.isInitialized = true;
      
      // 预初始化模型（异步进行，不阻塞启动）
      this.preInitializeModels();
      this.logger.info && this.logger.info('FunASR管理器启动初始化完成');
    } catch (error) {
      // FunASR 在启动时不可用不是关键问题
      this.logger.warn && this.logger.warn('FunASR启动初始化失败，但不影响应用启动', error);
      this.isInitialized = true;
    }
  }

  async preInitializeModels() {
    // 如果已经在初始化或已完成，直接返回
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._startFunASRServer();
    return this.initializationPromise;
  }

  async _startFunASRServer() {
    try {
      this._intentionalStop = false; // 新一轮启动，允许后续异常自动重启
      this.serverStartError = null; // 新一轮启动，清除上次失败原因
      this.logger.info && this.logger.info('启动FunASR服务器...');

      const status = await this.checkFunASRInstallation();
      if (!status.installed) {
        this.logger.warn && this.logger.warn('FunASR未安装，跳过服务器启动');
        this.serverStartError = { reason: 'funasr-not-installed', message: 'FunASR 未安装' };
        return;
      }

      const pythonCmd = await this.findPythonExecutable();
      const serverPath = this.getFunASRServerPath();
      this.logger.info && this.logger.info('FunASR服务器配置', {
        pythonCmd,
        serverPath,
        serverExists: fs.existsSync(serverPath)
      });

      if (!fs.existsSync(serverPath)) {
        this.logger.error && this.logger.error('FunASR服务器脚本未找到，跳过服务器启动', { serverPath });
        this.serverStartError = { reason: 'server-script-missing', message: `服务器脚本未找到: ${serverPath}` };
        return;
      }

      // 确保环境变量正确设置
      this.setupIsolatedEnvironment();

      // 构建完整的环境变量
      const pythonEnv = this.buildPythonEnvironment();

      // getModelCachePath() 可能抛出（未找到模型目录）。在 executor 之外解析，
      // 避免 Promise 构造函数内同步抛出产生未处理的 promise rejection。
      let cachePath;
      try {
        cachePath = this.getModelCachePath();
      } catch (cacheError) {
        this.logger.error && this.logger.error('解析模型缓存路径失败', cacheError);
        this.serverStartError = { reason: 'models-missing', message: cacheError.message };
        return; // 解析为 resolved（无 reject），失败原因经 checkStatus 暴露
      }

      return new Promise((resolve) => {
        this.logger.info && this.logger.info('启动FunASR Python进程', {
          command: pythonCmd,
          args: [serverPath, "--damo-root", cachePath],
          env: pythonEnv
        });

        // 标记本次启动是否已 settle，确保只 resolve 一次且不会无限挂起
        let initResponseReceived = false;
        const settle = () => {
          if (initResponseReceived) return;
          initResponseReceived = true;
          resolve();
        };

        this.serverProcess = spawn(
          pythonCmd,
          [serverPath, "--damo-root", cachePath],   // <== 这里加上参数
          {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: pythonEnv // 保持你原来的 Python 环境
          }
        );

        // spawn 时注册 stdin 'error'：子进程退出后写入触发 EPIPE 时，
        // 立即拒绝在途命令（REL-2），并记录失败原因，避免被超时掩盖。
        this.serverProcess.stdin.on('error', (error) => {
          this.logger.error && this.logger.error('FunASR stdin 管道错误', error);
          if (this._pendingStdinReject) {
            const rejectFn = this._pendingStdinReject;
            this._pendingStdinReject = null;
            rejectFn(new Error(`FunASR服务器管道已关闭: ${error && error.message ? error.message : error}`));
          }
        });

        this.serverProcess.stdout.on("data", (data) => {
          const lines = data.toString().split('\n').filter(line => line.trim());

          for (const line of lines) {
            this.logger.debug && this.logger.debug('FunASR服务器输出', { line });
            try {
              const result = JSON.parse(line);

              if (!initResponseReceived) {
                // 这是初始化响应
                if (result.success) {
                  this.serverReady = true;
                  this.modelsInitialized = true;
                  this.serverStartError = null;
                  this._restartCount = 0; // 成功就绪，重置自动重启计数
                  this._clearModelCache(); // 清除缓存，确保状态更新
                  this.logger.info && this.logger.info('FunASR服务器启动成功，模型已初始化');
                } else {
                  // 初始化失败：记录可见的失败原因（如模型未下载），不静默
                  this.serverStartError = {
                    reason: result.type || 'init-failed',
                    message: result.error || 'FunASR 初始化失败',
                  };
                  this.logger.error && this.logger.error('FunASR服务器初始化失败', result);
                }
                settle();
              }
            } catch (parseError) {
              // 忽略非JSON输出，但记录到日志
              this.logger.debug && this.logger.debug('FunASR服务器非JSON输出', { line });
            }
          }
        });

        this.serverProcess.stderr.on("data", (data) => {
          const errorOutput = data.toString();
          this.logger.error && this.logger.error('FunASR服务器错误输出', { errorOutput });
          // 同时记录到FunASR专用日志
          if (this.logger.logFunASR) {
            this.logger.logFunASR('error', 'Python stderr', { errorOutput });
          }
        });

        this.serverProcess.on("close", (code) => {
          this.logger.warn && this.logger.warn('FunASR服务器进程退出', { code });
          this.serverProcess = null;
          this.serverReady = false;
          this.modelsInitialized = false;

          if (!initResponseReceived) {
            // 进程在返回初始化响应前就退出：记录可见失败原因，避免静默
            this.serverStartError = {
              reason: 'process-exited',
              message: `FunASR 进程在初始化前退出，退出码: ${code}`,
            };
            settle();
          }

          // 非主动停止且异常退出(崩溃/OOM)时自动重启：最多3次、指数退避
          if (!this._intentionalStop && code !== 0) {
            if ((this._restartCount || 0) < 3) {
              this._restartCount = (this._restartCount || 0) + 1;
              const delay = [1000, 3000, 8000][this._restartCount - 1] || 8000;
              this.logger.warn && this.logger.warn(`FunASR 异常退出，${delay}ms 后自动重启(第${this._restartCount}次)`);
              this._restartTimer = setTimeout(() => {
                this._restartTimer = null;
                if (this._intentionalStop) return; // 已主动停止则不再重启
                const restartPromise = this._startFunASRServer();
                this.initializationPromise = restartPromise;
                // 自动重启的 promise 无论成功/失败 settle 后都清空 initializationPromise，
                // 让后续调用可以重新触发启动（避免卡在旧的已结算 promise 上）。
                restartPromise
                  .catch((e) => this.logger.error && this.logger.error('FunASR 自动重启失败', e))
                  .finally(() => {
                    if (this.initializationPromise === restartPromise) {
                      this.initializationPromise = null;
                    }
                  });
              }, delay);
            } else {
              this.logger.error && this.logger.error('FunASR 连续重启3次仍失败，停止自动重启');
            }
          }
        });

        this.serverProcess.on("error", (error) => {
          this.logger.error && this.logger.error('FunASR服务器进程错误', error);
          this.serverProcess = null;
          this.serverReady = false;
          this.serverStartError = { reason: 'spawn-failed', message: error.message };
          settle();
        });

        // 设置超时
        setTimeout(() => {
          if (!initResponseReceived) {
            this.logger.warn && this.logger.warn('FunASR服务器启动超时');
            this.serverStartError = { reason: 'timeout', message: 'FunASR 服务器启动超时' };
            if (this.serverProcess) {
              this.serverProcess.kill();
            }
            settle();
          }
        }, 120000); // 2分钟超时
      });
    } catch (error) {
      this.logger.error && this.logger.error('启动FunASR服务器异常', error);
      this.serverStartError = { reason: 'start-exception', message: error.message };
    }
  }

  // 串行化命令：Python 是单管道单进程，并发会导致响应串话/永久挂起。
  // 同一时刻只允许一个命令在途，其余排队。
  async _sendServerCommand(command, timeoutMs = 30000) {
    const run = () => this._sendServerCommandImpl(command, timeoutMs);
    const p = (this._cmdChain || Promise.resolve()).then(run, run);
    this._cmdChain = p.then(() => undefined, () => undefined);
    return p;
  }

  async _sendServerCommandImpl(command, timeoutMs = 30000) {
    if (!this.serverProcess || !this.serverReady) {
      throw new Error('FunASR服务器未就绪');
    }

    const proc = this.serverProcess;

    // 为每条命令生成关联 id，避免迟到/超时的响应被错误匹配到下一条命令（ROB-1）。
    // 不修改调用方传入的 command（immutable），构造带 id 的新对象。
    this._cmdSeq = (this._cmdSeq || 0) + 1;
    const cmdId = `${Date.now()}-${this._cmdSeq}`;
    const taggedCommand = { ...command, id: cmdId };

    return new Promise((resolve, reject) => {
      let responseReceived = false;

      const cleanup = () => {
        try { proc.stdout.removeListener('data', onData); } catch (e) {}
        try { proc.stdin.removeListener('error', onStdinError); } catch (e) {}
        if (this._pendingStdinReject === settleReject) {
          this._pendingStdinReject = null;
        }
      };

      const settleResolve = (result) => {
        if (responseReceived) return;
        responseReceived = true;
        cleanup();
        resolve(result);
      };

      const settleReject = (error) => {
        if (responseReceived) return;
        responseReceived = true;
        cleanup();
        reject(error);
      };

      const onData = (data) => {
        if (responseReceived) return;

        const lines = data.toString().split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const result = JSON.parse(line);
            // 关联 id 校验：若响应带 id 且与本命令不一致，说明是迟到/串话的响应，跳过；
            // 若响应无 id（向后兼容旧响应/初始化响应），仍按原行为接受。
            if (result && result.id !== undefined && result.id !== cmdId) {
              this.logger.warn && this.logger.warn('FunASR 收到不匹配的响应 id，已忽略', {
                expected: cmdId,
                received: result.id,
              });
              continue;
            }
            settleResolve(result);
            return;
          } catch (parseError) {
            // 忽略非JSON输出
          }
        }
      };

      // stdin 'error'（如子进程已退出导致 EPIPE）：立即以管道关闭错误拒绝在途命令，不等 30s 超时
      const onStdinError = (error) => {
        this.logger.error && this.logger.error('FunASR stdin 写入错误', error);
        settleReject(new Error(`FunASR服务器管道已关闭: ${error && error.message ? error.message : error}`));
      };

      proc.stdout.on('data', onData);
      proc.stdin.on('error', onStdinError);
      // 暴露当前在途命令的 reject，供 spawn 时注册的全局 stdin error handler 调用
      this._pendingStdinReject = settleReject;

      // 发送命令：write 失败（管道已关闭）时立即拒绝，避免被 30s 超时掩盖真实原因
      try {
        proc.stdin.write(JSON.stringify(taggedCommand) + '\n');
      } catch (writeError) {
        settleReject(new Error(`FunASR命令写入失败（管道已关闭）: ${writeError.message}`));
        return;
      }

      // 设置超时
      setTimeout(() => {
        settleReject(new Error('服务器响应超时'));
      }, timeoutMs);
    });
  }

  async _stopFunASRServer() {
    this._intentionalStop = true; // 标记为主动停止，阻止自动重启
    if (this._restartTimer) { try { clearTimeout(this._restartTimer); } catch (e) {} this._restartTimer = null; }
    const proc = this.serverProcess;
    this.serverProcess = null;
    this.serverReady = false;
    this.modelsInitialized = false;
    if (proc) {
      // 不等待优雅退出(避免退出卡住)：先发 exit + SIGTERM，短延迟后 SIGKILL 兜底
      try { proc.stdin && proc.stdin.write(JSON.stringify({ action: 'exit' }) + '\n'); } catch (e) {}
      try { proc.kill(); } catch (e) {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 800);
    }
  }

  // 同步强杀(供进程退出钩子调用，保证不留孤儿 Python)
  killServerSync() {
    this._intentionalStop = true;
    if (this._restartTimer) { try { clearTimeout(this._restartTimer); } catch (e) {} this._restartTimer = null; }
    const proc = this.serverProcess;
    this.serverProcess = null;
    this.serverReady = false;
    if (proc) {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }
  }

  async findPythonExecutable() {
    // 如果有缓存结果则返回
    if (this.pythonCmd) {
      return this.pythonCmd;
    }

    // 优先使用嵌入式Python（完全隔离策略）
    const embeddedPython = this.getEmbeddedPythonPath();
    
    this.logger.info && this.logger.info('检查嵌入式Python', {
      path: embeddedPython,
      exists: fs.existsSync(embeddedPython)
    });

    if (fs.existsSync(embeddedPython)) {
      try {
        // 设置隔离环境
        this.setupIsolatedEnvironment();
        
        // 验证嵌入式Python是否可用
        const version = await this.getPythonVersion(embeddedPython);
        if (this.isPythonVersionSupported(version)) {
          this.pythonCmd = embeddedPython;
          this.logger.info && this.logger.info('使用嵌入式Python', {
            path: embeddedPython,
            version: `${version.major}.${version.minor}`
          });
          return embeddedPython;
        }
      } catch (error) {
        this.logger.warn && this.logger.warn('嵌入式Python不可用', error);
      }
    }

    // 如果嵌入式Python不可用，在开发模式下回退到系统Python
    if (process.env.NODE_ENV === "development") {
      this.logger.warn && this.logger.warn('开发模式：回退到系统Python');
      return await this.findPythonExecutableWithFallback();
    }

    // 生产模式下不回退，确保完全隔离
    throw new Error(
      "嵌入式Python环境不可用。请重新安装应用或运行构建脚本准备Python环境。"
    );
  }

  async findPythonExecutableWithFallback() {
    // 保留原有的查找逻辑作为开发时的回退方案
    const projectRoot = path.join(__dirname, "..", "..");
      
    const possiblePaths = [
      // 优先使用 uv 虚拟环境中的 Python
      path.join(projectRoot, ".venv", "bin", "python3.11"),
      path.join(projectRoot, ".venv", "bin", "python3"),
      path.join(projectRoot, ".venv", "bin", "python"),
      // 然后尝试系统路径
      "python3.11",
      "python3",
      "python",
      "/usr/bin/python3.11",
      "/usr/bin/python3",
      "/usr/local/bin/python3.11",
      "/usr/local/bin/python3",
      "/opt/homebrew/bin/python3.11",
      "/opt/homebrew/bin/python3",
      "/usr/bin/python",
      "/usr/local/bin/python",
    ];

    for (const pythonPath of possiblePaths) {
      try {
        const version = await this.getPythonVersion(pythonPath);
        if (this.isPythonVersionSupported(version)) {
          this.pythonCmd = pythonPath;
          return pythonPath;
        }
      } catch (error) {
        continue;
      }
    }

    throw new Error(
      "未找到 Python 3.x。使用 installPython() 自动安装。"
    );
  }

  async getPythonVersion(pythonPath) {
    return new Promise((resolve) => {
      // 如果是嵌入式Python，使用完整的环境变量
      const isEmbedded = pythonPath === this.getEmbeddedPythonPath();
      const env = isEmbedded ? this.buildPythonEnvironment() : process.env;
      
      const testProcess = spawn(pythonPath, ["--version"], {
        env: env
      });
      let output = "";
      
      testProcess.stdout.on("data", (data) => output += data);
      testProcess.stderr.on("data", (data) => output += data);
      
      testProcess.on("close", (code) => {
        if (code === 0) {
          const match = output.match(/Python (\d+)\.(\d+)/i);
          resolve(match ? { major: +match[1], minor: +match[2] } : null);
        } else {
          resolve(null);
        }
      });
      
      testProcess.on("error", () => resolve(null));
    });
  }

  isPythonVersionSupported(version) {
    // 接受任何 Python 3.x 版本
    return version && version.major === 3;
  }

  async installPython(progressCallback = null) {
    try {
      // 清除缓存的 Python 命令，因为我们正在安装新的
      this.pythonCmd = null;
      
      const result = await this.pythonInstaller.installPython(progressCallback);
      
      // 安装后，尝试重新找到 Python
      try {
        await this.findPythonExecutable();
        return result;
      } catch (findError) {
        throw new Error("Python 已安装但在 PATH 中未找到。请重启应用程序。");
      }
      
    } catch (error) {
      this.logger.error && this.logger.error("Python 安装失败:", error);
      throw error;
    }
  }

  async checkPythonInstallation() {
    return await this.pythonInstaller.isPythonInstalled();
  }

  async checkFunASRInstallation() {
    // 如果有缓存结果则返回
    if (this.funasrInstalled !== null) {
      return this.funasrInstalled;
    }

    try {
      const pythonCmd = await this.findPythonExecutable();

      const result = await new Promise((resolve) => {
        // 确保使用正确的Python环境
        const pythonEnv = this.buildPythonEnvironment();
        
        const checkProcess = spawn(pythonCmd, [
          "-c",
          'import funasr; print("OK")',
        ], {
          env: pythonEnv
        });

        let output = "";
        let errorOutput = "";
        
        checkProcess.stdout.on("data", (data) => {
          output += data.toString();
        });
        
        checkProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        checkProcess.on("close", (code) => {
          if (code === 0 && output.includes("OK")) {
            resolve({ installed: true, working: true });
          } else {
            this.logger.error && this.logger.error('FunASR检查失败', {
              code,
              output,
              errorOutput
            });
            resolve({ installed: false, working: false, error: errorOutput || output });
          }
        });

        checkProcess.on("error", (error) => {
          resolve({ installed: false, working: false, error: error.message });
        });
      });

      this.funasrInstalled = result; // 缓存结果
      return result;
    } catch (error) {
      const errorResult = {
        installed: false,
        working: false,
        error: error.message,
      };
      this.funasrInstalled = errorResult;
      return errorResult;
    }
  }

  async upgradePip(pythonCmd) {
    return runCommand(pythonCmd, ["-m", "pip", "install", "--upgrade", "pip"], { timeout: TIMEOUTS.PIP_UPGRADE });
  }

  async installFunASR(progressCallback = null) {
    const pythonCmd = await this.findPythonExecutable();
    
    if (progressCallback) {
      progressCallback({ stage: "升级 pip...", percentage: 10 });
    }
    
    // 首先升级 pip 以避免版本问题
    try {
      await this.upgradePip(pythonCmd);
    } catch (error) {
      this.logger.warn && this.logger.warn("第一次 pip 升级尝试失败:", error.message);
      
      // 尝试用户安装方式升级 pip
      try {
        await runCommand(pythonCmd, ["-m", "pip", "install", "--user", "--upgrade", "pip"], { timeout: TIMEOUTS.PIP_UPGRADE });
      } catch (userError) {
        this.logger.warn && this.logger.warn("pip 升级完全失败，尝试继续");
      }
    }
    
    if (progressCallback) {
      progressCallback({ stage: "安装 FunASR...", percentage: 30 });
    }
    
    // 安装 FunASR 和相关依赖
    try {
      // 首先尝试常规安装
      await runCommand(pythonCmd, ["-m", "pip", "install", "-U", "funasr"], { timeout: TIMEOUTS.DOWNLOAD });
      
      if (progressCallback) {
        progressCallback({ stage: "安装 librosa...", percentage: 60 });
      }
      
      // 安装 librosa（音频处理库）
      await runCommand(pythonCmd, ["-m", "pip", "install", "-U", "librosa"], { timeout: TIMEOUTS.DOWNLOAD });
      
      if (progressCallback) {
        progressCallback({ stage: "安装完成！", percentage: 100 });
      }
      
      // 清除缓存状态
      this.funasrInstalled = null;
      
      return { success: true, message: "FunASR 安装成功" };
      
    } catch (error) {
      if (error.message.includes("Permission denied") || error.message.includes("access is denied")) {
        // 使用用户安装方式重试
        try {
          await runCommand(pythonCmd, ["-m", "pip", "install", "--user", "-U", "funasr"], { timeout: TIMEOUTS.DOWNLOAD });
          await runCommand(pythonCmd, ["-m", "pip", "install", "--user", "-U", "librosa"], { timeout: TIMEOUTS.DOWNLOAD });
          
          if (progressCallback) {
            progressCallback({ stage: "安装完成！", percentage: 100 });
          }
          
          this.funasrInstalled = null;
          return { success: true, message: "FunASR 安装成功（用户模式）" };
        } catch (userError) {
          throw new Error(`FunASR 安装失败: ${userError.message}`);
        }
      }
      
      // 增强常见问题的错误消息
      let message = error.message;
      if (message.includes("Microsoft Visual C++")) {
        message = "需要 Microsoft Visual C++ 构建工具。请安装 Visual Studio Build Tools。";
      } else if (message.includes("No matching distribution")) {
        message = "Python 版本不兼容。FunASR 需要 Python 3.8-3.11。";
      }
      
      throw new Error(message);
    }
  }

  async transcribeAudio(audioBlob, options = {}) {
    // 检查 FunASR 是否已安装
    const status = await this.checkFunASRInstallation();
    if (!status.installed) {
      throw new Error("FunASR 未安装。请先安装 FunASR。");
    }

    // 如果服务器还未就绪，等待初始化完成（缓冲/排队：启动后立刻录的音频在这里等引擎就绪，不丢）。
    // 若初始化尚未启动（initializationPromise 为空），主动拉起一次，避免早录音频因"无人初始化"被直接判失败。
    if (!this.serverReady) {
      if (!this.initializationPromise) {
        this.logger.info && this.logger.info('引擎尚未初始化，按需拉起 FunASR 服务器...');
        try { this.preInitializeModels(); } catch (_) {}
      }
      if (this.initializationPromise) {
        this.logger.info && this.logger.info('等待FunASR服务器就绪（早录音频排队中）...');
        let initTimeoutHandle = null;
        try {
          await Promise.race([
            this.initializationPromise,
            new Promise((_, reject) => {
              initTimeoutHandle = setTimeout(() => reject(new Error('FunASR 初始化超时')), INIT_WAIT_TIMEOUT_MS);
            }),
          ]);
        } catch (_) { /* 失败下方统一处理 */ } finally {
          if (initTimeoutHandle) clearTimeout(initTimeoutHandle);
        }
      }
    }

    const tempAudioPath = await this.createTempAudioFile(audioBlob);
    
    try {
      if (!this.serverReady) {
        throw new Error('FunASR服务器未就绪，请稍后重试');
      }
      
      // 使用服务器模式
      this.logger.info && this.logger.info('使用FunASR服务器模式进行转录');
      const result = await this._sendServerCommand({
        action: 'transcribe',
        audio_path: tempAudioPath,
        options: options
      });
      
      if (!result.success) {
        throw new Error(result.error || '转录失败');
      }
      
      return {
        success: true,
        text: result.text.trim(),
        raw_text: result.raw_text,
        confidence: result.confidence || 0.0,
        language: result.language || "zh-CN"
      };
    } catch (error) {
      throw error;
    } finally {
      await this.cleanupTempFile(tempAudioPath);
    }
  }

  async createTempAudioFile(audioBlob) {
    const tempDir = os.tmpdir();
    const filename = `funasr_audio_${crypto.randomUUID()}.wav`;
    const tempAudioPath = path.join(tempDir, filename);
    
    this.logger.info && this.logger.info('创建临时文件:', tempAudioPath);

    let buffer;
    if (audioBlob instanceof ArrayBuffer) {
      buffer = Buffer.from(audioBlob);
    } else if (audioBlob instanceof Uint8Array) {
      buffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      buffer = Buffer.from(audioBlob, "base64");
    } else if (audioBlob && audioBlob.buffer) {
      buffer = Buffer.from(audioBlob.buffer);
    } else {
      throw new Error(`不支持的音频数据类型: ${typeof audioBlob}`);
    }
    
    this.logger.debug && this.logger.debug('缓冲区创建，大小:', buffer.length);

    await fs.promises.writeFile(tempAudioPath, buffer);
    
    // 验证文件是否正确写入
    const stats = await fs.promises.stat(tempAudioPath);
    this.logger.info && this.logger.info('临时音频文件创建:', {
      path: tempAudioPath,
      size: stats.size,
      isFile: stats.isFile()
    });
    
    if (stats.size === 0) {
      throw new Error("音频文件为空");
    }
    
    return tempAudioPath;
  }


  async cleanupTempFile(tempAudioPath) {
    try {
      await fs.promises.unlink(tempAudioPath);
    } catch (cleanupError) {
      // 临时文件清理错误不是关键问题
    }
  }

  async checkStatus() {
    try {
      if (this.serverReady) {
        // 已就绪：直接用缓存标志回答状态轮询，绝不把 status 命令塞进与转录共享的命令链，
        // 否则 3 秒一次的轮询可能排在用户的转录命令前面，拖慢"按下停止→出字"。
        return {
          success: true,
          ready: true,
          server_ready: true,
          models_initialized: this.modelsInitialized,
          initializing: false,
        };
      } else {
        // 检查FunASR是否已安装
        const installStatus = await this.checkFunASRInstallation();
        const modelStatus = await this.checkModelFiles();
        
        let error = "FunASR未安装";
        if (installStatus.installed) {
          if (!modelStatus.models_downloaded) {
            error = "模型文件未下载，请先下载模型";
          } else if (this.serverStartError) {
            // 暴露真实的启动失败原因，避免一直显示"正在启动中"造成无限等待
            error = `FunASR服务器启动失败: ${this.serverStartError.message}`;
          } else {
            error = "FunASR服务器正在启动中...";
          }
        }

        return {
          success: installStatus.installed && modelStatus.models_downloaded,
          error: error,
          installed: installStatus.installed,
          models_downloaded: modelStatus.models_downloaded,
          missing_models: modelStatus.missing_models || [],
          start_error: this.serverStartError || null,
          initializing: this.initializationPromise !== null && !this.serverStartError
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        installed: false,
        models_downloaded: false
      };
    }
  }
}

module.exports = FunASRManager;