# 测试用例：本地大模型长文润色（方案 A+D）

- **文档日期**：2026-07-03
- **被测改动**：本地 LLM 长文润色修复（方案 A + 方案 D）
  - `llm_server.py`：`n_ctx` 4096→8192；输出上限从写死 2048 改为自适应 `n_ctx − prompt_tokens − 128`（去掉死顶）；润色前算 prompt token，若 `prompt_tokens + 256 > n_ctx` 则不硬跑，直接返回 `{success:false, reason:"input_too_long", message:"内容过长"}`。
  - 主进程（`aiService` / `ipcHandlers` / `useRecording`）：透传 `reason`；本地失败且 `reason==='input_too_long'` → 贴原文 + 系统通知「内容过长，本地模型无法处理，建议改用云端AI」；其它本地失败仍「润色失败，已贴出原文」。**引擎互不兜底**（本地失败绝不自动转云端）。
- **触发本 bug 的真实数据**：历史 ID 2953，本地 4B、2609 字长篇 Markdown 学习计划，之前被截断 / 出问题。

## 被测范围

| 层 | 范围 |
|---|---|
| Python 润色层 | `llm_server.py` 的 `n_ctx`、自适应输出上限、`input_too_long` 提前拦截、stdin/stdout JSON 协议 |
| 主进程透传 | `aiService` 对 `reason` 的透传、`ipcHandlers`、`useRecording` 的失败分支与系统通知文案 |
| 引擎隔离 | 本地失败绝不自动转云端；云端引擎独立可用 |

## 前置条件（所有用例通用）

1. 本地 4B GGUF 模型已下载在 `userData/models`（如 `~/Library/Application Support/WordTaker/models/…4B….gguf`），可被 `llmManager` 解析到真实路径。
2. `llama_cpp` 已随内嵌 CPython 安装、可 `import`。
3. **端到端用例**：运行中的 Electron App（dev 或打包版），设置 → AI 引擎切到「本地模型」，模型初始化成功（`{"success":true}`）。
4. **自动化用例**：可直接 spawn `llm_server.py`（见文末「可自动化执行方式」），无需麦克风。
5. 网络：端到端云端回归用例需可访问云端 AI 接口。

## 优先级说明

- **P0**：核心场景，必须通过，阻塞发版。
- **P1**：重要场景，应通过。
- **P2**：边界 / 增强，尽量通过。

---

## 用例清单

### TC-01 短句本地润色正常（口语→书面语）
- **优先级**：P1
- **类型**：正向
- **前置**：引擎=本地模型，模型已加载。
- **步骤**：
  1. 录音说一句带口头禅的口语，如「嗯那个我我觉得就是这个方案还行吧」。
  2. 结束录音，等待本地润色完成。
- **预期结果**：
  - 输出为通顺书面中文（去掉「嗯/那个」、合并「我我」、补标点），如「我觉得这个方案还行。」
  - 无 `<think>` 残留、无乱码、无引号/前后缀。
  - 协议上收到 `{"d":…}` 增量帧 + 末帧 `{"done":true,"text":…,"id":…}`。

### TC-02 【核心】2609 字长文本地润色（ID2953 同类内容）
- **优先级**：P0
- **类型**：正向（回归 ID2953）
- **前置**：引擎=本地模型，模型已加载，`--n-ctx 8192`。
- **测试数据**：约 2609 字的长篇 Markdown 学习计划（与历史 ID2953 同量级、同结构：多级标题 + 列表 + 段落）。
- **步骤**：
  1. 通过录音或自动化直接送入该 2609 字文本执行 `polish`。
  2. 等待润色完成，检查完整输出。
- **预期结果**：
  - **完整润色**：输出覆盖全文，不在中途截断（对比输入首尾要点，结尾段落存在）。
  - **不乱码**：无重复循环、无 `<think>`、无非预期符号堆叠。
  - **不再原样吐回**：输出是润色结果而非把原文一字不差回显（此前 bug 表现）。
  - 末帧为 `{"done":true,"text":<完整全文>,"id":…}`，`success` 分支未被触发。
  - 主进程：不弹「内容过长」通知，正常贴出润色结果。

### TC-03 边界：接近 8192 上下文但装得下的长文
- **优先级**：P1
- **类型**：边界
- **前置**：引擎=本地模型，`--n-ctx 8192`。
- **测试数据**：构造使 `prompt_tokens` 逼近但不超过阈值的文本，满足 `prompt_tokens + 256 ≤ 8192`（即 `prompt_tokens` 约 ≤ 7936）。可取约 6000–7000 字中文（含 SYSTEM_PROMPT 一起 tokenize）。
- **步骤**：
  1. 送入该文本执行 `polish`。
