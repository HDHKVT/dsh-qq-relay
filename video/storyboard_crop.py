"""故事板裁切与拼图（2026-10-24）。

输入是一份计划 JSON（由 JS 侧算好），这里只做三件事：
    1. 按坐标从拼图里裁出单帧
    2. 把单帧排成一张总览图（带时间码），方便一次看全
    3. 吐一份结果 JSON 给宿主侧

为什么用 Python：Node 自带能力解不了 JPEG，而这个 venv 里已经有 Pillow
（video_processor.py 本来就在用它拼图），零新增依赖。

两种模式：
    frames 模式 —— JS 给了明确的裁切坐标（故事板自带时间轴时走这条）。
    auto   模式 —— JS 没拿到时间轴。实测 B 站的拼图是「用几格、其余留黑」，
                   这时不能按时长平铺，只能先扫一遍哪几格真的有画面再挑。

约定与 video_processor.py 一致：stdout 不解析，结果只看 --output 那个文件。
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# 判定「这一格有画面」的平均亮度阈值（0-255）。黑格实测是 0，有内容的几十到两百多。
FILLED_THRESHOLD = 8


def load_plan(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def format_time(seconds):
    total = int(round(float(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def cell_mean_brightness(image, box):
    """缩到 32×18 再求平均，够判断有没有内容，也不慢。"""
    cell = image.crop(box).convert("L").resize((32, 18))
    pixels = list(cell.getdata())
    return sum(pixels) / len(pixels)


def scan_filled_cells(sheet, columns, rows, cell_w, cell_h):
    """返回这张拼图里「真的有画面」的格号（行优先）。"""
    filled = []
    for row in range(rows):
        for column in range(columns):
            left, top = column * cell_w, row * cell_h
            box = (left, top, left + cell_w, top + cell_h)
            if box[2] > sheet.width or box[3] > sheet.height:
                continue
            if cell_mean_brightness(sheet, box) > FILLED_THRESHOLD:
                filled.append(row * columns + column)
    return filled


def pick_evenly(items, count):
    """从列表里等距挑 count 个（含首尾）。宁可少挑，不重复。"""
    if not items:
        return []
    count = max(1, int(count))
    if count >= len(items):
        return list(items)
    if count == 1:
        return [items[len(items) // 2]]
    picked = []
    for index in range(count):
        position = round(index * (len(items) - 1) / (count - 1))
        picked.append(items[position])
    return picked


def auto_frames(plan):
    """没时间轴时的兜底：扫出有画面的格，等距挑几帧，时间按时长比例推算。"""
    sprites = plan.get("sprites", [])
    columns = int(plan.get("columns", 0))
    rows = int(plan.get("rows", 0))
    cell_w = int(plan.get("cellWidth", 0))
    cell_h = int(plan.get("cellHeight", 0))
    count = int(plan.get("count", 6))
    duration = float(plan.get("durationSeconds", 0))
    if not sprites or columns <= 0 or rows <= 0 or cell_w <= 0 or cell_h <= 0:
        return [], [{"reason": "auto 模式的几何参数不完整"}]

    candidates = []
    for sheet_index, sprite_path in enumerate(sprites):
        if not sprite_path or not os.path.exists(sprite_path):
            continue
        with Image.open(sprite_path) as sheet:
            sheet = sheet.convert("RGB")
            for cell_index in scan_filled_cells(sheet, columns, rows, cell_w, cell_h):
                candidates.append((sheet_index, cell_index))
    if not candidates:
        return [], [{"reason": "整张拼图都是黑的，没有可用画面"}]

    chosen = pick_evenly(candidates, count)
    frames = []
    errors = []
    last = max(1, len(candidates) - 1)
    for order, (sheet_index, cell_index) in enumerate(chosen, start=1):
        position = candidates.index((sheet_index, cell_index))
        time_seconds = duration * position / last if duration > 0 else 0.0
        frames.append({
            "sprite": sheet_index,
            "x": (cell_index % columns) * cell_w,
            "y": (cell_index // columns) * cell_h,
            "w": cell_w,
            "h": cell_h,
            "timeSeconds": round(time_seconds, 1),
            "order": order,
        })
    return frames, errors


def crop_frames(plan, out_dir):
    """按计划裁出每帧，返回 (成功列表, 失败列表)。单帧失败不中断整体。"""
    os.makedirs(out_dir, exist_ok=True)
    opened = {}
    frames = []
    errors = []
    for order, item in enumerate(plan.get("frames", []), start=1):
        sprite_index = int(item.get("sprite", 0))
        sprites = plan.get("sprites", [])
        sprite_path = sprites[sprite_index] if sprite_index < len(sprites) else None
        if not sprite_path or not os.path.exists(sprite_path):
            errors.append({"index": order, "reason": f"拼图不存在：{sprite_path}"})
            continue
        try:
            if sprite_index not in opened:
                opened[sprite_index] = Image.open(sprite_path).convert("RGB")
            sheet = opened[sprite_index]
            box = (
                int(item["x"]),
                int(item["y"]),
                int(item["x"]) + int(item["w"]),
                int(item["y"]) + int(item["h"]),
            )
            box = (
                max(0, min(box[0], sheet.width - 1)),
                max(0, min(box[1], sheet.height - 1)),
                max(1, min(box[2], sheet.width)),
                max(1, min(box[3], sheet.height)),
            )
            cell = sheet.crop(box)
            name = f"frame-{order:02d}.jpg"
            dest = os.path.join(out_dir, name)
            cell.save(dest, "JPEG", quality=88)
            frames.append({
                "path": dest,
                "timeSeconds": float(item.get("timeSeconds", 0)),
                "width": cell.width,
                "height": cell.height,
            })
        except Exception as error:
            errors.append({"index": order, "reason": str(error)})
    for image in opened.values():
        try:
            image.close()
        except Exception:
            pass
    return frames, errors


def build_montage(frames, dest_path, columns=3, max_width=1600, label_height=26, gap=6):
    """把单帧排成一张总览图，每格下面标时间码。"""
    if not frames:
        return None
    columns = max(1, min(int(columns), len(frames)))
    rows = (len(frames) + columns - 1) // columns
    cell_width = max(1, (max_width - gap * (columns + 1)) // columns)
    ratio = frames[0]["height"] / frames[0]["width"] if frames[0]["width"] else 9 / 16
    cell_height = max(1, int(cell_width * ratio))

    canvas_width = gap + columns * (cell_width + gap)
    canvas_height = gap + rows * (cell_height + label_height + gap)
    canvas = Image.new("RGB", (canvas_width, canvas_height), (24, 24, 28))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("arial.ttf", 18)
    except Exception:
        font = ImageFont.load_default()

    for index, frame in enumerate(frames):
        row, column = divmod(index, columns)
        left = gap + column * (cell_width + gap)
        top = gap + row * (cell_height + label_height + gap)
        try:
            with Image.open(frame["path"]) as image:
                thumb = image.convert("RGB").resize((cell_width, cell_height), Image.LANCZOS)
                canvas.paste(thumb, (left, top))
        except Exception:
            draw.rectangle([left, top, left + cell_width, top + cell_height], fill=(60, 60, 60))
        draw.text((left + 2, top + cell_height + 3), format_time(frame["timeSeconds"]), fill=(230, 230, 230), font=font)

    canvas.save(dest_path, "JPEG", quality=86)
    canvas.close()
    return dest_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True, help="计划 JSON")
    parser.add_argument("--output", required=True, help="结果 JSON")
    parser.add_argument("--out-dir", default="", help="单帧输出目录（默认计划同级的 frames）")
    args = parser.parse_args()

    result = {"status": "ok", "mode": "frames", "frames": [], "montage": "", "errors": []}
    try:
        plan = load_plan(args.plan)
        out_dir = args.out_dir or os.path.join(os.path.dirname(os.path.abspath(args.plan)), "frames")

        frames_to_crop = plan.get("frames") or []
        if not frames_to_crop and plan.get("auto"):
            result["mode"] = "auto"
            frames_to_crop, errors = auto_frames(plan)
            result["errors"].extend(errors)
            plan = dict(plan)
            plan["frames"] = frames_to_crop

        frames, errors = crop_frames(plan, out_dir)
        result["frames"] = frames
        result["errors"].extend(errors)

        montage_setting = plan.get("montage") or {}
        if frames and montage_setting.get("enabled", True):
            montage_path = os.path.join(os.path.dirname(os.path.abspath(out_dir)), "montage.jpg")
            build_montage(
                frames,
                montage_path,
                columns=montage_setting.get("columns", 3),
                max_width=montage_setting.get("maxWidth", 1600),
            )
            result["montage"] = montage_path
        if not frames:
            result["status"] = "empty"
    except Exception as error:
        result["status"] = "error"
        result["errors"].append({"reason": str(error)})

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
