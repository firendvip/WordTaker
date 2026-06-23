#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FunASR模型服务器
保持模型在内存中，通过stdin/stdout进行通信
"""

import sys
import json
import os
import time
import logging
import traceback
import signal
import contextlib
import io
import argparse
import glob
import threading
from pathlib import Path

# 设置日志
import tempfile
import os


# 获取日志文件路径
def get_log_path():
    # 尝试从环境变量获取用户数据目录
    if "ELECTRON_USER_DATA" in os.environ:
        log_dir = os.path.join(os.environ["ELECTRON_USER_DATA"], "logs")
    else:
        # 回退到临时目录
        log_dir = os.path.join(tempfile.gettempdir(), "wordtaker_logs")

    # 确保日志目录存在
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, "funasr_server.log")


log_file_path = get_log_path()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(log_file_path, encoding="utf-8"),
        logging.StreamHandler(),  # 同时输出到控制台
    ],
)
logger = logging.getLogger(__name__)

# 记录日志文件位置
logger.info(f"FunASR服务器日志文件: {log_file_path}")


@contextlib.contextmanager
def suppress_stdout():
    """上下文管理器：临时重定向stdout到devnull，避免FunASR库的非JSON输出干扰IPC通信"""
    old_stdout = sys.stdout
    devnull = open(os.devnull, "w")
    try:
        sys.stdout = devnull
        yield
    finally:
        sys.stdout = old_stdout
        devnull.close()


class FunASRServer:
    def __init__(self, damo_root=None):
        self.asr_model = None
        self.vad_model = None
        self.punc_model = None
        self.sensevoice_model = None   # 快速识别引擎（ONNX）
        self.sensevoice_tokens = None
        self.initialized = False
        self._init_lock = threading.Lock()  # 防止并发初始化导致重复加载模型
        self.running = True
        self.transcription_count = 0
        self.total_audio_duration = 0.0

        # 外部传入的 damo 根目录（例如 /Volumes/APFS/AI/models/damo）
        self.damo_root = damo_root or os.environ.get("DAMO_ROOT")

        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)
        self._setup_runtime_environment()

    def _setup_runtime_environment(self):
        """设置运行时环境变量以优化性能"""
        try:
            import os

            # 设置线程数优化
            os.environ["OMP_NUM_THREADS"] = "4"
            logger.info("运行时环境变量设置完成")
        except Exception as e:
            logger.warning(f"环境设置失败: {str(e)}")

    def _signal_handler(self, signum, frame):
        """处理退出信号"""
        logger.info(f"收到信号 {signum}，准备退出...")
        self.running = False

    def _load_asr_model(self):
        """加载ASR模型"""
        try:
            logger.info("开始加载ASR模型...")
            with suppress_stdout():
                from funasr import AutoModel

                self.asr_model = AutoModel(
                    model="damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                    model_revision="v2.0.4",
                    disable_update=True,
                    device="cpu",
                )
            logger.info("ASR模型加载完成")
            return True
        except Exception as e:
            logger.error(f"ASR模型加载失败: {str(e)}")
            return False

    def _load_sensevoice(self):
        """加载 SenseVoice ONNX（快速识别引擎，自带标点/ITN）。失败则保持 None，自动回退 Paraformer。"""
        try:
            import json as _json
            model_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "models", "sensevoice"
            )
            if not os.path.exists(os.path.join(model_dir, "model_quant.onnx")):
                logger.warning("未找到 SenseVoice ONNX 模型，跳过（将回退 Paraformer）")
                return False
            logger.info("开始加载 SenseVoice ONNX 模型...")
            from funasr_onnx import SenseVoiceSmall

            with open(os.path.join(model_dir, "tokens.json"), "r", encoding="utf-8") as f:
                self.sensevoice_tokens = _json.load(f)
            self.sensevoice_model = SenseVoiceSmall(
                model_dir, batch_size=1, quantize=True, device_id="-1"
            )
            logger.info("SenseVoice ONNX 模型加载完成")
            return True
        except Exception as e:
            logger.error(f"SenseVoice 加载失败（将回退 Paraformer）: {str(e)}")
            self.sensevoice_model = None
            return False

    def _decode_sensevoice(self, token_ids):
        """把 SenseVoice 输出的 token id 解码成纯文本，剥离 <...> 标记。"""
        toks = self.sensevoice_tokens or []
        out = []
        for tid in token_ids:
            if 0 <= tid < len(toks):
                t = toks[tid]
                if t.startswith("<") and t.endswith(">"):
                    continue
                out.append(t)
        text = "".join(out).replace("▁", " ").strip()
        while text and text[-1] in "。.":
            text = text[:-1]
        return text

    def _load_vad_model(self):
        """加载VAD模型"""
        try:
            logger.info("开始加载VAD模型...")
            with suppress_stdout():
                from funasr import AutoModel

                self.vad_model = AutoModel(
                    model="damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
                    model_revision="v2.0.4",
                    disable_update=True,
                    device="cpu",
                )
            logger.info("VAD模型加载完成")
            return True
        except Exception as e:
            logger.error(f"VAD模型加载失败: {str(e)}")
            return False

    def _load_punc_model(self):
        """加载标点恢复模型"""
        try:
            import time

            start_time = time.time()
            logger.info("开始加载标点恢复模型...")

            # 记录导入时间
            import_start = time.time()
            with suppress_stdout():
                from funasr import AutoModel
            import_time = time.time() - import_start
            logger.info(f"FunASR导入耗时: {import_time:.2f}秒")

            # 记录模型创建时间
            model_start = time.time()
            with suppress_stdout():
                self.punc_model = AutoModel(
                    model="damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
                    model_revision="v2.0.4",
                    disable_update=True,
                    device="cpu",
                )
            model_time = time.time() - model_start
            total_time = time.time() - start_time

            logger.info(
                f"标点恢复模型加载完成 - 模型创建耗时: {model_time:.2f}秒, 总耗时: {total_time:.2f}秒"
            )
            return True
        except Exception as e:
            logger.error(f"标点恢复模型加载失败: {str(e)}")
            return False

    def initialize(self):
        """并行初始化FunASR模型"""
        # 用锁保护 initialized 检查与赋值，避免两个调用方同时进入并重复加载模型。
        # 锁内做 double-check：等到锁的第二个调用方直接返回已初始化结果。
        with self._init_lock:
            if self.initialized:
                return {"success": True, "message": "模型已初始化"}
            return self._initialize_locked()

    def _initialize_locked(self):
        """在持有 _init_lock 的前提下执行实际的并行初始化。"""
        try:
            import time

            logger.info("正在并行初始化FunASR模型...")
            start_time = time.time()

            # 创建加载结果存储
            results = {}

            def load_model_thread(model_name, load_func):
                """模型加载线程包装函数"""
                thread_start = time.time()
                results[model_name] = load_func()
                thread_time = time.time() - thread_start
                logger.info(f"{model_name}模型加载线程耗时: {thread_time:.2f}秒")

            # 创建并启动三个并行线程
            # daemon=True：即使加载线程超时仍卡在原生调用里，也不会阻塞进程退出，避免僵尸线程累积。
            threads = [
                threading.Thread(
                    target=load_model_thread, args=("asr", self._load_asr_model),
                    daemon=True,
                ),
                threading.Thread(
                    target=load_model_thread, args=("vad", self._load_vad_model),
                    daemon=True,
                ),
                threading.Thread(
                    target=load_model_thread, args=("punc", self._load_punc_model),
                    daemon=True,
                ),
            ]

            # 启动所有线程
            for thread in threads:
                thread.start()

            # 等待所有线程完成，设置超时
            for thread in threads:
                thread.join(timeout=300)  # 5分钟超时
                if thread.is_alive():
                    # 线程为 daemon，超时后不再 join；它不会阻止进程退出，避免线程泄漏累积
                    logger.error("模型加载线程超时（已放弃等待，daemon 线程不会阻塞退出）")
                    return {
                        "success": False,
                        "error": "模型加载超时",
                        "type": "timeout_error",
                    }

            # 检查加载结果
            failed_models = [name for name, success in results.items() if not success]

            if failed_models:
                error_msg = f"以下模型加载失败: {', '.join(failed_models)}"
                logger.error(error_msg)
                return {"success": False, "error": error_msg, "type": "init_error"}

            total_time = time.time() - start_time
            self.initialized = True
            logger.info(
                f"所有FunASR模型并行初始化完成，总耗时: {total_time:.2f}秒"
            )
            # 加载快速识别引擎 SenseVoice（可选，失败自动回退 Paraformer）
            self._load_sensevoice()
            # 预热，避免首次真实识别的冷启动延迟
            self._warmup()
            return {
                "success": True,
                "message": f"FunASR模型并行初始化成功，耗时: {total_time:.2f}秒",
            }

        except ImportError as e:
            error_msg = "FunASR未安装，请先安装FunASR: pip install funasr"
            logger.error(error_msg)
            return {"success": False, "error": error_msg, "type": "import_error"}

        except Exception as e:
            error_msg = f"FunASR模型初始化失败: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "init_error"}

    def _warmup(self):
        """用极短静音预热 ASR/标点模型，避免首次真实识别的冷启动延迟"""
        try:
            import tempfile, wave, struct
            t0 = time.time()
            path = os.path.join(tempfile.gettempdir(), "wordtaker_warmup.wav")
            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(16000)
                w.writeframes(struct.pack("<" + "h" * 1600, *([0] * 1600)))  # 0.1s 静音
            if self.asr_model:
                self.asr_model.generate(input=path, batch_size_s=60, cache={}, disable_pbar=True)
            if self.punc_model:
                self.punc_model.generate(input="你好")
            if self.sensevoice_model:
                # SenseVoice ONNX 首次推理冷启动较久（~7s），预热吸收掉
                try:
                    self.sensevoice_model([path], language=[0], textnorm=[14])
                except Exception as e:
                    logger.warning(f"SenseVoice 预热跳过: {str(e)}")
            logger.info(f"模型预热完成，耗时: {time.time() - t0:.2f}秒")
        except Exception as e:
            logger.warning(f"模型预热跳过: {str(e)}")

    def transcribe_audio(self, audio_path, options=None):
        """转录音频文件"""
        if not self.initialized:
            init_result = self.initialize()
            if not init_result["success"]:
                return init_result

        try:
            # 校验 audio_path：必须是非空字符串且文件存在，避免 None 传入 os.path.exists 抛 TypeError
            if not isinstance(audio_path, str) or not audio_path:
                return {"success": False, "error": "缺少有效的 audio_path"}
            if not os.path.exists(audio_path):
                return {"success": False, "error": f"音频文件不存在: {audio_path}"}

            logger.info(f"开始转录音频文件: {audio_path}")

            # 设置默认选项
            # 注意：原实现每次都额外跑一遍 VAD 模型，但其结果从未被使用（纯浪费一次推理）。
            # Paraformer 已能处理整段音频，这里默认关闭独立 VAD 以显著提速。
            default_options = {
                "batch_size_s": 60,
                "hotword": "",
                "use_vad": False,
                "use_punc": True,  # 使用FunASR自带的标点恢复
                "language": "zh",
                "engine": "sensevoice",  # 识别引擎：sensevoice(快) / paraformer(稳)
            }

            if options:
                default_options.update(options)

            # —— 引擎选择：默认 SenseVoice（快），不可用时自动回退 Paraformer ——
            engine = default_options.get("engine", "sensevoice")
            if engine == "sensevoice" and self.sensevoice_model is not None:
                _sv_t0 = time.time()
                sv_res = self.sensevoice_model(
                    [audio_path], language=[0], textnorm=[14]
                )
                logger.info(f"[计时] SenseVoice识别耗时: {time.time() - _sv_t0:.2f}秒")
                raw_text = self._decode_sensevoice(sv_res[0]) if sv_res else ""
                duration = self._get_audio_duration(audio_path)
                self.transcription_count += 1
                logger.info(f"转录完成(SenseVoice)，文本长度: {len(raw_text)}字")
                return {
                    "success": True,
                    "text": raw_text,        # SenseVoice 自带标点/ITN
                    "raw_text": raw_text,
                    "confidence": 0.0,
                    "duration": duration,
                    "language": "zh-CN",
                    "model_type": "sensevoice-onnx",
                }

            # —— 否则走 Paraformer + 标点 ——
            # 可选的独立 VAD（默认关闭；其输出当前不参与 ASR，仅为兼容保留）
            if default_options["use_vad"] and self.vad_model:
                self.vad_model.generate(
                    input=audio_path, batch_size_s=default_options["batch_size_s"]
                )
                logger.info("VAD处理完成")

            # 执行ASR识别（关闭进度条，减少开销）
            _asr_t0 = time.time()
            asr_result = self.asr_model.generate(
                input=audio_path,
                batch_size_s=default_options["batch_size_s"],
                hotword=default_options["hotword"],
                cache={},
                disable_pbar=True,
            )
            logger.info(f"[计时] ASR识别耗时: {time.time() - _asr_t0:.2f}秒")

            # 提取识别文本
            if isinstance(asr_result, list) and len(asr_result) > 0:
                if isinstance(asr_result[0], dict) and "text" in asr_result[0]:
                    raw_text = asr_result[0]["text"]
                else:
                    raw_text = str(asr_result[0])
            else:
                raw_text = str(asr_result)

            logger.info(f"ASR识别完成，文本长度: {len(raw_text)}字")

            # 使用FunASR进行标点恢复
            final_text = raw_text
            if default_options["use_punc"] and self.punc_model and raw_text.strip():
                try:
                    _punc_t0 = time.time()
                    punc_result = self.punc_model.generate(input=raw_text)
                    logger.info(f"[计时] 标点恢复耗时: {time.time() - _punc_t0:.2f}秒")
                    if isinstance(punc_result, list) and len(punc_result) > 0:
                        if (
                            isinstance(punc_result[0], dict)
                            and "text" in punc_result[0]
                        ):
                            final_text = punc_result[0]["text"]
                        else:
                            final_text = str(punc_result[0])
                    logger.info("FunASR标点恢复完成")
                except Exception as e:
                    logger.warning(f"FunASR标点恢复失败，使用原始文本: {str(e)}")

            duration = self._get_audio_duration(audio_path)
            self.transcription_count += 1

            result = {
                "success": True,
                "text": final_text,
                "raw_text": raw_text,
                "confidence": (
                    getattr(asr_result[0], "confidence", 0.0)
                    if isinstance(asr_result, list)
                    else 0.0
                ),
                "duration": duration,
                "language": "zh-CN",
                "model_type": "pytorch",  # 标识使用的是pytorch版本
            }

            # 生产环境：每10次转录后进行内存清理
            if self.transcription_count % 10 == 0:
                self._cleanup_memory()
                logger.info(f"已完成 {self.transcription_count} 次转录，执行内存清理")

            logger.info(f"转录完成，文本长度: {len(final_text)}字")
            return result

        except Exception as e:
            error_msg = f"音频转录失败: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "transcription_error"}

    def _get_audio_duration(self, audio_path):
        """获取音频时长"""
        try:
            import librosa
        except ImportError as e:
            # 缺少 librosa 是配置层面的严重问题，按 ERROR 暴露而非静默返回 0.0
            logger.error(f"librosa 未安装，无法计算音频时长: {str(e)}")
            return 0.0

        try:
            # librosa 0.11.0 移除了 filename= 关键字，使用 path=
            duration = librosa.get_duration(path=audio_path)
            self.total_audio_duration += duration  # 累计音频时长
            return duration
        except Exception as e:
            logger.warning(f"获取音频时长失败({audio_path}): {str(e)}")
            return 0.0

    def _cleanup_memory(self):
        """生产环境内存清理"""
        try:
            import gc

            gc.collect()
            logger.info("内存清理完成")
        except Exception as e:
            logger.warning(f"内存清理失败: {str(e)}")

    def get_performance_stats(self):
        """获取性能统计信息"""
        return {
            "transcription_count": self.transcription_count,
            "total_audio_duration": round(self.total_audio_duration, 2),
            "average_duration": round(
                self.total_audio_duration / max(1, self.transcription_count), 2
            ),
            "initialized": self.initialized,
            "models_loaded": {
                "asr": self.asr_model is not None,
                "vad": self.vad_model is not None,
                "punc": self.punc_model is not None,
            },
        }

    def check_status(self):
        """检查FunASR状态"""
        try:
            import funasr

            return {
                "success": True,
                "installed": True,
                "initialized": self.initialized,
                "version": getattr(funasr, "__version__", "unknown"),
                "models": {
                    "asr": self.asr_model is not None,
                    "vad": self.vad_model is not None,
                    "punc": self.punc_model is not None,  # FunASR标点恢复模型状态
                },
            }
        except ImportError:
            return {
                "success": False,
                "installed": False,
                "initialized": False,
                "error": "FunASR未安装",
            }

    def run(self):
        """运行服务器主循环"""
        logger.info("FunASR服务器启动")

        # 解析 damo 根目录
        def _default_damo_root():
            # 允许通过 MODELSCOPE_CACHE 指定根；常见是 ~/.cache/modelscope/hub/damo
            root = os.environ.get("MODELSCOPE_CACHE")
            if root:
                # 兼容两种布局：<cache>/damo 或 <cache>/hub/damo
                if os.path.isdir(os.path.join(root, "damo")):
                    return os.path.join(root, "damo")
                if os.path.isdir(os.path.join(root, "hub", "damo")):
                    return os.path.join(root, "hub", "damo")
                # 像 Node 一样自定义到 /Volumes/APFS/AI/models/damo，就直接传入 --damo-root
            # 默认回到用户主目录的 modelscope/hub/damo
            home_dir = os.path.expanduser("~")
            return os.path.join(home_dir, ".cache", "modelscope", "hub", "damo")

        cache_path = self.damo_root if self.damo_root else _default_damo_root()
        logger.info(f"使用的模型根目录(damo root): {cache_path}")

        repos = [
            "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            "speech_fsmn_vad_zh-cn-16k-common-pytorch",
            "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        ]

        def _repo_ready(repo_dir):
            # 目录存在且包含任意常见权重/配置文件即认为已就绪
            if not os.path.isdir(repo_dir):
                return False
            patterns = [
                "model.pt", "pytorch_model.bin", "*.onnx",
                "config.json", "configuration.json", "model.yaml", "vocab*"
            ]
            for pat in patterns:
                if glob.glob(os.path.join(repo_dir, pat)):
                    return True
            return False

        missing = []
        for r in repos:
            rd = os.path.join(cache_path, r)
            if not _repo_ready(rd):
                missing.append(r)

        if not missing:
            logger.info("模型文件存在，开始初始化")
            init_result = self.initialize()
        else:
            logger.info(f"模型文件不存在或不完整：{', '.join(missing)}，跳过初始化")
            init_result = {
                "success": False,
                "error": "模型文件未下载，请先下载模型",
                "type": "models_not_downloaded"
            }
        print(json.dumps(init_result, ensure_ascii=False))
        sys.stdout.flush()

        while self.running:
            try:
                # 读取命令
                line = sys.stdin.readline()
                if not line:
                    break

                line = line.strip()
                if not line:
                    continue

                try:
                    command = json.loads(line)
                except json.JSONDecodeError:
                    result = {"success": False, "error": "无效的JSON命令"}
                    print(json.dumps(result, ensure_ascii=False))
                    sys.stdout.flush()
                    continue

                # 命令关联 id（可选）：用于让客户端把响应匹配回对应命令，
                # 防止迟到/超时的响应被错误地当成下一条命令的结果。
                cmd_id = command.get("id")

                # 处理命令
                if command.get("action") == "transcribe":
                    audio_path = command.get("audio_path")
                    options = command.get("options", {})
                    if not audio_path:
                        result = {"success": False, "error": "缺少有效的 audio_path"}
                    else:
                        result = self.transcribe_audio(audio_path, options)
                elif command.get("action") == "status":
                    result = self.check_status()
                elif command.get("action") == "stats":
                    result = {"success": True, "stats": self.get_performance_stats()}
                elif command.get("action") == "cleanup":
                    self._cleanup_memory()
                    result = {"success": True, "message": "内存清理完成"}
                elif command.get("action") == "exit":
                    result = {"success": True, "message": "服务器退出"}
                    if cmd_id is not None:
                        result["id"] = cmd_id
                    print(json.dumps(result, ensure_ascii=False))
                    sys.stdout.flush()
                    break
                else:
                    result = {
                        "success": False,
                        "error": f"未知命令: {command.get('action')}",
                    }

                # 回显命令 id（若提供）
                if cmd_id is not None and isinstance(result, dict):
                    result["id"] = cmd_id

                # 输出结果
                print(json.dumps(result, ensure_ascii=False))
                sys.stdout.flush()

            except KeyboardInterrupt:
                break
            except Exception as e:
                error_result = {
                    "success": False,
                    "error": str(e),
                    "traceback": traceback.format_exc(),
                }
                print(json.dumps(error_result, ensure_ascii=False))
                sys.stdout.flush()

        logger.info("FunASR服务器退出")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--damo-root", type=str, default=None,
                        help="damo 模型根目录，例如 /Volumes/APFS/AI/models/damo")
    args = parser.parse_args()

    server = FunASRServer(damo_root=args.damo_root)
    server.run()