- **预期结果**：
  - 正常润色，**不触发** `input_too_long`。
  - 自适应输出上限 `adaptive_max = 8192 − prompt_tokens − 128` 生效（此时较小），输出不因死顶 2048 被截。
  - 末帧 `{"done":true,"text":…}`；输出非空。

### TC-04 【核心】超长文本触发 input_too_long
- **优先级**：P0
- **类型**：异常
- **前置**：引擎=本地模型，`--n-ctx 8192`。
- **测试数据**：超长中文文本，使 `prompt_tokens + 256 > 8192`（即 `prompt_tokens > 7936`），约 7000+ 字（保守可用 8000–10000 字确保越界）。
- **步骤**：
  1. 送入该超长文本执行 `polish`。
  2. 观察 Python 响应与主进程 App 行为。
- **预期结果**：
  - **Python 层**：不做推理，立即返回单条
    `{"success":false, "reason":"input_too_long", "message":"内容过长", "error":"内容过长，本地模型无法处理", "id":<回显>}`；**无任何 `{"d":…}` 增量帧、无 `{"done":true}`**。
  - **主进程 / App**：
    - 贴出**原文**（未润色）。
    - 弹系统通知，文案含「内容过长，本地模型无法处理，建议改用云端AI」。
    - **不自动转云端**（不发起任何云端润色请求）。

### TC-05 回归：云端 AI 对同样长文仍正常
- **优先级**：P1
- **类型**：回归
- **前置**：引擎=**云端 AI**；网络可用。
- **测试数据**：TC-04 用的同一超长文本 + TC-02 的 2609 字长文。
- **步骤**：
  1. 引擎切云端 AI，分别送入两段文本润色。
- **预期结果**：
  - 云端正常返回润色结果，不受本地 `n_ctx` / `input_too_long` 逻辑影响。
  - 无「内容过长，本地模型无法处理」这类本地文案。

### TC-06 回归：本地其它失败仍提示「润色失败，已贴出原文」
- **优先级**：P1
- **类型**：回归
- **前置**：引擎=本地模型。
- **步骤**（任选一种制造非 input_too_long 的本地失败）：
  1. 送入合法长度文本，但模型未加载 / 触发推理异常（如模型文件被临时移走后 ping，或注入使 `create_chat_completion` 抛异常的条件）；或直接构造 Python 返回 `{"success":false,"error":"推理异常:…"}` / `{"success":false,"error":"润色结果为空"}`。
- **预期结果**：
  - Python 返回的失败**不带** `reason:"input_too_long"`。
  - 主进程走通用失败分支：贴出原文 + 提示「润色失败，已贴出原文」（**不是**「内容过长」文案）。
  - 不自动转云端。

### TC-07 回归：默认引擎仍是云端 AI
- **优先级**：P1
- **类型**：回归
- **前置**：全新配置 / 首次启动（无用户已选引擎）。
- **步骤**：
  1. 全新启动 App，查看设置 → AI 引擎默认值；不切换直接录音润色。
- **预期结果**：
  - 默认引擎为**云端 AI**（本次改动不得把默认改成本地）。
  - 默认路径走云端润色。

### TC-08 空文本 / 无有效文本
- **优先级**：P2
- **类型**：异常
- **前置**：引擎=本地模型，模型已加载。
- **步骤**：
  1. 送入空串或纯空白执行 `polish`。
- **预期结果**：
  - Python 返回 `{"success":false,"error":"无有效文本","id":…}`。
  - 主进程按通用失败处理，不弹「内容过长」，不转云端。

### TC-09 阈值临界点（恰好边界）
- **优先级**：P2
- **类型**：边界
- **前置**：引擎=本地模型，`--n-ctx 8192`。
- **测试数据**：两段文本，分别使 `prompt_tokens + 256` 恰好 `== 8192`（应通过：`>` 才拦截）与 `== 8193`（应拦截）。
- **步骤**：
  1. 先测 `==8192` 的文本 → 期望**正常润色**（不拦截）。
  2. 再测 `==8193` 的文本 → 期望 `input_too_long`。
- **预期结果**：
  - 判定与源码条件 `prompt_tokens + MIN_OUTPUT_TOKENS > n_ctx`（`MIN_OUTPUT_TOKENS=256`）一致：等于不拦截，大于才拦截。

### TC-10 长文输出不因旧 2048 死顶被截（方案 A 专项）
- **优先级**：P1
- **类型**：回归（专项）
- **前置**：引擎=本地模型，`--n-ctx 8192`。
- **测试数据**：预期润色后正文 token 数明显 > 2048 的输入（如 TC-02 的 2609 字长文，其规范化输出通常 > 2048 token）。
- **步骤**：
  1. 送入执行 `polish`，统计输出 token / 字数。
