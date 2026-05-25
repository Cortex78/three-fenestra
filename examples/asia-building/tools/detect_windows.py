#!/usr/bin/env python3
"""
Detect window rectangles in build_01_baseColor.jpeg.

Strategy: the texture is a complex Asian-apartment facade where individual
windows are glass (not solid dark) — blob detection on luminance doesn't isolate
them. But the building has very clear *horizontal floor bands*: dark ledges
separate one floor of balconies from the next. We:

  1. Find horizontal floor-separator lines by scanning the row-wise mean of dark
     pixels and picking local peaks.
  2. Between each adjacent pair of separators, define a "floor band" and place
     N evenly spaced windows across the width.
  3. Crop each window to the upper portion of the band (where the apartment
     interior sits, above the railing).

Writes windows.json and a preview overlay.
"""
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC  = ROOT / "models" / "asia_building" / "textures" / "build_01_baseColor.jpeg"
OUT_JSON    = ROOT / "models" / "asia_building" / "windows.json"
OUT_PREVIEW = ROOT / "tools" / "windows_preview.png"

# Tunables
DARK_THRESHOLD       = 90    # for the separator-line detection
PEAK_MIN_SEPARATION  = 50    # pixels between detected floor separators
PEAK_MIN_FRACTION    = 0.55  # a row counts as a separator if this fraction of its pixels are dark
WINDOWS_PER_FLOOR    = 7     # how many windows across each floor
WINDOW_TOP_FRACTION  = 0.05  # crop window to start this far below the top separator
WINDOW_BOT_FRACTION  = 0.55  # crop window to end this far below the top separator (above railing)
SIDE_INSET_PX        = 4     # leave a small horizontal gap from the texture edge
H_GAP_PX             = 3     # gap between adjacent windows in the same floor

def find_floor_separators(gray: np.ndarray) -> list[int]:
    H, W = gray.shape
    dark = (gray < DARK_THRESHOLD).astype(np.float32)
    row_score = dark.mean(axis=1)  # fraction-of-dark per row
    candidates = np.where(row_score > PEAK_MIN_FRACTION)[0]
    if len(candidates) == 0:
        return [0, H]
    # Cluster consecutive candidate rows into separator bands; keep midpoint.
    groups = []
    cur = [int(candidates[0])]
    for y in candidates[1:]:
        if y - cur[-1] <= 3:
            cur.append(int(y))
        else:
            groups.append(cur)
            cur = [int(y)]
    groups.append(cur)
    seps = [(g[0] + g[-1]) // 2 for g in groups]
    # Enforce min separation between picks.
    filtered = [seps[0]]
    for s in seps[1:]:
        if s - filtered[-1] >= PEAK_MIN_SEPARATION:
            filtered.append(s)
    # Always bracket with image top/bottom so the first/last floor gets a band.
    if filtered[0] > PEAK_MIN_SEPARATION:
        filtered.insert(0, 0)
    if H - filtered[-1] > PEAK_MIN_SEPARATION:
        filtered.append(H)
    return filtered

def main():
    if not SRC.exists():
        raise SystemExit(f"missing texture: {SRC}")

    img = Image.open(SRC).convert("RGB")
    W, H = img.size
    gray = np.array(img.convert("L"))

    seps = find_floor_separators(gray)
    print(f"floor separators (y px): {seps}")

    rects = []
    for top, bot in zip(seps[:-1], seps[1:]):
        band_h = bot - top
        if band_h < 30:
            continue
        win_top = top + int(band_h * WINDOW_TOP_FRACTION)
        win_bot = top + int(band_h * WINDOW_BOT_FRACTION)
        if win_bot - win_top < 12:
            continue
        # Place WINDOWS_PER_FLOOR windows evenly across the width.
        usable = W - 2 * SIDE_INSET_PX
        slot = usable / WINDOWS_PER_FLOOR
        for i in range(WINDOWS_PER_FLOOR):
            x0 = int(SIDE_INSET_PX + i * slot + H_GAP_PX)
            x1 = int(SIDE_INSET_PX + (i + 1) * slot - H_GAP_PX)
            if x1 - x0 < 12:
                continue
            rects.append((x0, win_top, x1, win_bot))

    print(f"rectangles: {len(rects)}")

    # Emit V in UV space (bottom-up): v0 < v1, both flipped from image-space y.
    out = [{
        "u0": round(x0 / W, 5),
        "v0": round(1.0 - y1 / H, 5),
        "u1": round(x1 / W, 5),
        "v1": round(1.0 - y0 / H, 5),
    } for (x0, y0, x1, y1) in rects]

    OUT_JSON.write_text(json.dumps({"texture": SRC.name, "width": W, "height": H, "rects": out}, indent=2))
    print(f"wrote {OUT_JSON}")

    # Preview
    preview = img.copy()
    draw = ImageDraw.Draw(preview)
    for (x0, y0, x1, y1) in rects:
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 50, 50), width=2)
    for y in seps:
        draw.line([(0, y), (W, y)], fill=(50, 220, 80), width=1)
    OUT_PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    preview.save(OUT_PREVIEW)
    print(f"wrote {OUT_PREVIEW}")

if __name__ == "__main__":
    main()
