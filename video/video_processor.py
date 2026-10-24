"""本地媒体 → 文字（2026-10-24 重构）。

**只做转写，不再抽帧。**
抽帧这条线已经改由线上完成（B 站故事板 + 远程 seek），本地再留一套 opencv
抽帧既重复又吃 113 MB 依赖，所以砍掉。

输入可以是音频也可以是视频——视频会由 faster-whisper 自己读音轨。
输出 JSON 契约保持不变（`images` 恒为空数组），免得调用方跟着改。

约定：stdout 不解析，结果只看 --output 那个文件。
"""

import argparse
import json
import os
import sys
from collections import Counter

from faster_whisper import WhisperModel

HOTWORDS = "QQ-agent 大肥鱼 SnowLuma Kook OneBot Lagrange"  # 专有名词加固
AUDIO_EXTS = (".m4a", ".mp3", ".wav", ".aac", ".flac", ".opus", ".ogg")

# Whisper 在音乐/无人声素材上的经典幻觉句（出现就别当字幕）
HALLUCINATION_MARKERS = (
    "优优独播", "字幕志愿者", "作词曲", "作曲", "字幕由", "请不吝点赞", "订阅",
    "明镜与点点", "amara.org", "subtitles by", "thanks for watching",
)


def log(msg):
    print(f"[transcribe] {msg}", file=sys.stderr)


def pick_model(mode, override):
    """auto 时按模式选：极速=base，准确=large-v3-turbo。"""
    if override and override != "auto":
        return override
    return "large-v3-turbo" if mode == "accurate" else "base"


def split_long_segment(start, end, text):
    """VAD 关掉时会出现「一句 10 秒」的超长段：按标点拆开，时间按长度摊平。"""
    pieces = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in "。！？!?":
            pieces.append(buf.strip())
            buf = ""
    if buf.strip():
        pieces.append(buf.strip())
    merged = []
    for piece in pieces:
        if merged and len(merged[-1]) < 12 and len(merged[-1]) + len(piece) <= 40:
            merged[-1] += piece
        else:
            merged.append(piece)
    if len(merged) <= 1:
        return [(start, text)]
    total = max(0.1, end - start)
    total_chars = sum(len(p) for p in merged) or 1
    out = []
    cursor = start
    for piece in merged:
        span = total * len(piece) / total_chars
        out.append((cursor, piece))
        cursor += span
    return out


def transcribe(media_path, model_name, mode):
    """极速模式开 VAD、贪婪解码；准确模式不切音频、beam=3。"""
    log(f"Loading ASR model: {model_name} (mode={mode})")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    options = dict(
        language="zh",
        beam_size=3 if mode == "accurate" else 1,
        condition_on_previous_text=False,
        # 热词能纠正专有名词，但在纯音乐/歌词里会诱发幻觉，只在极速模式用
        hotwords=HOTWORDS if mode == "fast" else "",
        initial_prompt="以下是普通话内容，请用简体中文输出。",
    )
    if mode == "accurate":
        options["vad_filter"] = False
    else:
        options["vad_filter"] = True
        options["vad_parameters"] = dict(min_silence_duration_ms=800)

    segments, _info = model.transcribe(media_path, **options)

    seen = Counter()
    subtitles = []
    for segment in segments:
        text = segment.text.strip()
        if text == "":
            continue
        # 纯音乐/噪声段常被 Whisper 编成字幕：用模型自己给的置信度把这些段丢掉
        no_speech = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
        logprob = float(getattr(segment, "avg_logprob", 0.0) or 0.0)
        if no_speech > 0.6:
            log(f"drop (no_speech {no_speech:.2f}): {text[:20]}")
            continue
        if logprob < -1.0:
            log(f"drop (logprob {logprob:.2f}): {text[:20]}")
            continue
        lowered = text.lower()
        if any(marker in lowered for marker in HALLUCINATION_MARKERS):
            log(f"drop (hallucination): {text[:20]}")
            continue
        normalized = text.replace(" ", "").lower()
        seen[normalized] += 1
        if seen[normalized] > 2:
            log(f"drop (repeat #{seen[normalized]}): {text[:20]}")
            continue
        start = float(segment.start)
        end = float(segment.end)
        if (end - start) > 10 and len(text) < 8:
            log(f"drop (too short for span): {text[:20]}")
            continue
        if end - start > 8 and len(text) > 25:
            for part_start, piece in split_long_segment(start, end, text):
                start_sec = int(part_start)
                subtitles.append({"time": f"{start_sec // 60:02d}:{start_sec % 60:02d}", "text": piece})
        else:
            start_sec = int(start)
            subtitles.append({"time": f"{start_sec // 60:02d}:{start_sec % 60:02d}", "text": text})
    log(f"ASR done. {len(subtitles)} segments.")
    return subtitles


def media_duration(path):
    """用 av 读时长，音频视频都认；读不到就回 0。"""
    try:
        import av

        with av.open(path) as container:
            return int(float(container.duration or 0) / 1000000)
    except Exception:
        return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="音频或视频路径")
    parser.add_argument("--output", required=True, help="结果 JSON 路径")
    parser.add_argument("--mode", default="accurate", choices=["fast", "accurate"])
    parser.add_argument("--model", default="auto", help="auto/base/small/medium/large-v3-turbo")
    parser.add_argument("--model-dir", default="", help="本地模型目录（优先于 --model）")
    args = parser.parse_args()

    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir)

    try:
        model_name = args.model_dir.strip() or pick_model(args.mode, args.model)
        subtitles = transcribe(args.input, model_name, args.mode)
        is_audio = args.input.lower().endswith(AUDIO_EXTS)
        result = {
            "status": "success",
            "duration_seconds": media_duration(args.input),
            "subtitles": subtitles,
            # 契约保留：本地不再抽帧，恒为空数组
            "images": [],
            "mode": args.mode,
            "model": model_name,
            "media": "audio" if is_audio else "video",
        }
    except Exception as error:  # 任何失败都写进 JSON，调用方只看 status
        result = {"status": "error", "error": str(error), "subtitles": [], "images": []}
        log(f"ERROR: {error}")

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    return 0 if result.get("status") == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
