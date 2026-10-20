import argparse
import json
import sys
import os
import math
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from faster_whisper import WhisperModel

# ========== 配置区 ==========
FONT_PATH = "C:\\Windows\\Fonts\\msyh.ttc"
FONT_SIZE = 32
HIST_THRESHOLD = 0.45    # HSV 直方图 Bhattacharyya 距离，超过就算换场景（PPT/翻页更敏感）
COVERAGE_SEC = 20        # 兜底：这么久没存帧就强制存一张，防止漏掉静止但重要的画面
GRID_COLS = 2
GRID_ROWS = 2
HOTWORDS = "QQ-agent 大肥鱼 SnowLuma Kook OneBot Lagrange"  # 专有名词加固
# Whisper 在音乐/无人声素材上的经典幻觉句（出现就别当字幕）
AUDIO_EXTS = (".m4a", ".mp3", ".wav", ".aac", ".flac", ".opus", ".ogg")

HALLUCINATION_MARKERS = (
    "优优独播", "字幕志愿者", "作词曲", "作曲", "字幕由", "请不吝点赞", "订阅",
    "明镜与点点", "amara.org", "subtitles by", "thanks for watching",
)
# ============================


def log(msg):
    print(f"[video_processor] {msg}", file=sys.stderr)


def format_path(p):
    r"""统一路径格式，防止 JSON 里出现 / 和 \ 混用"""
    return os.path.normpath(p).replace("\\", "/")


def pick_model(mode, override):
    """auto 时按模式选：极速=base，准确=large-v3-turbo。"""
    if override and override != "auto":
        return override
    return "large-v3-turbo" if mode == "accurate" else "base"


def extract_audio_and_transcribe(video_path, model_name, mode):
    """转写：极速模式开 VAD、贪婪解码；准确模式不切音频、beam=3。"""
    log(f"Loading ASR model: {model_name} (mode={mode})")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    options = dict(
        language="zh",
        beam_size=3 if mode == "accurate" else 1,
        condition_on_previous_text=False,
        # 热词能纠正专有名词，但在纯音乐/歌词里会诱发幻觉（凭空冒出发热词），只在极速模式用
        hotwords=HOTWORDS if mode == "fast" else "",
        initial_prompt="以下是普通话内容，请用简体中文输出。",
    )
    if mode == "accurate":
        options["vad_filter"] = False
    else:
        options["vad_filter"] = True
        options["vad_parameters"] = dict(min_silence_duration_ms=800)

    segments, info = model.transcribe(video_path, **options)

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
        # 太碎就合并相邻碎片，目标每段 12~25 字
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

    from collections import Counter
    seen = Counter()
    subtitles = []
    for segment in segments:
        text = segment.text.strip()
        if text == "":
            continue
        # 纯音乐/噪声段常被 Whisper 编成字幕（“字幕志愿者”“优优独播剧场”那类）：
        # 用模型自己给的置信度把这些段丢掉，宁可少一条也不要胡编
        no_speech = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
        logprob = float(getattr(segment, "avg_logprob", 0.0) or 0.0)
        if no_speech > 0.6:
            log(f"drop (no_speech {no_speech:.2f}): {text[:20]}")
            continue
        if logprob < -1.0:
            log(f"drop (logprob {logprob:.2f}): {text[:20]}")
            continue
        # Whisper 在音乐/噪声上会“复读”（同一句连出现十几遍）或长时间只吐两三个字：
        # 同一句第 3 次出现起丢掉；超过 10 秒却不到 8 个字的段也丢掉
        lowered = text.lower()
        if any(marker in lowered for marker in HALLUCINATION_MARKERS):
            log(f"drop (hallucination): {text[:20]}")
            continue
        normalized = text.replace(" ", "").lower()
        seen[normalized] += 1
        if seen[normalized] > 2:
            log(f"drop (repeat #{seen[normalized]}): {text[:20]}")
            continue
        if (float(segment.end) - float(segment.start)) > 10 and len(text) < 8:
            log(f"drop (too short for span): {text[:20]}")
            continue
        start = float(segment.start)
        end = float(segment.end)
        if end - start > 8 and len(text) > 25:
            for part_start, piece in split_long_segment(start, end, text):
                start_sec = int(part_start)
                subtitles.append({
                    "time": f"{start_sec // 60:02d}:{start_sec % 60:02d}",
                    "text": piece,
                })
        else:
            start_sec = int(start)
            subtitles.append({
                "time": f"{start_sec // 60:02d}:{start_sec % 60:02d}",
                "text": text,
            })
    log(f"ASR done. Extracted {len(subtitles)} subtitle segments.")
    return subtitles


def save_frame(frame, sec, out_dir, saved_frames):
    """存一帧并烧时间戳。"""
    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(frame_rgb)
    pil_img.thumbnail((800, 800))

    draw = ImageDraw.Draw(pil_img)
    try:
        font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    except Exception:
        font = ImageFont.load_default()

    time_str = f"[{sec // 60:02d}:{sec % 60:02d}]"
    draw.rectangle([(5, 5), (5 + len(time_str) * FONT_SIZE, 5 + FONT_SIZE + 10)], fill="black")
    draw.text((10, 5), time_str, font=font, fill="white")

    img_path = os.path.join(out_dir, f"frame_{sec:04d}.jpg")
    pil_img.save(img_path)
    saved_frames.append((sec, img_path))
    log(f"Saved keyframe at {time_str}")


