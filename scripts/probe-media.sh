#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo 'Usage: probe-media.sh /path/to/video.mp4' >&2
  exit 2
fi

media="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
video_stream="$(ffprobe -v error -select_streams V:0 -show_entries stream=index -of csv=p=0 "$media")"
audio_stream="$(ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "$media")"

if [[ -z "$video_stream" || -z "$audio_stream" ]]; then
  echo 'A video stream and an audio stream are required.' >&2
  exit 3
fi

ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,duration -of json "$media"
ffmpeg -nostdin -hide_banner -xerror -i "$media" \
  -map "0:$video_stream" -map "0:$audio_stream" \
  -af 'silencedetect=noise=-45dB:d=0.5,ebur128=peak=true' \
  -f null -
