#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SecureChat 语音转文字（faster-whisper 后端）

由 server/index.js 的 runStt() 调用：python stt_whisper.py <音频文件路径>
标准输出打印识别文本；失败时向 stderr 输出原因并以非 0 退出。

首次使用会自动下载模型（tiny/base/small，由 STT_WHISPER_MODEL 环境变量选择）。
"""
import os
import sys

# Windows 控制台默认 GBK，强制 stdout/stderr 用 UTF-8，否则中文识别结果会乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# HuggingFace 直连不通，使用国内镜像
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


def main():
    if len(sys.argv) < 2:
        print("usage: stt_whisper.py <audio_file>", file=sys.stderr)
        return 2

    audio = sys.argv[1]
    if not os.path.exists(audio):
        print("audio file not found: %s" % audio, file=sys.stderr)
        return 2

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper not installed. pip install faster-whisper", file=sys.stderr)
        return 3

    # 模型大小：tiny(最快) / base / small(更准)。中文建议 base 起步。
    size = os.environ.get("STT_WHISPER_MODEL", "base")
    try:
        model = WhisperModel(size, device="cpu", compute_type="int8")
    except Exception as e:  # noqa: BLE001
        print("failed to load model '%s': %s" % (size, e), file=sys.stderr)
        return 4

    language = os.environ.get("STT_WHISPER_LANG", "zh")
    try:
        segments, info = model.transcribe(
            audio,
            language=None if language in ("auto", "") else language,
            vad_filter=True,          # 跳过静音段，显著提速并减少幻觉
            beam_size=1,              # 实时性优先
        )
        text = "".join(seg.text for seg in segments).strip()
    except Exception as e:  # noqa: BLE001
        print("transcribe failed: %s" % e, file=sys.stderr)
        return 5

    if not text:
        print("EMPTY", file=sys.stderr)
        return 6

    # Whisper 对普通话常输出繁体，统一转简体（装了 opencc 才转，没装则原样返回）
    try:
        from opencc import OpenCC
        text = OpenCC("t2s").convert(text)
    except Exception:
        pass

    sys.stdout.write(text)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())