def extract_keyframes(video_path, out_dir, max_grid=8):
    """每 2 秒采样一次，用 HSV 直方图判断换场景；长时间没变化也兜底存一帧。"""
    if video_path.lower().endswith(AUDIO_EXTS):
        log("Input is audio only: skip keyframes")
        return []

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0

    if duration == 0:
        cap.release()
        raise ValueError("Cannot read video duration.")

    step = max(1, int(round(fps * 2)))
    log(f"Scanning video: {duration:.1f}s, every {step} frames (HSV histogram, threshold {HIST_THRESHOLD})")

    saved_frames = []
    prev_hist = None
    last_saved = -COVERAGE_SEC
    frame_count = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        if frame_count % step == 0:
            sec = int(frame_count / fps)
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([hsv], [0, 1], None, [50, 60], [0, 180, 0, 256])
            cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)

            changed = prev_hist is None or cv2.compareHist(prev_hist, hist, cv2.HISTCMP_BHATTACHARYYA) > HIST_THRESHOLD
            prev_hist = hist

            if changed or (sec - last_saved) >= COVERAGE_SEC:
                save_frame(frame, sec, out_dir, saved_frames)
                last_saved = sec

        frame_count += 1

    cap.release()

    grid_paths = []
    if not saved_frames:
        return grid_paths

    # 长视频会留下几百帧，但拼图上限只有 max_grid 张（每张 4 帧）：
    # 直接取前 N 张会让后半段完全没画面，改成**按时间轴均匀抽**，覆盖全片
    limit_frames = max_grid * GRID_COLS * GRID_ROWS
    if len(saved_frames) > limit_frames:
        step_idx = (len(saved_frames) - 1) / (limit_frames - 1)
        picked = [saved_frames[round(i * step_idx)] for i in range(limit_frames)]
        log(f"Frames kept {len(saved_frames)} > {limit_frames}: evenly sampled across timeline")
        saved_frames = picked

    num_grids = math.ceil(len(saved_frames) / (GRID_COLS * GRID_ROWS))
    num_grids = min(num_grids, max_grid)

    for g in range(num_grids):
        start_idx = g * GRID_COLS * GRID_ROWS
        chunk = saved_frames[start_idx:start_idx + GRID_COLS * GRID_ROWS]
        if not chunk:
            break

        template = Image.open(chunk[0][1])
        w, h = template.size
        grid_img = Image.new("RGB", (w * GRID_COLS, h * GRID_ROWS), color="black")

        for i, (sec, img_path) in enumerate(chunk):
            img = Image.open(img_path)
            row = i // GRID_COLS
            col = i % GRID_COLS
            grid_img.paste(img, (col * w, row * h))

        grid_path = os.path.join(out_dir, f"grid_{g:02d}.jpg")
        grid_img.save(grid_path)
        grid_paths.append(format_path(grid_path))
        log(f"Generated grid image: {grid_path}")

    log(f"Keyframes kept: {len(saved_frames)}, grids: {len(grid_paths)}")
    return grid_paths


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Path to input video")
    parser.add_argument("--output", required=True, help="Path to output JSON")
    parser.add_argument("--mode", default="accurate", choices=["fast", "accurate"], help="fast=base+VAD, accurate=turbo")
    parser.add_argument("--model", default="auto", help="auto/base/small/medium/large-v3-turbo")
    parser.add_argument("--model-dir", default="", help="Local model directory (overrides --model)")
    parser.add_argument("--max-grid", type=int, default=8, help="Max grid images (1-16)")
    args = parser.parse_args()

    video_path = args.input
    out_json = args.output
    out_dir = os.path.dirname(out_json)
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)

    try:
        model_name = args.model_dir.strip() or pick_model(args.mode, args.model)
        subtitles = extract_audio_and_transcribe(video_path, model_name, args.mode)

        log("Extracting keyframes...")
        grid_paths = extract_keyframes(video_path, out_dir, max(1, min(16, args.max_grid)))

        is_audio = video_path.lower().endswith(AUDIO_EXTS)
        if is_audio:
            import av
            with av.open(video_path) as container:
                duration = int(float(container.duration or 0) / 1000000)
        else:
            cap = cv2.VideoCapture(video_path)
            fps = cap.get(cv2.CAP_PROP_FPS)
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            duration = int(total_frames / fps) if fps > 0 else 0
            cap.release()

        result = {
            "status": "success",
            "duration_seconds": duration,
            "subtitles": subtitles,
            "images": grid_paths,
            "mode": args.mode,
            "model": model_name,
            "media": "audio" if is_audio else "video",
        }

        # 契约：写入文件
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        log("Success. JSON written.")

    except Exception as e:
        log(f"ERROR: {str(e)}")
        # 契约：失败时也要写 JSON，并用非零退出码
        try:
            with open(out_json, "w", encoding="utf-8") as f:
                json.dump({"status": "error", "message": str(e)}, f, ensure_ascii=False)
        except Exception:
            pass
        raise SystemExit(1)


if __name__ == "__main__":
    main()
