#!/usr/bin/env bash
# Record every demo as an animated GIF into demos/gifs/ (git-ignored — regenerate any time).
# Captures each demo's real ANSI output, then renders a terminal-style GIF with Pillow. No external
# recorder needed. Needs: node deps (npm i), python3 with Pillow, a monospace font, and — for the
# docker demos — a docker daemon (they skip cleanly without it).
set -uo pipefail
cd "$(dirname "$0")/.."
OUT=demos/gifs; TMP="$(mktemp -d)"; mkdir -p "$OUT"
DEMOS=(01-nn-session-sandbox 02-sandbox-disposable 03-shared-container 04-provider-swap 05-pause-resume)
for d in "${DEMOS[@]}"; do
  echo "capturing $d ..."
  npx tsx "demos/$d.ts" > "$TMP/$d.ansi" 2>&1
done
docker ps -aq --filter label=pi.sandbox=1 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true

python3 - "$TMP" "$OUT" <<'PY'
import re, sys, os
from PIL import Image, ImageDraw, ImageFont
CAPS, OUT = sys.argv[1], sys.argv[2]
FONT = os.environ.get("DEMO_FONT", "/System/Library/Fonts/Menlo.ttc")
FS, LH, PAD, TOP = 22, 30, 28, 54
BG, BAR, FG = (30,32,40), (46,48,58), (213,216,224)
PALETTE={31:(240,113,120),32:(126,203,128),33:(229,192,123),34:(97,175,239),36:(86,204,214),0:FG}
ANSI=re.compile(r"\x1b\[([0-9;]*)m")
def parse(line):
    spans=[]; i=0; st={"c":FG,"b":False,"d":False}; buf=[""]
    def flush():
        if buf[0]: spans.append((buf[0],st["c"],st["b"],st["d"])); buf[0]=""
    for m in ANSI.finditer(line):
        buf[0]+=line[i:m.start()]; i=m.end(); flush()
        for code in (m.group(1) or "0").split(";"):
            c=int(code) if code else 0
            if c==0: st.update(c=FG,b=False,d=False)
            elif c==1: st["b"]=True
            elif c==2: st["d"]=True
            elif c in PALETTE: st["c"]=PALETTE[c]
    buf[0]+=line[i:]; flush(); return spans
dim=lambda c: tuple(int(v*0.55) for v in c)
reg=ImageFont.truetype(FONT,FS,index=0)
try: bold=ImageFont.truetype(FONT,FS,index=1)
except Exception: bold=reg
CW=reg.getbbox("M")[2]
for name in sorted(os.listdir(CAPS)):
    if not name.endswith(".ansi"): continue
    raw=[l.replace("━","—") for l in open(os.path.join(CAPS,name)).read().rstrip("\n").split("\n")]
    lines=[parse(l) for l in raw]
    ncols=max((sum(len(t) for t,_,_,_ in ln) for ln in lines), default=40)
    W=PAD*2+CW*min(max(ncols,54),124); H=TOP+PAD+LH*len(lines)+PAD
    def draw(k):
        img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img); d.rectangle([0,0,W,TOP],fill=BAR)
        for cx,cc in [(24,(255,95,86)),(48,(255,189,46)),(72,(39,201,63))]: d.ellipse([cx-8,19,cx+8,35],fill=cc)
        d.text((96,16),"rethink-managed-agent — make demo",font=reg,fill=(150,154,165))
        y=TOP+PAD-6
        for ln in lines[:k]:
            x=PAD
            for t,c,b,dm in ln: d.text((x,y),t,font=bold if b else reg,fill=dim(c) if dm else c); x+=CW*len(t)
            y+=LH
        return img
    frames=[draw(k) for k in range(1,len(lines)+1)]
    durs=[]
    for k in range(len(frames)):
        txt=" ".join(t for t,_,_,_ in lines[k]).strip()
        durs.append(850 if (txt[:1].isdigit() and txt[1:2]==".") else 360)
    durs[-1]=2800
    out=os.path.join(OUT,name[:-5]+".gif")
    frames[-1].save(out,save_all=True,append_images=frames[1:],duration=durs,loop=0,optimize=True)
    print(f"  {out}  {W}x{H}  {len(frames)}f")
PY
rm -rf "$TMP"
echo "done -> $OUT/"
