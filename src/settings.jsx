import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { toast, Toaster } from "sonner";
import { Settings, Save, Eye, EyeOff, X, Loader2, TestTube, CheckCircle, XCircle, Mic, Shield, Keyboard, Volume2, Play, Sparkles } from "lucide-react";
import { usePermissions } from "./hooks/usePermissions";
import PermissionCard from "./components/ui/permission-card";
import { SOUND_SCHEMES, previewSound, playEnd } from "./utils/sounds";

const SettingsPage = () => {
  const [settings, setSettings] = useState({
    ai_api_key: "",
    ai_base_url: "https://api.deepseek.com",
    ai_model: "deepseek-v4-flash",
    enable_ai_optimization: true,
    copywriting_mode_enabled: true,
    llm_prompt_template: "",
    llm_fallback_paste_raw: false,
    recording_trigger_key: "LeftOption",
    recording_trigger_taps: 1,
    cancel_key: "Escape",
    raw_stop_key: "LeftCtrl",
    sound_scheme: "soft",
    sound_volume: 0.3,
    asr_engine: "sensevoice"
  });

  const isMac = typeof navigator !== "undefined" && !!navigator.platform && navigator.platform.toLowerCase().includes("mac");
  
  const [customModel, setCustomModel] = useState(false);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // 权限管理
  const showAlert = (alert) => {
    toast(alert.title, {
      description: alert.description,
      duration: 4000,
    });
  };

  const {
    micPermissionGranted,
    accessibilityPermissionGranted,
    requestMicPermission,
    testAccessibilityPermission,
  } = usePermissions(showAlert);

  // 加载设置
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      if (window.electronAPI) {
        const allSettings = await window.electronAPI.getAllSettings();
        const loadedSettings = {
          ai_api_key: allSettings.ai_api_key || "",
          ai_base_url: allSettings.ai_base_url || "https://api.deepseek.com",
          ai_model: allSettings.ai_model || "deepseek-v4-flash",
          enable_ai_optimization: allSettings.enable_ai_optimization !== false, // 默认为true
          copywriting_mode_enabled: allSettings.copywriting_mode_enabled !== false, // 默认为true
          llm_prompt_template: allSettings.llm_prompt_template || "",
          llm_fallback_paste_raw: allSettings.llm_fallback_paste_raw === true,
          recording_trigger_key: (allSettings.recording_trigger && allSettings.recording_trigger.key)
            || (isMac ? "LeftOption" : "LeftAlt"),
          recording_trigger_taps: (allSettings.recording_trigger && allSettings.recording_trigger.taps)
            || (isMac ? 1 : 2),
          cancel_key: allSettings.cancel_key || "Escape",
          raw_stop_key: allSettings.raw_stop_key || "LeftCtrl",
          sound_scheme: allSettings.sound_scheme || "soft",
          sound_volume: typeof allSettings.sound_volume === "number" ? allSettings.sound_volume : 0.3,
          asr_engine: allSettings.asr_engine || "sensevoice"
        };
        setSettings(prev => ({ ...prev, ...loadedSettings }));

        // 检查是否使用自定义模型
        const predefinedModels = ["deepseek-v4-flash", "deepseek-v4-pro", "gpt-3.5-turbo", "gpt-4", "gpt-4-turbo", "gpt-4o", "gpt-4o-mini", "qwen3-30b-a3b-instruct-2507"];
        setCustomModel(!predefinedModels.includes(loadedSettings.ai_model));
      }
    } catch (error) {
      console.error("加载设置失败:", error);
      toast.error("加载设置失败");
    } finally {
      setLoading(false);
    }
  };

  // 保存设置
  const saveSettings = async () => {
    try {
      setSaving(true);
      if (window.electronAPI) {
        // 保存每个设置项
        await window.electronAPI.setSetting('ai_api_key', settings.ai_api_key);
        await window.electronAPI.setSetting('ai_base_url', settings.ai_base_url);
        await window.electronAPI.setSetting('ai_model', settings.ai_model);
        await window.electronAPI.setSetting('enable_ai_optimization', settings.enable_ai_optimization);
        await window.electronAPI.setSetting('copywriting_mode_enabled', settings.copywriting_mode_enabled);
        await window.electronAPI.setSetting('llm_prompt_template', settings.llm_prompt_template);
        await window.electronAPI.setSetting('llm_fallback_paste_raw', settings.llm_fallback_paste_raw);

        // 录音触发键（裸修饰键 + 单/双击），保存后立即重载使其生效
        await window.electronAPI.setSetting('recording_trigger', {
          type: 'modifier-tap',
          key: settings.recording_trigger_key,
          taps: Number(settings.recording_trigger_taps) || 1
        });
        if (window.electronAPI.reloadRecordingTrigger) {
          await window.electronAPI.reloadRecordingTrigger();
        }

        // 取消键 + 提示音 + 识别引擎
        await window.electronAPI.setSetting('cancel_key', settings.cancel_key || 'Escape');
        await window.electronAPI.setSetting('sound_scheme', settings.sound_scheme);
        await window.electronAPI.setSetting('sound_volume', Number(settings.sound_volume));
        await window.electronAPI.setSetting('asr_engine', settings.asr_engine);

        toast.success("设置保存成功");
      }
    } catch (error) {
      console.error("保存设置失败:", error);
      toast.error("保存设置失败");
    } finally {
      setSaving(false);
    }
  };

  // 处理输入变化
  const handleInputChange = (key, value) => {
    setSettings(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // 修改即保存（无需点按钮）。trigger/cancel 键改完立即重载生效。
  const updateAndSave = (field, value) => {
    setSettings(prev => {
      let next = { ...prev, [field]: value };
      // 总开关：同时控制 AI 文案优化（含提示词）两条链路
      if (field === "ai_master_enabled") {
        next = { ...next, copywriting_mode_enabled: value, enable_ai_optimization: value };
      }
      (async () => {
        try {
          if (!window.electronAPI) return;
          if (field === "ai_master_enabled") {
            await window.electronAPI.setSetting("copywriting_mode_enabled", value);
            await window.electronAPI.setSetting("enable_ai_optimization", value);
          } else if (field === "recording_trigger_key" || field === "recording_trigger_taps") {
            await window.electronAPI.setSetting("recording_trigger", {
              type: "modifier-tap",
              key: next.recording_trigger_key,
              taps: Number(next.recording_trigger_taps) || 1,
            });
            if (window.electronAPI.reloadRecordingTrigger) await window.electronAPI.reloadRecordingTrigger();
          } else if (field === "cancel_key") {
            await window.electronAPI.setSetting("cancel_key", value);
            if (window.electronAPI.reloadRecordingTrigger) await window.electronAPI.reloadRecordingTrigger();
          } else if (field === "raw_stop_key") {
            // 录音期间动态注册，下次录音即生效，无需重载主触发器
            await window.electronAPI.setSetting("raw_stop_key", value);
          } else if (field === "sound_scheme") {
            await window.electronAPI.setSetting("sound_scheme", value);
          } else if (field === "sound_volume") {
            await window.electronAPI.setSetting("sound_volume", Number(value));
          }
        } catch (e) {
          console.error("自动保存失败:", e);
        }
      })();
      return next;
    });
  };

  // 单独保存并立即应用录音触发键（不依赖 API Key）
  const saveRecordingTrigger = async () => {
    try {
      if (!window.electronAPI) return;
      await window.electronAPI.setSetting('recording_trigger', {
        type: 'modifier-tap',
        key: settings.recording_trigger_key,
        taps: Number(settings.recording_trigger_taps) || 1
      });
      await window.electronAPI.setSetting('cancel_key', settings.cancel_key || 'Escape');
      if (window.electronAPI.reloadRecordingTrigger) {
        await window.electronAPI.reloadRecordingTrigger();
      }
      toast.success("快捷键已更新并生效");
    } catch (error) {
      console.error("保存录音快捷键失败:", error);
      toast.error("保存录音快捷键失败");
    }
  };

  // 保存提示音设置
  const saveSound = async () => {
    try {
      if (!window.electronAPI) return;
      await window.electronAPI.setSetting('sound_scheme', settings.sound_scheme);
      await window.electronAPI.setSetting('sound_volume', Number(settings.sound_volume));
      toast.success("提示音已更新");
    } catch (error) {
      console.error("保存提示音失败:", error);
      toast.error("保存提示音失败");
    }
  };

  // 触发键可选项（标签随平台调整）
  const triggerKeyOptions = [
    { value: "LeftOption", label: isMac ? "左 Option ⌥" : "左 Alt" },
    { value: "RightOption", label: isMac ? "右 Option ⌥" : "右 Alt" },
    { value: "LeftMeta", label: isMac ? "左 Command ⌘" : "左 Win" },
    { value: "RightMeta", label: isMac ? "右 Command ⌘" : "右 Win" },
    { value: "LeftCtrl", label: "左 Control ⌃" },
    { value: "LeftShift", label: "左 Shift ⇧" },
  ];

  // 应用推荐配置
  const applyRecommendedConfig = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ai_model: "qwen3-30b-a3b-instruct-2507"
    }));
    setCustomModel(true);
    toast.info("已应用阿里云推荐配置");
  };

  // 应用 DeepSeek 配置
  const applyDeepSeekConfig = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://api.deepseek.com",
      ai_model: "deepseek-v4-flash"
    }));
    setCustomModel(false);
    toast.info("已应用 DeepSeek 配置");
  };

  // 重置为OpenAI配置
  const resetToOpenAI = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://api.openai.com/v1",
      ai_model: "gpt-3.5-turbo"
    }));
    setCustomModel(false);
    toast.info("已重置为OpenAI配置");
  };

  // 测试AI配置
  const testAIConfiguration = async () => {
    try {
      setTesting(true);
      setTestResult(null);
      
      // 验证当前输入的配置
      if (!settings.ai_api_key.trim()) {
        setTestResult({
          available: false,
          error: '请先输入API密钥',
          details: 'API密钥不能为空'
        });
        toast.error("配置不完整", {
          description: "请先输入API密钥"
        });
        return;
      }
      
      if (window.electronAPI) {
        // 使用当前页面的配置进行测试，而不是已保存的配置
        const testConfig = {
          ai_api_key: settings.ai_api_key.trim(),
          ai_base_url: settings.ai_base_url.trim() || 'https://api.openai.com/v1',
          ai_model: settings.ai_model.trim() || 'gpt-3.5-turbo'
        };
        
        const result = await window.electronAPI.checkAIStatus(testConfig);
        setTestResult(result);
        
        if (result.available) {
          toast.success("AI配置测试成功！", {
            description: `模型: ${result.model || '未知'} - 连接正常`
          });
        } else {
          toast.error("AI配置测试失败", {
            description: result.error || "未知错误"
          });
        }
      }
    } catch (error) {
      console.error("测试AI配置失败:", error);
      setTestResult({
        available: false,
        error: error.message || "测试失败"
      });
      toast.error("测试失败", {
        description: error.message || "未知错误"
      });
    } finally {
      setTesting(false);
    }
  };

  // 关闭窗口
  const handleClose = () => {
    if (window.electronAPI) {
      window.electronAPI.hideSettingsWindow();
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-neutral-950 flex items-center justify-center">
        <div className="flex items-center space-x-3">
          <Loader2 className="w-6 h-6 animate-spin text-neutral-500 dark:text-neutral-400" />
          <span className="text-gray-700 dark:text-gray-300">加载设置中...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-50 dark:bg-neutral-950 flex flex-col">
      {/* 标题栏 - 固定 */}
      <div className="bg-white/70 dark:bg-neutral-950/70 backdrop-blur-md border-b border-gray-100 dark:border-neutral-900 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <span className="inline-block w-2 h-2 rounded-full bg-neutral-400 dark:bg-neutral-500" />
            <h1 className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-100 chinese-title">设置</h1>
          </div>
          <button
            onClick={handleClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>
      </div>

      {/* 主要内容 - 可滚动 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-2xl mx-auto p-6 pb-8">
          {/* 权限管理部分 */}
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  权限管理
                </h2>
              </div>
              
              <div className="space-y-2">
                <PermissionCard
                  icon={Mic}
                  title="麦克风权限"
                  description=""
                  granted={micPermissionGranted}
                  onRequest={requestMicPermission}
                  buttonText="测试麦克风"
                />

                <PermissionCard
                  icon={Shield}
                  title="辅助功能权限"
                  description=""
                  granted={accessibilityPermissionGranted}
                  onRequest={testAccessibilityPermission}
                  buttonText="测试权限"
                />
              </div>
            </div>
          </div>

          {/* AI配置 / 识别引擎：整体隐藏（功能仍按已保存的默认值生效，key/模型/引擎照常工作） */}
          {false && (<>
          <div className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  AI配置
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                 配置AI模型以优化和增强语音识别结果。如果API Key无效或未填写，优化功能将自动禁用。
               </p>
              </div>

             <div className="space-y-4">
               {/* AI优化开关 */}
               <div className="flex items-center justify-between pt-4">
                 <label htmlFor="ai-optimization-toggle" className="text-sm font-medium text-gray-800 dark:text-gray-200">
                   启用AI文本优化
                 </label>
                 <button
                   type="button"
                   role="switch"
                   aria-checked={settings.enable_ai_optimization}
                   onClick={() => handleInputChange('enable_ai_optimization', !settings.enable_ai_optimization)}
                   className={`${
                     settings.enable_ai_optimization ? 'bg-neutral-900 dark:bg-white' : 'bg-gray-300 dark:bg-gray-600'
                   } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-neutral-400 focus:ring-offset-2`}
                 >
                   <span
                     aria-hidden="true"
                     className={`${
                       settings.enable_ai_optimization ? 'translate-x-4' : 'translate-x-0'
                     } inline-block h-4 w-4 transform rounded-full bg-white dark:bg-neutral-900 shadow ring-0 transition duration-200 ease-in-out`}
                   />
                 </button>
               </div>

               {/* API Key */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    API Key *
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={settings.ai_api_key}
                      onChange={(e) => handleInputChange('ai_api_key', e.target.value)}
                      placeholder="请输入您的AI API Key"
                      className="w-full px-3 py-2 pr-10 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    用于AI文本优化功能的API密钥
                  </p>
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    API Base URL
                  </label>
                  <input
                    type="url"
                    value={settings.ai_base_url}
                    onChange={(e) => handleInputChange('ai_base_url', e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    AI服务的API端点地址，支持OpenAI兼容的API
                  </p>
                </div>

                {/* Model */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                      AI模型
                    </label>
                    <div className="flex items-center space-x-2">
                      <button
                        type="button"
                        onClick={applyDeepSeekConfig}
                        className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-300 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors"
                      >
                        DeepSeek
                      </button>
                      <button
                        type="button"
                        onClick={applyRecommendedConfig}
                        className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-300 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors"
                      >
                        阿里云推荐
                      </button>
                      <button
                        type="button"
                        onClick={resetToOpenAI}
                        className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 dark:bg-neutral-800 dark:text-neutral-300 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors"
                      >
                        OpenAI
                      </button>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <input
                        type="radio"
                        id="predefined-model"
                        name="model-type"
                        checked={!customModel}
                        onChange={() => setCustomModel(false)}
                        className="w-3 h-3 text-neutral-500 dark:text-neutral-400 border-gray-300 focus:ring-neutral-400"
                      />
                      <label htmlFor="predefined-model" className="text-xs text-gray-700 dark:text-gray-300">
                        预定义模型
                      </label>
                    </div>
                    
                    {!customModel && (
                      <select
                        value={settings.ai_model}
                        onChange={(e) => handleInputChange('ai_model', e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                      >
                        <option value="deepseek-v4-flash">DeepSeek V4 Flash (推荐)</option>
                        <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                        <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                        <option value="gpt-4">GPT-4</option>
                        <option value="gpt-4-turbo">GPT-4 Turbo</option>
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                        <option value="qwen3-30b-a3b-instruct-2507">Qwen3-30B (推荐)</option>
                      </select>
                    )}
                    
                    <div className="flex items-center space-x-2">
                      <input
                        type="radio"
                        id="custom-model"
                        name="model-type"
                        checked={customModel}
                        onChange={() => setCustomModel(true)}
                        className="w-3 h-3 text-neutral-500 dark:text-neutral-400 border-gray-300 focus:ring-neutral-400"
                      />
                      <label htmlFor="custom-model" className="text-xs text-gray-700 dark:text-gray-300">
                        自定义模型
                      </label>
                    </div>
                    
                    {customModel && (
                      <input
                        type="text"
                        value={settings.ai_model}
                        onChange={(e) => handleInputChange('ai_model', e.target.value)}
                        placeholder="输入自定义模型名称，如：qwen3-30b-a3b-instruct-2507"
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                      />
                    )}
                  </div>
                  
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    选择用于文本优化的AI模型。文案模式推荐使用 DeepSeek V4 Flash。
                  </p>
                </div>

                {/* 文案模式 */}
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        文案模式
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        开启后：识别文本必走大模型，按下方提示词生成文案再粘贴（而非粘贴识别原文）。
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.copywriting_mode_enabled}
                      onClick={() => handleInputChange('copywriting_mode_enabled', !settings.copywriting_mode_enabled)}
                      className={`${
                        settings.copywriting_mode_enabled ? 'bg-neutral-900 dark:bg-white' : 'bg-gray-300 dark:bg-gray-600'
                      } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-neutral-400 focus:ring-offset-2`}
                    >
                      <span
                        aria-hidden="true"
                        className={`${
                          settings.copywriting_mode_enabled ? 'translate-x-4' : 'translate-x-0'
                        } inline-block h-4 w-4 transform rounded-full bg-white dark:bg-neutral-900 shadow ring-0 transition duration-200 ease-in-out`}
                      />
                    </button>
                  </div>

                  {/* 提示词模板 */}
                  <div>
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                      提示词模板
                    </label>
                    <textarea
                      value={settings.llm_prompt_template}
                      onChange={(e) => handleInputChange('llm_prompt_template', e.target.value)}
                      rows={6}
                      placeholder={"用 ${text} 表示识别到的文本占位。例如：\n把下面这段口述整理成通顺的书面文案，保留原意：\n${text}"}
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                    />
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      用 <code className="px-1 bg-gray-100 dark:bg-neutral-800 rounded">{"${text}"}</code> 作为识别文本的占位；留空则使用内置默认模板。
                    </p>
                  </div>

                  {/* 失败回退 */}
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        失败时回退粘贴原文
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        关闭时：大模型失败则不粘贴，仅把识别原文复制到剪贴板并提示。
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={settings.llm_fallback_paste_raw}
                      onClick={() => handleInputChange('llm_fallback_paste_raw', !settings.llm_fallback_paste_raw)}
                      className={`${
                        settings.llm_fallback_paste_raw ? 'bg-neutral-900 dark:bg-white' : 'bg-gray-300 dark:bg-gray-600'
                      } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-neutral-400 focus:ring-offset-2`}
                    >
                      <span
                        aria-hidden="true"
                        className={`${
                          settings.llm_fallback_paste_raw ? 'translate-x-4' : 'translate-x-0'
                        } inline-block h-4 w-4 transform rounded-full bg-white dark:bg-neutral-900 shadow ring-0 transition duration-200 ease-in-out`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              {/* 测试结果显示 */}
              {testResult && (
                <div className={`mt-4 p-3 rounded-lg border ${
                  testResult.available
                    ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
                    : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                }`}>
                  <div className="flex items-center space-x-2">
                    {testResult.available ? (
                      <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
                    )}
                    <span className={`font-medium ${
                      testResult.available
                        ? 'text-green-800 dark:text-green-200'
                        : 'text-red-800 dark:text-red-200'
                    }`}>
                      {testResult.available ? 'AI配置测试成功' : 'AI配置测试失败'}
                    </span>
                  </div>
                  
                  {testResult.available && (
                    <div className="mt-2 space-y-1">
                      {testResult.model && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          <strong>模型:</strong> {testResult.model}
                        </p>
                      )}
                      {testResult.details && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          <strong>状态:</strong> {testResult.details}
                        </p>
                      )}
                      {testResult.response && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          <strong>AI回复:</strong> {testResult.response}
                        </p>
                      )}
                      {testResult.usage && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          Token使用: {testResult.usage.total_tokens || 'N/A'}
                        </p>
                      )}
                    </div>
                  )}
                  
                  {!testResult.available && (
                    <div className="mt-2 space-y-1">
                      {testResult.error && (
                        <p className="text-xs text-red-700 dark:text-red-300">
                          <strong>错误:</strong> {testResult.error}
                        </p>
                      )}
                      {testResult.details && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          {testResult.details}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex flex-col">
                  <button
                    onClick={testAIConfiguration}
                    disabled={testing}
                    className="flex items-center space-x-2 px-3 py-1.5 text-sm border border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <TestTube className="w-3 h-3" />
                    )}
                    <span>{testing ? "测试中..." : "测试配置"}</span>
                  </button>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    测试当前编辑的配置（无需保存）
                  </p>
                </div>
                
                <button
                  onClick={saveSettings}
                  disabled={saving || !settings.ai_api_key}
                  className="flex items-center space-x-2 px-4 py-1.5 text-sm bg-neutral-900 hover:bg-black text-white dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  <span>{saving ? "保存中..." : "保存设置"}</span>
                </button>
              </div>
            </div>
          </div>

          {/* 识别引擎 */}
          <div className="mt-4 bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="p-6">
              <div className="mb-3 flex items-center space-x-2">
                <Mic className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">识别引擎</h2>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
                SenseVoice 更快（约快 10 倍、自带标点）；Paraformer 更稳。两者均本地离线。
              </p>
              <select
                value={settings.asr_engine}
                onChange={(e) => handleInputChange('asr_engine', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
              >
                <option value="sensevoice">SenseVoice（快，推荐）</option>
                <option value="paraformer">Paraformer（稳，回退）</option>
              </select>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">改完点页面上方“保存设置”生效。</p>
            </div>
          </div>
          </>)}

          {/* AI 文案优化：强制开启、对用户隐藏（整块不渲染） */}
          {false && (
          <div className="mt-4 bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Sparkles className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                      AI 文案优化
                    </h2>
                    <p className="text-xs text-gray-500 dark:text-neutral-400 mt-0.5">
                      开启后用提示词把口语整理成通顺文案；关闭则直接粘贴原始识别文字。
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!settings.copywriting_mode_enabled}
                  onClick={() => updateAndSave('ai_master_enabled', !settings.copywriting_mode_enabled)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-400 ${
                    settings.copywriting_mode_enabled ? 'bg-neutral-900 dark:bg-white' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-neutral-900 transition-transform ${
                      settings.copywriting_mode_enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
          )}

          {/* 录音快捷键 */}
          <div className="mt-4 bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="p-6">
              <div className="mb-4 flex items-center space-x-2">
                <Keyboard className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  快捷键
                </h2>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    开始
                  </label>
                  <select
                    value={settings.recording_trigger_key}
                    onChange={(e) => updateAndSave('recording_trigger_key', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                  >
                    {triggerKeyOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    方式
                  </label>
                  <div className="flex items-center space-x-4">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="radio"
                        name="trigger-taps"
                        checked={Number(settings.recording_trigger_taps) === 1}
                        onChange={() => updateAndSave('recording_trigger_taps', 1)}
                        className="w-3 h-3 text-neutral-500 dark:text-neutral-400 border-gray-300 focus:ring-neutral-400"
                      />
                      <span className="text-xs text-gray-700 dark:text-gray-300">单击</span>
                    </label>
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="radio"
                        name="trigger-taps"
                        checked={Number(settings.recording_trigger_taps) === 2}
                        onChange={() => updateAndSave('recording_trigger_taps', 2)}
                        className="w-3 h-3 text-neutral-500 dark:text-neutral-400 border-gray-300 focus:ring-neutral-400"
                      />
                      <span className="text-xs text-gray-700 dark:text-gray-300">双击</span>
                    </label>
                  </div>
                </div>

                {/* 取消键 */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    取消
                  </label>
                  <select
                    value={settings.cancel_key}
                    onChange={(e) => updateAndSave('cancel_key', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                  >
                    <option value="Escape">Esc</option>
                    <option value="F1">F1</option>
                    <option value="F2">F2</option>
                    <option value="F4">F4</option>
                    <option value="F8">F8</option>
                  </select>
                </div>

                {/* 不走 AI 的结束键 */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    原文
                  </label>
                  <select
                    value={settings.raw_stop_key}
                    onChange={(e) => updateAndSave('raw_stop_key', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                  >
                    <option value="LeftCtrl">左 Control ⌃</option>
                    <option value="RightCtrl">右 Control ⌃</option>
                    <option value="RightOption">{isMac ? "右 Option ⌥" : "右 Alt"}</option>
                    <option value="RightMeta">{isMac ? "右 Command ⌘" : "右 Win"}</option>
                    <option value="RightShift">右 Shift ⇧</option>
                  </select>
                  <p className="mt-1 text-[11px] text-gray-400 dark:text-neutral-500">
                    按它结束＝直接贴原文，不走 AI
                  </p>
                </div>

              </div>
            </div>
          </div>

          {/* 提示音 */}
          <div className="mt-4 bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="p-6">
              <div className="mb-3 flex items-center space-x-2">
                <Volume2 className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">提示音</h2>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">声音</label>
                  <select
                    value={settings.sound_scheme}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateAndSave('sound_scheme', v);
                      // 切换音色即试听（无需按钮）
                      if (v !== 'none') previewSound(v, settings.sound_volume);
                    }}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-neutral-700 rounded-lg focus:ring-1 focus:ring-neutral-400 focus:border-transparent bg-white dark:bg-neutral-800 text-gray-900 dark:text-gray-100"
                  >
                    {SOUND_SCHEMES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    音量 {Math.round(Number(settings.sound_volume) * 100)}%
                  </label>
                  <input
                    type="range" min="0" max="1" step="0.05"
                    value={settings.sound_volume}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      updateAndSave('sound_volume', v);
                      // 拖动音量即按当前音色发声，听到对应大小（无需试听按钮）
                      if (settings.sound_scheme !== 'none') playEnd(settings.sound_scheme, v);
                    }}
                    className="w-full accent-neutral-700 dark:accent-neutral-200"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* 隐私与数据安全（置于最底部） */}
          <div className="mt-4 bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="p-6">
              <div className="mb-3 flex items-center space-x-2">
                <Shield className="w-5 h-5 text-neutral-500 dark:text-neutral-400" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  隐私与数据安全
                </h2>
              </div>
              <div className="bg-gray-50 dark:bg-neutral-800/50 rounded-lg p-4 space-y-2">
                <p className="text-xs text-gray-700 dark:text-neutral-300 flex items-start">
                  <span className="mr-2">🔒</span>
                  <span><strong>本地：</strong>转写文本只保存在本机，<strong>不存服务器、不用于训练</strong>。语音识别全程离线。</span>
                </p>
                <p className="text-xs text-gray-700 dark:text-neutral-300 flex items-start">
                  <span className="mr-2">🗑️</span>
                  <span><strong>删除：</strong>历史记录可随时删除，即从本机彻底移除。</span>
                </p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};

// 导出组件供App.jsx使用
export { SettingsPage };

// 如果是直接访问settings.html，则渲染应用
if (document.getElementById("settings-root")) {
  const root = ReactDOM.createRoot(document.getElementById("settings-root"));
  root.render(<SettingsPage />);
}