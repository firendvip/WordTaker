<div align="center">

# WordTaker

**本地优先的中文语音输入工具 —— 本地识别 + AI 润色,说完即贴到光标处**

<img src="https://img.shields.io/badge/version-0.1.0-brightgreen" alt="Version">
<img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
<img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License">

</div>

<br/>

WordTaker 是一个注重隐私的桌面端中文语音输入工具:按一下快捷键说话,**本地**把语音转成文字,再用 AI 把口语整理成通顺文案,自动粘贴到你当前光标位置。语音识别全程在本机离线运行,转写文本只保存在本地。

## ✨ 特性

- 🎙️ **本地离线识别**:内置 FunASR(SenseVoice / Paraformer),中文识别在本机运行,语音不出本机。
- 💡 **AI 文案润色**:识别后用 DeepSeek 把口语整理成通顺书面语(去口头禅、纠错别字、理顺逻辑)。
- ⌨️ **双键控制**:左 Option 结束=走 AI 润色;另一个键(默认左 Ctrl)结束=直接贴原始识别,更快、零成本。
- 🔒 **隐私优先**:转写文本只存本机、不上传、不用于训练;历史记录可随时删除。
- 🔑 **Key 安全分发(可选)**:通过自建中转(腾讯云云函数 / Cloudflare Worker)代理 AI 请求,真实 API key 只存在服务器端,分发给他人时无法被提取。
- 🔔 **可调提示音**:唤起/结束提示音(实时合成,无版权问题,可选无声)。
- 🪟 **后台常驻**:菜单栏常驻、单实例运行,平时不打扰。

## 🚀 快速开始

### 环境要求
- **Node.js 18+**
- **Python 3.8+**(运行本地 FunASR 服务)
- **macOS 10.15+** / **Windows 10+** / **Linux**

### 安装与运行

```bash
# 1. 克隆项目
git clone https://github.com/firendvip/WordTaker.git
cd WordTaker

# 2. 安装 Node 依赖
pnpm install        # 或 npm install

# 3. 准备 Python 环境与模型(推荐 uv)
uv sync
uv run python download_models.py
#   或使用系统 Python:
#   python3 -m venv .venv && source .venv/bin/activate
#   pip install funasr modelscope torch torchaudio librosa numpy
#   python download_models.py

# 4. 启动
pnpm run dev
```

启动后程序常驻菜单栏。按**左 Option** 开始/结束录音(可在设置里改键),Esc 取消。

### AI 润色配置(两种模式)
- **直连模式(自用最快)**:在设置中填入自己的 DeepSeek API Key,客户端直接调用。
- **中转模式(分发推荐)**:部署一个自建中转,客户端只发待润色文本、由服务器补 key 转发,API key 不下发到用户机器。部署见 [`relay/`](relay/) 目录(含腾讯云 SCF 与 Cloudflare Worker 两套)。

## 🛠️ 技术栈

- **桌面端**:Electron
- **前端**:React 19、Tailwind CSS、Vite
- **本地语音**:FunASR(SenseVoice ONNX / Paraformer、FSMN-VAD、CT-Transformer)
- **AI 润色**:DeepSeek(兼容 OpenAI 风格接口)
- **本地存储**:better-sqlite3

## 🙏 致谢

- [FunASR](https://github.com/modelscope/FunASR) —— 阿里巴巴开源的工业级语音识别工具包。
- [shadcn/ui](https://ui.shadcn.com/) —— 高质量可组合的 React 组件。

## 📄 许可证

本项目采用 [Apache License 2.0](LICENSE)。
