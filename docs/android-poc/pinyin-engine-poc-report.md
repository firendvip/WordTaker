# 安卓拼音引擎 PoC 报告（阶段0）

- 日期：2026-07-10
- 结论先行：**推荐路线 (a)——librime (BSD-3) 核心 + 自研 Kotlin UI + 自写 JNI 绑定。闭源上架可行。** 引擎已在 Mac 实测跑通，整句转换、候选排序、用户造词、T9 九键全部验证通过。

---

## 1. 许可证审计结论表

| 组件 | 许可证 | 闭源 App 可用？ | 出处 |
|---|---|---|---|
| librime 核心 | **BSD-3-Clause** | ✅ 可，仅需保留版权声明 | https://github.com/rime/librime （README 许可证徽章 → BSD-3） |
| librime 依赖（Boost/glog/leveldb/yaml-cpp/OpenCC） | BSL / BSD-3 / BSD-3 / MIT / Apache-2.0 | ✅ 全部宽松 | 各仓库 LICENSE |
| librime 依赖 marisa-trie | BSD-2 / LGPL-2.1 **双许可** | ✅ 选 BSD-2 分支即可 | librime README 依赖列表 |
| rime-luna-pinyin（schema + 词库） | **LGPL-3.0** | ⚠️ 可（作为可替换的独立数据文件打包，附许可证与来源；不改源则给上游链接即可） | https://github.com/rime/rime-luna-pinyin （LICENSE） |
| rime-essay（八股文语言模型 essay.txt） | **LGPL-3.0** | ⚠️ 同上 | https://github.com/rime/rime-essay |
| rime-prelude（default/punctuation/key_bindings） | LGPL-3.0（rime 官方配置同族） | ⚠️ 同上；也可完全自写替代（内容极简单） | https://github.com/rime/rime-prelude |
| fcitx5 核心 | LGPL-2.1+ | ⚠️ 动态链接可闭源，但无必要引入 | https://github.com/fcitx/fcitx5 （README 明写 LGPL-2.1+） |
| libime | LGPL-2.1-or-later | ⚠️ 动态链接 .so 可闭源（需许可声明+可替换） | https://github.com/fcitx/libime/tree/master/LICENSES |
| fcitx5-chinese-addons | LGPL-2.1+ | ⚠️ 同上 | https://github.com/fcitx/fcitx5-chinese-addons |
| fcitx5-android 工程 | LGPL-2.1 | ❌ 整工程作骨架=衍生作品，需整体 LGPL 开源，不可取 | https://github.com/fcitx5-android/fcitx5-android |
| Trime（含其 librime JNI 层） | **GPL-3.0** | ❌ 传染，任何代码不可抄（只能看思路自己重写） | https://github.com/osfans/trime |
| rime-ice（含现成 t9.schema.yaml） | GPL-3.0 | ❌ 不可打包/不可抄；T9 需自写（已验证极简单，见 §3.4） | https://github.com/iDvel/rime-ice |

### 三条路线判定

| 路线 | 法律风险 | 判定 |
|---|---|---|
| **(a) librime(BSD-3) + 自研 UI + 自写 JNI** | **低**。原生代码全宽松许可；唯一 LGPL 是词库**数据文件**（非链接、可替换、不修改），按「附许可证文本 + 上游链接 + 数据文件独立存放」即合规。业界闭源 App 带 LGPL 组件（如 FFmpeg）是成熟惯例 | ✅ **推荐主线** |
| (b) libime(LGPL) 动态链接 + 自研 UI | 中。链接层 LGPL 合规义务（声明+允许替换 .so）；且 fcitx5-chinese-addons 也是 LGPL，拆出纯引擎工作量大、社区脱离 fcitx 框架用 libime 的先例少 | ⚠️ 备选，不推荐 |
| (c) 基于 fcitx5-android / Trime 整工程 | **高**。Trime GPL-3 直接传染；fcitx5-android 以整 App 工程为基座即衍生作品，须整体开源 | ❌ 排除 |

