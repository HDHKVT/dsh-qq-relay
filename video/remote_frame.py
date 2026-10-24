"""按时刻从远程视频流里抽帧（2026-10-24）。

不下载整片：直接对 CDN 地址 seek，解一帧就停。
实测一条 43 分钟的视频抽一帧约 2~3 秒。

约定与另外两个 Python 脚本一致：stdout 不解析，结果只看 --output 那个文件。

计划 JSON：
    {
      "url": "https://...",            // 播放地址
      "referer": "https://www.bilibili.com/",
      "times": [12.0, 723.5],          // 要抽的时刻（秒）
      "outDir": "D:/.../frames"
    }

结果 JSON：
    {
      "status": "ok" | "partial" | "error",
      "frames": [{"timeSeconds": 12.0, "path": "...", "width": 1280, "height": 720}],
      "errors": [{"timeSeconds": 723.5, "reason": "..."}]
    }
"""

import argparse
import json
import os
import sys

import av

HEADERS_TEMPLATE = (
    "Referer: {referer}\r\n"
    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n"
)

# 单帧解码最多尝试的帧数：seek 之后有时要丢几个关键帧才能出图
MAX_DECODE_ATTEMPTS = 90


def grab_one(container, stream, seconds, dest_path):
    """跳到 seconds 附近解一帧并存盘。返回 (是否成功, 原因, 实际时间, 宽, 高)。"""
    try:
        offset = max(0, int(seconds / stream.time_base))
        container.seek(offset, stream=stream, backward=True)
    except Exception as error:
        return False, f"seek 失败：{error}", None, None, None

    for _ in range(MAX_DECODE_ATTEMPTS):
        try:
            frame = next(container.decode(stream))
        except StopIteration:
            return False, "seek 之后没有可解的帧", None, None, None
        except Exception as error:
            return False, f"解码失败：{error}", None, None, None
        if frame.pts is None:
            continue
        actual = float(frame.pts * stream.time_base)
        # 允许一点点误差：容器的时间基和关键帧间隔都会带来偏移
        if actual + 1.0 < seconds:
            continue
        image = frame.to_image()
        image.save(dest_path, "JPEG", quality=92)
        return True, "", actual, image.width, image.height

    return False, "解了 90 帧还没到目标时间", None, None, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    result = {"status": "ok", "frames": [], "errors": []}

    try:
        with open(args.plan, "r", encoding="utf-8") as handle:
            plan = json.load(handle)
        times = [float(value) for value in plan.get("times", [])]
        out_dir = plan.get("outDir") or os.path.dirname(os.path.abspath(args.plan))
        os.makedirs(out_dir, exist_ok=True)
        if not times:
            raise ValueError("计划里没有时刻")

        headers = HEADERS_TEMPLATE.format(referer=plan.get("referer") or "https://www.bilibili.com/")
        container = av.open(plan["url"], options={"headers": headers, "timeout": "20000000"})
        stream = container.streams.video[0]

        for order, seconds in enumerate(times, start=1):
            name = f"frame-{order:02d}-{int(round(seconds))}s.jpg"
            dest = os.path.join(out_dir, name)
            ok, reason, actual, width, height = grab_one(container, stream, seconds, dest)
            if ok:
                result["frames"].append({
                    "timeSeconds": round(actual, 2),
                    "path": dest,
                    "width": width,
                    "height": height,
                })
            else:
                result["errors"].append({"timeSeconds": seconds, "reason": reason})

        container.close()
        if result["errors"] and result["frames"]:
            result["status"] = "partial"
        elif result["errors"] and not result["frames"]:
            result["status"] = "error"
    except Exception as error:
        result["status"] = "error"
        result["errors"].append({"timeSeconds": None, "reason": str(error)})

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
