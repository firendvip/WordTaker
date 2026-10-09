# WordTaker 1.29.5 / Torch 安全候选

2026-10-09；仅隔离分支 `codex/wordtaker-release-candidate`。父提交 `70ced82764a1a7b1528330b62d5de7151084deff`，版本保持 1.29.5，macOS 下限保持 14.0。不是正式发布或零漏洞证明；旧 Mac14 报告保持原字节，不能代替本轮验收。

## 最小范围

- 仅 macOS arm64 更新为官方 Torch 2.10.0 build2、TorchAudio 2.10.0、torchvision 0.25.0；仅新增其必需的纯 Python fsspec 2026.9.0。Python 3.11.6、NumPy 1.26.4、FunASR 1.2.7、两种 ASR、VAD、标点、GGUF 入口保留。Windows x64/arm64 继续纯 ONNX；Linux/macOS x64 未迁移。
- 六个已审 wheel（含旧 ORT/SciPy）冻结原始官方 wheel SHA、完整包字节/文件数及 METADATA/WHEEL。二进制目标门禁检查实际 Mach-O，不以宿主导入或 wheel 标签替代。新版验证通过后仅将其旧 dist-info 移至临时可恢复目录，不清理其他包。
- 新模型清单固定三仓库 v2.0.4 的不可变 commit 与 14 个加载资源的大小/SHA；包括权重、配置、tokens、frontend 和分词字典。清单来源是官方 API + Git/LFS 的交叉比对，不是给用户缓存现算 SHA 后放行。提供方 tag 未签名，仍保留提供方信任残余。

## 模型和反序列化边界

`原始 HTTPS 字节 → 临时私有目录完整哈希校验 → 原子换入私有缓存 → 每次加载再验证 → 受限 torch.load`。

- 下载器不导入 FunASR/Torch，不反序列化；禁止 HTTP 降级、超长/短缺/错误 SHA、未知仓库、模型内 symlink、额外加载配置/代码和 requirements 安装。失败保留旧缓存；已有共享 ModelScope 缓存不就地修复。正式 Electron 显式传 userData/models/damo；旧独立准备命令默认使用 WordTaker 独占缓存，或显式 `--damo-root`。
- 服务/下载子进程强制 `TORCH_FORCE_WEIGHTS_ONLY_LOAD=1`，去除继承的 FORCE_NO；每次 load 清空额外 safe_globals，固定 CPU/weights_only，同一已验证文件描述符送入 PyTorch。拒绝 weights_only=False、自定义 pickle、未知 checkpoint、TorchScript archive/jit.load；没有不安全重试。AutoModel 前先验清单，禁止 remote-code/update。
- 不抵抗已取得同用户本机代码执行权的攻击者；固定 FD 降低路径替换风险，不宣称完全消除同 inode 并发写入或配置读取的 TOCTOU。
- TorchAudio 2.10 文件加载需要 TorchCodec，改用已有 soundfile/scipy 解码为 16k/mono/float32 ndarray，保持 PCM 缩放、声道平均、不峰值归一化。覆盖 warmup、VAD、长段、整段。渲染端本来传 PCM WAV；验证 WAV/AIFF/FLAC，未新增 TorchCodec、外部 FFmpeg 或宣称支持所有历史直传编码。

## 实际验证及证据位置

本轮忽略产物目录 `dist/qa/torch-security-r1/`：