> 若想把词库的 LGPL 也消掉：后续可自建词库（CC-CEDICT 是 CC BY-SA 4.0，或采购商业词库），librime 词库格式是纯文本 yaml，替换成本低。非阻塞项。

---

## 2. 引擎本地实测（Mac, librime 1.17.0, Homebrew）

环境：`brew install librime`（brew 版不带 rime_api_console，改为自写 C 程序直调 `rime_api.h`，与安卓 JNI 调用路径完全一致，更贴近真实集成）。数据：luna_pinyin schema + 词库（7 万行）+ essay.txt 语言模型 + prelude 配置。

### 2.1 全拼连打转句（luna_pinyin_simp 简体）

| 输入 | 第 1 候选 | 判定 |
|---|---|---|
| `zhongguorenmin` | 中国人民 | ✅ |
| `jintiantianqizhenhaowomenyiqiqugongyuanba`（41 键长句） | 今天天气真好我们一起去公园吧 | ✅ 整句一次正确 |
| `yuyinshurufa` | 语音输入法 | ✅ |
| `beijingdaxue` | 北京大学（2-5 候选：北京大学出版社/图书馆/北京/背景） | ✅ 排序合理 |
| `nihao` | 你好 | ✅ |
| `zhngguo`（漏键） | 只能各国（错） | ⚠️ 默认 schema 无模糊纠错；可用 speller/algebra 的 derive 规则补（luna 自带 abbreviation/correction 可开启） |

单次转换耗时 0–15ms（41 键长句 15ms），完全满足实时按键响应。

### 2.2 用户造词 / 学习

- 输入 `xianwaixiaomao`，逐段选「弦(第20候选)/外/小猫」提交 →「弦外小猫」。
- **重输同串，「弦外小猫」立即升为第 1 候选**（原第 1「线外小猫」降为第 2）。✅ 用户词典学习开箱即用（leveldb 用户词库，自动持久化）。

### 2.3 联想

选字提交后 librime 本身不弹「后续联想」候选（rime 设计如此，联想=UI 层用用户词库/云端做）。造词+长句连打已覆盖主要体验；纯「打完继续联想下一词」放到候选栏层做（可用云候选或简单 bigram），不阻塞。

### 2.4 九宫格 T9 —— 已实测可行，无需第三方方案

自写 30 行 schema（`speller/algebra: xlit/abcdefghijklmnopqrstuvwxyz/22233344455566677778889999/`，alphabet 设为数字），词库照用 luna_pinyin：

| 数字输入 | 第 1 候选 | 判定 |
|---|---|---|
| `64426` | 你好 | ✅ |
| `9426924`（xianwai） | 出「弦/小/先/线」等正确同码候选 | ✅ |

结论：**T9 不需要 rime-ice 等 GPL 方案，自写 schema 即可**（零许可证问题）。生产版需在 UI 层做「数字→拼音注释」显示（librime 候选自带 annotation 字段可用）。

### 2.5 性能与体积（实测值）

| 项 | 实测 |
|---|---|
| 首次部署（yaml 词库全量编译） | 2.3–2.7s（M 系 Mac；安卓中端机预估 10–30s，**应改为 APK 内直接打包预编译产物，首启免编译**） |
| 二次启动 initialize+deploy | 24ms |
| 首个会话 + schema 加载 | 42ms |
| 单次按键→候选 | <1ms；41 键整句 15ms |
| 编译产物 | luna_pinyin.table.bin 4.4MB + reverse.bin 248KB + prism 32KB ≈ **4.7MB** |
| 词库源文件 | dict 872KB + essay 5.6MB（打预编译产物则源文件不必进 APK） |
| librime 动态库（arm64 Mac 参考） | 2.4MB |

---

## 3. 安卓集成路径评估

