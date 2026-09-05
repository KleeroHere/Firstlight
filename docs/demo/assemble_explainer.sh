#!/usr/bin/env bash
# Assembles docs/demo/"How Firstlight works.mp4" from the cards, screenshots,
# narration and one real clip insert. Simple cuts (no Ken Burns), 1280x720/30,
# same encode profile family as the series itself.
set -e
cd "$(dirname "$0")"
SEG=seg
mkdir -p "$SEG"
VF="scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xF2E9DC"
ENC="-c:v libx264 -profile:v high -level:v 4.1 -pix_fmt yuv420p -crf 18 -r 30 -c:a aac -b:a 192k -ar 48000 -ac 2"
# A system font, not shipped in the repo (same convention as
# engine/pipeline.config.json's font fallback list) — point this at your own
# bold sans-serif. The drive-letter colon must be escaped for ffmpeg's
# drawtext option parser, hence the backslash.
FONT="C\\:/Windows/Fonts/arialbd.ttf"

cap() { # cap <capfile> -> drawtext filter chunk
  echo ",drawtext=fontfile=$FONT:textfile='captions/$1':fontsize=30:fontcolor=0x2B2320:box=1:boxcolor=0xF2E9DC@0.85:boxborderw=14:x=(w-text_w)/2:y=h-80"
}

# 1) title card, silent, 4s
ffmpeg -y -loop 1 -i card-title.png -f lavfi -i anullsrc=r=48000:cl=stereo -t 4 -vf "$VF" $ENC -shortest "$SEG/00-title.mp4" -loglevel error

# 2..7) narration sections over stills
mk_still() { # mk_still <name> <image> <audio> [captionfile]
  local name=$1 img=$2 aud=$3 capf=$4
  local vf="$VF"
  if [ -n "$capf" ]; then vf="$VF$(cap "$capf")"; fi
  ffmpeg -y -loop 1 -i "$img" -i "$aud" -vf "$vf" $ENC -shortest "$SEG/$name.mp4" -loglevel error
}
mk_still 01-what shots/rolls.png audio/01-what.mp3 c02.txt
mk_still 02-scenario shots/roll-scenario.png audio/02-scenario.mp3 c03.txt
mk_still 03-keyframes shots/roll-frames.png audio/03-keyframes.mp3 c04.txt
mk_still 04-motion pipeline-diagram.png audio/04-motion.mp3 c05.txt
mk_still 05-qa shots/roll-acceptance-plan4-redo.png audio/05-qa.mp3 c06.txt

# 6) cut/narration/verify — real clip insert, muted, narration over it
DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 audio/06-cut.mp3)
ffmpeg -y -i "../../workspace/out/Handover at the pier.mp4" -i audio/06-cut.mp3 -t "$DUR" \
  -vf "$VF$(cap c07.txt)" -map 0:v -map 1:a $ENC "$SEG/06-cut.mp4" -loglevel error

# 7) cost card
mk_still 07-cost card-cost.png audio/07-cost.mp3

# 8) closing card, silent, 5s
ffmpeg -y -loop 1 -i card-closing.png -f lavfi -i anullsrc=r=48000:cl=stereo -t 5 -vf "$VF" $ENC -shortest "$SEG/08-closing.mp4" -loglevel error

# concat
ls $SEG/*.mp4 | xargs -n1 basename | sort | sed "s/^/file '/;s/$/'/" > $SEG/list.txt
ffmpeg -y -f concat -safe 0 -i $SEG/list.txt -c:v libx264 -profile:v high -level:v 4.1 -pix_fmt yuv420p -crf 18 -r 30 \
  -af "loudnorm=I=-16:TP=-1.6:LRA=11" -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart \
  "How Firstlight works.mp4" -loglevel error

ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "How Firstlight works.mp4"
echo "done -> docs/demo/How Firstlight works.mp4"