- **预期结果**：
  - 输出长度可超过旧死顶 2048 token（证明自适应上限生效），结尾完整，非在 2048 附近硬截。

---

## 可自动化执行方式（不经麦克风，直接验证本地润色层）

用于自动化验证 **TC-02 / TC-03 / TC-04（及 TC-08/TC-09/TC-10）**：像主进程那样直接 spawn `llm_server.py`，按行发 JSON、读 JSON 响应，绕开录音与 ASR。

### 启动进程

```bash
# 真实 4B 模型路径示例（以实际 userData/models 下的 GGUF 为准）
MODEL="$HOME/Library/Application Support/WordTaker/models/<真实4B模型>.gguf"
# 用内嵌/项目 CPython 启动，与主进程一致：n-ctx 必须 8192
python3 "/Users/Admin/Documents/CC All Project/CAT MAC/WordTaker/llm_server.py" \
  --model "$MODEL" --n-ctx 8192
```

- 进程启动后**先输出一行初始化响应**：成功 `{"success": true, "message": "LLM 模型加载成功", "model_path": "..."}`；失败 `{"success": false, "error": "...", "type": "..."}`。执行前先读这一行确认加载成功。

### 通信协议（stdin 发 / stdout 读，一行一个 JSON）

**请求（写入 stdin，每条一行）**：
```json
{"action": "polish", "text": "<待润色文本>", "mode": "normal", "id": "tc02-1"}
```
字段：
- `action`：`"polish"`（润色）/ `"ping"`（探活，返回 `{"success":true,"ready":bool,"id":…}`）/ `"exit"`（退出）。
- `text`：待润色原文（字符串）。
- `mode`：`"normal"`（默认；本次不区分思考模式，固定 `/no_think`）。
- `id`：本次请求 ID，响应会回显，用于对齐。

**响应（从 stdout 逐行读，直到出现终止帧）**：
- 增量帧（0 到多条）：`{"d": "<delta 片段>"}`（注意：增量帧**不带** `id`）。
- 成功终止帧：`{"done": true, "text": "<润色全文>", "id": "<回显>"}`。
- 失败终止帧：`{"success": false, "error": "...", "id": "<回显>", ...}`；超长时额外带 `"reason": "input_too_long"` 与 `"message": "内容过长"`。

### 各用例断言要点

- **TC-02（2609 字）**：拼出增量帧的 `d` + 终止帧 `text`，断言收到 `{"done":true}`、`text` 覆盖全文首尾要点、无 `input_too_long`、无 `<think>`、非原样回显。
- **TC-03（接近 8192 装得下）**：断言收到 `{"done":true}`、`text` 非空、无 `input_too_long`。
- **TC-04（超长 7000+ 字）**：断言**只**收到一条 `{"success":false,"reason":"input_too_long","message":"内容过长",...}`，且**无任何** `{"d":…}` 与 `{"done":true}`。

### 参考执行脚本骨架（供执行 agent 照做）

```python
import json, subprocess, sys

MODEL = "/Users/Admin/Library/Application Support/WordTaker/models/<真实4B模型>.gguf"
proc = subprocess.Popen(
    [sys.executable,
     "/Users/Admin/Documents/CC All Project/CAT MAC/WordTaker/llm_server.py",
     "--model", MODEL, "--n-ctx", "8192"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    text=True, encoding="utf-8", bufsize=1,
)

# 1) 读初始化响应
init = json.loads(proc.stdout.readline())
assert init.get("success") is True, init

def polish(text, cid):
    proc.stdin.write(json.dumps({"action": "polish", "text": text,
                                 "mode": "normal", "id": cid},
                                ensure_ascii=False) + "\n")
    proc.stdin.flush()
    deltas, final = [], None
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        msg = json.loads(line)
        if "d" in msg:
            deltas.append(msg["d"])
        elif msg.get("done"):
            final = msg          # 成功终止
            break
        elif "success" in msg and msg["success"] is False:
            final = msg          # 失败终止（含 input_too_long）
            break
    return deltas, final

# TC-04 断言示例：超长文本应只返回 input_too_long，无增量
deltas, final = polish(LONG_TEXT_7000, "tc04")
assert deltas == [] and final and final.get("reason") == "input_too_long"

# 退出
proc.stdin.write(json.dumps({"action": "exit", "id": "bye"}) + "\n")
proc.stdin.flush()
```

> 执行 agent 注意：`text=True` + 逐行 `readline()` 即可对齐「一行一个 JSON」协议；模型路径以实际 `userData/models` 下 4B GGUF 为准（可先用 `ping` 或初始化响应确认加载成功）。