1. **JNI 绑定：无现成宽松许可绑定，需自写——工作量小。** Trime 的 librime-jni 是 GPL-3（不可抄）、fcitx5-android 的 rime 插件是 LGPL（不必引）。librime 暴露纯 C 的 `rime_api.h`（本 PoC 即直调该 API，共 ~15 个核心函数：setup/initialize/create_session/process_key/get_context/select_candidate/get_commit/select_schema）。自写 JNI + Kotlin 封装预估 **3–5 人日**（PoC 的 C 代码可直接迁移为 JNI 实现）。
2. **NDK 编译 librime + 依赖**：CMake 全家（boost/glog/leveldb/marisa/opencc/yaml-cpp），Trime 与 fcitx5-android 的 CI 证明 NDK 编译成熟可行（只参考其 CMake 编法思路，不复制其代码）。预估 **3–5 人日**（含 arm64-v8a + armeabi-v7a）。
3. **包体代价**：librime .so ≈ 2.5–4MB/ABI（静态并入依赖后）+ 预编译词库 4.7MB（zip 后更小）→ **APK 增量预估 8–12MB**，可接受；只出 arm64 可再省。
4. **初始化**：打包预编译 bin 后，冷启动引擎初始化预估 <300ms（Mac 实测 66ms 量级），对输入法进程完全可用。需验证 .bin 跨平台兼容（同为小端，理论可移植；保底方案=首启后台编译一次）。
5. **总集成工作量预估（引擎层）**：NDK 编译 + JNI + Kotlin API + 词库打包 ≈ **2–3 周单人**，不含键盘 UI。

## 4. 云拼音增强路径

- 主流做法：端侧引擎即时出基础候选（0 延迟），异步请求云候选，返回后**合并进候选栏第 2–4 位**（搜狗/百度手机输入法同款体验）。fcitx-cloudpinyin 即此模式。
- 实测：Google Input Tools API（`inputtools.google.com/request?text=…&itc=zh-t-i0-pinyin`）对 `xianwaixiaomao` 返回「限外小猫」——**该 API 国内不可达，不能直接用**；应自建。
- 接入点：**自研 UI 的候选栏层**（不进 librime）。按键→librime 同步出候选立即显示；同时防抖 (~150ms) 异步请求云端，回包后若用户未翻页/未提交则插入云候选（带云标记）。
- 后端接口（一句话）：`POST /pinyin/convert {pinyin: "xianwaixiaomao", context: "前文"} → {candidates: [{text, score}]}`，由主干另派后端实现（可用大词库+LLM rerank）。

## 5. 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 词库/essay 为 LGPL-3.0 数据文件 | 低 | 独立文件打包+许可证声明+上游链接；上架文案不声称词库自有；后续可换自建词库 |
| 误抄 GPL 代码（Trime JNI / rime-ice schema） | 中 | 红线制度：JNI 与 T9 schema 全自写（本 PoC 已产出自写 T9 原型可直接演化） |
| 预编译 .bin 跨设备兼容未验真机 | 中 | 阶段1 首件事：真机验证；保底=首启后台编译（10–30s 一次性） |
| 默认无模糊音/纠错 | 低 | schema 开启 luna 自带 abbreviation/spelling_correction，或加 derive 规则 |
| 联想（下一词预测）rime 不内置 | 低 | 候选栏层做：云候选 / 用户词库 bigram |
| librime 上游维护 | 低 | 活跃（1.17.0, 2025+ 仍更新），BSD 允许自持分支 |

## 6. PoC 复现材料

- 测试代码已归档：`WordTaker/docs/android-poc/poc-src/`（poc.c 整句/性能、poc2.c 简体、poc3.c 造词学习、t9.c 九键、t9_poc.schema.yaml 自写 T9 原型——可直接作为阶段1 起点）
- 复现：`brew install librime`；数据取 rime-luna-pinyin + rime-essay + rime-prelude 置于 shared/；`clang -I/opt/homebrew/include -L/opt/homebrew/lib -lrime poc.c -o poc && ./poc`