- RED/GREEN 回归；JavaScript **398/398**，Windows 原生发现 **18/18**，rollback **6/6**；Python **48/48**，另有 local-model 2 项。被 python/ 忽略规则隐藏的五个源码测试显式纳入版本控制；索引导出的独立源码副本实际收集并通过 398 JS/48 Python。
- coverage.py 7.10.7 仅安装到 QA 工具目录，未进入嵌入式运行时。三关键模块语句/分支均 ≥80%：安全验证 164/192 行、69/86 分支；下载 136/145 行、41/48 分支；音频 18/18 行、6/6 分支。全服务历史逻辑不冒充全覆盖。最早未加 --missing 的 trace 100% 摘要不作覆盖率证据。
- lint **0 error / 367 既有 warning**；没有独立 typecheck 脚本。JS audit 0 critical/high、1 moderate；不代表 Python 全栈安全。
- `SAFE_CHECKPOINTS.json`：14 实际下载资源全部匹配固定清单，三 checkpoint 均在空 allowlist、weights-only 下作为普通 tensor state dict 成功加载。
- `REAL_ENGINE.json`：真合成 WAV/AIFF，无麦克风；六轮两引擎、66.75 秒长音频真实 VAD/分段、空 WAV、静音、显式 SenseVoice→Paraformer 降级。raw/text 与 requested/actual/fallback 保留。`WORKER_IPC.json`：实际管理器与隔离 worker，两次启动、中止在途识别、重启后再转写；中止命令按既有超时机制拒绝，不宣称底层瞬间取消或完整 UI E2E。
- FunASR 必要注册项 Paraformer/CifPredictorV2/FsmnVADStreaming/CTTransformer 全部实际存在；四个 JIT 固定函数来源与官方未变的 1.2.7 wheel 字节比对一致（`FUNASR_SOURCE_AUDIT.json`）。不提供用户源码/脚本入口，不执行恶意触发用例。
- NumPy↔Torch bridge、TorchAudio fbank、llama_cpp 0.3.30 导入与 373 个 Python arm64 Mach-O 的 14.0 下限通过；pip check 无缺依赖。renderer 与完整 embedded Python 检查通过。

## 性能和未闭环范围

- 极首次依赖导入曾耗时 73.2 秒；完整模型冷进程实测 16.76 秒、后续 12.93 秒，worker 两次约 11.33/11.41 秒。SenseVoice 稳态约 0.09–0.12 秒，Paraformer 约 0.81–1.26 秒（4.67 秒合成语音）。全模型峰值 RSS 约 **4.03 GB**。这些不是旧 Torch 全栈同条件基准，不据此宣称无性能回退；首次使用等待/低内存设备仍需真机验收。
- 1 样本音频返回结构化错误，空 WAV 明确拒绝；1 秒纯静音仍可能被模型误识别为少量文字，未擅改识别策略。未执行真实 GGUF 模型推理，仅验证未变入口和原生导入。
- 当前 [GitHub 公告 GHSA-rrmf-rvhw-rf47](https://github.com/advisories/GHSA-rrmf-rvhw-rf47) 对应 **CVE-2025-3000**，低危，影响 ≤2.12.1，2.13.0 修复，仍覆盖 Torch 2.10.0；[PyTorch 原始问题](https://github.com/pytorch/pytorch/issues/149623) 对应 torch.jit.script 内存错误。固定 FunASR import 的四个可信函数编译可达，不等于公告所有条件可达或漏洞已修复。保留 JIT 的残余，不混装缺配套 Audio 的更高 Torch。
- 历史 Python 存在代码/重复元数据不一致，QA 仅依据 RECORD 比对可恢复迁走明确陈旧元数据；requests 2.28.1/certifi 2022.12.07 等未自动升级。本次不是全 Python 栈锁定或漏洞清零，pip check 不能替代安全扫描。
- 内部目录包实际验收：393 个 Mach-O（391 活跃 arm64、2 非运行 x64 prebuild），所有活跃 slice 满足 14.0；373 个 Python native 与六包字节再次通过，53 份运行时源码/26 份 renderer 与候选一致。实际加载 SQLite/uiohook 的 arm64/ABI148/SHA 和 listen-only 指令独立核对；preload/WebAudio/取消 IPC 通过。包内 Python 两引擎、VAD/长短/空/静音/降级和中止重启场景也通过，均为隔离 userData，无麦克风/主应用启动。包内模型冷进程约 12.65 秒、峰值 4.08 GB，worker 首/次启动 21.62/13.74 秒。
- 本次最终 SHA 的 Windows 双架构 CI 回执仍待收集；不得用旧 SHA 结果替代。任何内部未签名包均不得上传公开安装器/Release。
- 宿主 macOS 26.6.2；实际 macOS 14 设备、Windows ARM64 设备、可信正式签名/公证、真实麦克风/系统热键/TCC/短信登录均未完成，不具备公开发布资格。
