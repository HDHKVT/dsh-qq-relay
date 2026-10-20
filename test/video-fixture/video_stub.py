#!/usr/bin/env python3
"""测试用占位处理器：只验证“spawn → 输出文件 → 校验”这条链，不碰 ffmpeg/ASR。"""
import argparse
import json
import os

parser = argparse.ArgumentParser()
parser.add_argument('--input', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()

size = os.path.getsize(args.input)
result = {
    'status': 'success',
    'duration_seconds': 7,
    'subtitles': [
        {'time': '00:00', 'text': '测试字幕一'},
        {'time': '00:03', 'text': f'输入 {size} 字节'},
    ],
    'images': [],
}
with open(args.output, 'w', encoding='utf-8') as fh:
    json.dump(result, fh, ensure_ascii=False)
print('stub-ok')
