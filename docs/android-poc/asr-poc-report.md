# 安卓输入法 阶段0 · ASR PoC 离线基准初筛报告

日期：2026-07-10 ｜ 执行环境：macOS 26.5.2，Apple M1 Max（arm64），sherpa-onnx 1.13.4（Python，CPU，num_threads=2）

> **重要前提**：测试集为 macOS `say -v Tingting` 合成的 TTS 干净语音。真实场景（麦克风、噪声、口音、语速变化）CER 会显著更高，本数据**仅作模型间横向对比**，不代表真机绝对准确率。RTF/延迟为 M1 Max 数值，安卓中端机预计慢 3~10 倍。

## 测试集

- 24 句多样中文（日常口语/数字/人名地名/指令/长短混合），共 109.9 秒音频
- `say -v Tingting` 合成 → `afconvert` 转 16kHz 16bit 单声道 WAV
- CER 计算：参考文本与识别结果均归一化（去标点/去空白/全角转半角/小写）后按字符编辑距离
- SenseVoice 关闭 ITN（`use_itn=False`），避免「十点→10点」被误判为错误，保证横向公平
- 流式模型按 0.2s 分块尽速喂入；「首字延迟」= 从开始喂入到出现第一个字的纯计算耗时；「尾部延迟」= 说完（最后一块喂完）到出最终结果的耗时

## 结果总表

| 模型 | 类型 | CER | RTF | 平均单句解码 | 首字延迟(计算) | 尾部延迟(说完→出字) | 磁盘体积 | 解码峰值内存 |
|---|---|---|---|---|---|---|---|---|
| **流式 Zipformer multi-zh-hans (2023-12-12, int8)** | 流式 | **0.00%** | 0.042 | 0.19s | 15ms | **24ms** | **69.1 MB** | **272 MB** |
| 流式 Zipformer bilingual zh-en (2023-02-20, int8) | 流式 | **12.28%（异常）** | 0.041 | 0.19s | 15ms | 23ms | 189.1 MB | 527 MB |
| 流式 Zipformer bilingual zh-en (同上, fp32 对照) | 流式 | 0.00% | 0.064 | 0.29s | 25ms | 36ms | 340.3 MB | 781 MB |
| SenseVoice (2024-07-17, int8) | 非流式 | 0.00% | **0.026** | 0.12s | — | 117ms(整句) | 228.5 MB | 633 MB |
| Paraformer-zh (2023-09-14, int8) | 非流式 | 0.22% | **0.025** | 0.12s | — | 116ms(整句) | 232.2 MB | 610 MB |
| 流式 Paraformer bilingual (int8) | 流式 | 1.54% | 0.048 | 0.22s | 27ms | 26ms | 226.2 MB | 538 MB |

注：非流式模型无首字延迟概念，「说完→出字」= 整句解码耗时（平均 0.12s）。体积只计推理必需文件（onnx + tokens）。内存为整进程峰值 RSS（含 Python 运行时 ~60MB；安卓 native 接入会更低）。

## 关键发现

1. **bilingual zh-en 的官方 int8 版有严重量化劣化**：TTS 语音下大量字重复（「会会议易士的投影影仪疑坏坏坏坏了」），CER 从 fp32 的 0% 恶化到 12.3%；换 modified_beam_search 无效、调语速无效，官方 test_wavs 正常 → int8 encoder 对该模型的动态量化不稳，**不可用**。
2. **multi-zh-hans (2023-12-12) int8 完全健康**：同为流式 Zipformer，CER 0%、体积仅 69MB（约为其他模型的 1/3）、峰值内存 272MB（约为其他的一半），首字 15ms、说完到定稿仅 24ms。它是更新的 Zipformer2 架构、多中文数据集训练。
3. SenseVoice / Paraformer 离线精度与速度俱佳（RTF≈0.025），但**非流式**：无法边说边出字，且录音越长「说完→出字」等待越久（线性增长），SenseVoice 官方已宣布停止更新。
4. 流式 Paraformer 精度略差（CER 1.5%，有句尾丢字倾向），体积 226MB 无优势。

## 各模型优劣

| 模型 | 优 | 劣 |
|---|---|---|
| 流式 Zipformer multi-zh-hans int8 | 体积最小(69MB)、内存最低、边说边出字、尾延迟 24ms、CER 持平最佳 | 以中文为主，英文能力弱于 bilingual 版；标点需另配（如 CT-Transformer 标点小模型） |
| 流式 Zipformer bilingual int8 | 中英混说 | **官方 int8 已坏**；fp32 340MB 超安卓包体预算 |
| SenseVoice int8 | 精度好、RTF 最低、带 ITN/标点/多语种 | 非流式、228MB、官方停更、长录音出字等待线性变长 |
| Paraformer-zh int8 | 精度好、生态成熟（与现桌面版同源） | 非流式、232MB、无标点 |
| 流式 Paraformer int8 | 流式、生态同源 | CER 明显差一档、句尾丢字、226MB |

## 推荐结论

**推荐：流式 Zipformer `sherpa-onnx-streaming-zipformer-multi-zh-hans-2023-12-12`（int8）作为安卓端首选。**

理由（对齐安卓端诉求）：
- **快**：首字 15ms、说完 24ms 定稿（M1 Max 计算耗时；即使安卓慢 10 倍也在 0.25s 内），用户体感「边说边出字、一说完即定稿」，优于非流式方案「说完再等整句解码」的体验，且等待不随录音变长。
- **小**：69MB 是六个候选中唯一能轻松塞进安卓包体/首启下载的体积；内存 272MB 峰值对中端机安全。
- **稳**：CER 与最佳持平（TTS 集 0%），int8 量化健康（bilingual 版 int8 已坏，勿用）。
- SenseVoice 官方停更且非流式，不宜作为安卓新客户端的长期底座；可作为「录音后二次精修」的备选，不作首选。

**备选**：若真机验证 multi-zh-hans 在噪声/口音下明显劣化，退而测 SenseVoice int8（非流式，接受出字等待）。

## 真机待验证项清单

1. 安卓中端/低端真机（如骁龙 7 系、天玑 8 系）实测 RTF、首字延迟、说完→出字延迟（sherpa-onnx Android AAR / JNI）
2. 真实麦克风 + 噪声/口音/快慢语速下的 CER（TTS 数据无法代表）
3. 峰值内存与整机内存压力（低端 4GB 机型），及后台被杀概率
4. 中英混说场景：multi-zh-hans 的英文能力是否够用；不够则评估 bilingual fp16/重新量化 int8（官方 int8 不可用）
5. 标点方案：搭配 sherpa-onnx CT-Transformer 标点小模型（~66MB int8）的延迟与效果
6. 长语音（>1 分钟）连续听写的稳定性、endpoint 检测参数调优
7. 功耗/发热（连续听写 10 分钟）
8. 模型文件下载/解压方案（69MB 放包内 vs 首启下载）

## 复现

- 工作目录：`/private/tmp/claude-502/.../scratchpad/asr-poc/`（bench.py + testset/refs.txt + 各 results_*.json）
- 每模型独立进程测量（`resource.getrusage` 峰值 RSS），逐句解码前有 1 句预热
