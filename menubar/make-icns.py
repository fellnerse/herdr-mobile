#!/usr/bin/env python3
"""Build SheepIt.icns from web/icon.svg.

macOS does not mask app icons the way iOS does: an app ships its own shape, so
the full-bleed square that iOS rounds for us would sit in the Dock as a square
tile beside everything else's rounded rectangle. Rather than keep a second
drawing of the sheep in step by hand, the source SVG is wrapped here - clipped
to the rounded rectangle and inset to Apple's proportions (824pt of art in a
1024pt canvas), so there is still exactly one sheep to edit.

Rasterising is qlmanage, macOS's own thumbnailer, so nothing needs installing.
"""

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "web" / "icon.svg"
CANVAS = 1024
INSET = 100          # Apple's grid: 824 of art centred in 1024
ART = CANVAS - INSET * 2
RADIUS = 185         # near enough to the squircle with a plain rounded rect
SIZES = [16, 32, 64, 128, 256, 512, 1024]
# iconutil wants most sizes under two names; @2x is the next size up.
NAMES = {
    16: ["icon_16x16.png"],
    32: ["icon_16x16@2x.png", "icon_32x32.png"],
    64: ["icon_32x32@2x.png"],
    128: ["icon_128x128.png"],
    256: ["icon_128x128@2x.png", "icon_256x256.png"],
    512: ["icon_256x256@2x.png", "icon_512x512.png"],
    1024: ["icon_512x512@2x.png"],
}


def wrapped_svg() -> str:
    """The source drawing, clipped into the rounded rectangle macOS expects."""
    body = SRC.read_text()
    body = re.sub(r"^.*?<svg[^>]*>", "", body, count=1, flags=re.S)
    body = body.rsplit("</svg>", 1)[0]
    scale = ART / 512.0          # the source draws in a 512 box
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}">
  <defs>
    <clipPath id="macmask">
      <rect x="{INSET}" y="{INSET}" width="{ART}" height="{ART}" rx="{RADIUS}" ry="{RADIUS}"/>
    </clipPath>
  </defs>
  <!-- Clip and transform must sit on separate elements: a clip-path is resolved
       in the coordinate system its own element establishes, so putting both on
       one <g> would scale the mask along with the art. -->
  <g clip-path="url(#macmask)">
    <g transform="translate({INSET} {INSET}) scale({scale})">
{body}
    </g>
  </g>
</svg>
"""


def main() -> int:
    if not SRC.is_file():
        print(f"missing {SRC}", file=sys.stderr)
        return 1
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "build" / "SheepIt.icns"
    out = out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        shaped = tmp / "shaped.svg"
        shaped.write_text(wrapped_svg())
        iconset = tmp / "icon.iconset"
        iconset.mkdir()

        for size in SIZES:
            subprocess.run(
                ["qlmanage", "-t", "-s", str(size), "-o", str(tmp), str(shaped)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            rendered = tmp / "shaped.svg.png"
            if not rendered.is_file():
                print(f"qlmanage produced nothing at {size}px", file=sys.stderr)
                return 1
            for name in NAMES[size]:
                shutil.copyfile(rendered, iconset / name)
            rendered.unlink()

        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)
    print(f"built {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
