"""把一段文本渲染成二维码 PNG（2026-10-24）。

为什么用 Python 而不是 JS 手写编码器：QR 的 Reed-Solomon、掩码、版本选择
几百行，错一个比特就是"手机扫不出来"，而排查成本极高。segno 是纯 Python、
几十 KB、没有额外依赖，不值得自己造。

约定同其他脚本：结果只看 --output 那个文件。
"""

import argparse
import sys

import segno


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True, help="要编码的文本（登录时是 B 站给的 url）")
    parser.add_argument("--output", required=True, help="PNG 输出路径")
    parser.add_argument("--scale", type=int, default=8, help="每个模块的像素数")
    parser.add_argument("--border", type=int, default=2, help="静区宽度（模块数）")
    args = parser.parse_args()

    try:
        # 纠错等级 M：二维码脏一点也能扫，尺寸也不至于太大
        qr = segno.make(args.text, error="m")
        qr.save(args.output, scale=max(2, args.scale), border=max(0, args.border))
        print(f"[qr] saved {args.output}", file=sys.stderr)
        return 0
    except Exception as error:
        print(f"[qr] ERROR {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
