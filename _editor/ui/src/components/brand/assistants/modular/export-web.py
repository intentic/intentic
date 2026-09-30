#!/usr/bin/env python3
"""Cut the PNG masters into the small WebP parts the application ships, plus their layout.

The masters are 1-2 MB each and sized for editing. The app never draws a face larger than a couple of hundred CSS
pixels, so every part is cropped to its manifest `sourceRect`, fitted into its `placement` the way SVG's
`xMidYMid meet` would, and stored at half the manifest canvas. `web/layout.json` records each part's fitted rectangle
in manifest canvas units (1024 square), so the renderer places images without re-deriving the fit.

Run from anywhere after changing a master or the manifest (needs Pillow built with WebP):

    python3 _editor/ui/src/components/brand/assistants/modular/export-web.py
"""

import json
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "web"
SCALE = 0.5  # 1024 canvas -> 512 px: sharp at 160 CSS px on a 3x screen.
QUALITY = 88


def fitted(source_rect, placement):
    """Where `meet` puts the source rectangle inside the placement, in canvas units."""
    _, _, sw, sh = source_rect
    px, py, pw, ph = placement
    scale = min(pw / sw, ph / sh)
    w, h = sw * scale, sh * scale
    return [round(px + (pw - w) / 2, 2), round(py + (ph - h) / 2, 2), round(w, 2), round(h, 2)]


def export(name, asset):
    x, y, w, h = asset["sourceRect"]
    image = Image.open(HERE / asset["src"]).convert("RGBA").crop((x, y, x + w, y + h))
    rect = fitted(asset["sourceRect"], asset["placement"])
    size = (max(1, round(rect[2] * SCALE)), max(1, round(rect[3] * SCALE)))
    image.resize(size, Image.Resampling.LANCZOS).save(OUT / f"{name}.webp", "WEBP", quality=QUALITY, alpha_quality=100, method=6)
    return rect


def main():
    manifest = json.loads((HERE / "manifest.json").read_text())
    OUT.mkdir(exist_ok=True)
    layers = manifest["layers"]
    layout: dict[str, object] = {
        "canvas": manifest["canvas"],
        "palette": manifest["palette"],
        "layers": {
            "body": export("body", layers["body"]),
            "crown": export("crown", layers["crown"]),
            "leftHand": export("hand-left", layers["leftHand"]),
            "rightHand": export("hand-right", layers["rightHand"]),
        },
    }
    accessories: dict[str, object] = {}
    for accessory in manifest["accessories"]:
        entry: dict[str, object] = {"rect": export(accessory["id"], accessory)}
        hands = accessory.get("hands")
        if hands:
            # The hand art keeps its own aspect, so an override placement is fitted the same way.
            entry["hands"] = {
                "left": fitted(layers["leftHand"]["sourceRect"], hands["left"]),
                "right": fitted(layers["rightHand"]["sourceRect"], hands["right"]),
            }
        accessories[accessory["id"]] = entry
    layout["accessories"] = accessories
    (OUT / "layout.json").write_text(json.dumps(layout, indent=2) + "\n")
    for part in sorted(OUT.glob("*.webp")):
        print(f"{part.name:18} {part.stat().st_size / 1024:6.1f} KB  {Image.open(part).size}")


if __name__ == "__main__":
    main()
