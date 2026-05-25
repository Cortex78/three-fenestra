"""
Analyze an interior-mapping atlas to derive shader params (backScale, depth).

Per cell:
  1. Detect the inner rectangle that is the back wall, using Hough lines
     restricted to near-horizontal and near-vertical edges, then symmetric
     pairing around the cell center.
  2. f = back_wall_width / cell_width  →  backScale.
  3. Under the "rooms are roughly cubical (depth_3d ≈ width_3d)" assumption,
     FOV is determined: tan(FOV/2) = (1 - f) / (2 * f).
     This is the natural framing for interior renders and is what breaks the
     1-point-perspective FOV ambiguity.
  4. From f and FOV we derive depth in the shader's normalized units.

Run:  python3 tools/analyze_atlas.py textures/rooms.jpg 4 4
"""

import sys, math
from pathlib import Path
import cv2
import numpy as np


def detect_back_wall_fraction(cell: np.ndarray) -> float | None:
    h, w = cell.shape[:2]
    cx, cy = w / 2, h / 2

    gray = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(gray, 40, 120)

    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi / 180, threshold=30,
        minLineLength=int(min(w, h) * 0.18),
        maxLineGap=8,
    )
    if lines is None:
        return None

    vert_xs: list[float] = []   # x of near-vertical segments
    horiz_ys: list[float] = []  # y of near-horizontal segments
    for x1, y1, x2, y2 in lines[:, 0]:
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy)
        if length < 1:
            continue
        # Angle from horizontal in degrees
        ang = abs(math.degrees(math.atan2(dy, dx)))
        if ang > 90:
            ang = 180 - ang
        if ang > 80:           # vertical-ish
            vert_xs.append((x1 + x2) / 2)
        elif ang < 10:         # horizontal-ish
            horiz_ys.append((y1 + y2) / 2)

    # Find best symmetric pair of vertical lines around cx
    def best_pair(positions: list[float], center: float, span: float) -> float | None:
        lefts  = [p for p in positions if center - p > span * 0.10]
        rights = [p for p in positions if p - center > span * 0.10]
        best, best_score = None, 1e9
        for L in lefts:
            for R in rights:
                asym = abs((center - L) - (R - center))
                width = R - L
                frac = width / span
                if not (0.25 <= frac <= 0.85):
                    continue
                # Reward symmetry; lightly reward plausible fractions in 0.4–0.7.
                score = asym + 0.4 * abs(frac - 0.55) * span
                if score < best_score:
                    best_score, best = score, frac
        return best

    f_h = best_pair(vert_xs, cx, w)
    f_v = best_pair(horiz_ys, cy, h)
    if f_h is None and f_v is None:
        return None
    if f_h is None:
        return f_v
    if f_v is None:
        return f_h
    return (f_h + f_v) / 2


def analyze_atlas(path: Path, cols: int, rows: int) -> None:
    img = cv2.imread(str(path))
    if img is None:
        raise SystemExit(f"could not read {path}")
    H, W = img.shape[:2]
    cw, ch = W // cols, H // rows

    fs: list[tuple[int, int, float]] = []
    for r in range(rows):
        for c in range(cols):
            cell = img[r*ch:(r+1)*ch, c*cw:(c+1)*cw]
            f = detect_back_wall_fraction(cell)
            if f is not None:
                fs.append((r, c, f))

    print(f"\n=== {path.name} ({cols}×{rows}, cell {cw}×{ch}) ===")
    print(f"  cells with detectable back wall: {len(fs)} / {cols*rows}")
    if not fs:
        return
    print(f"  per-cell f (back-wall fraction):")
    for r in range(rows):
        row_vals = [f"{f:.2f}" if (r, c, f) in fs else " -- "
                    for c in range(cols)
                    for f in [next((x[2] for x in fs if x[0]==r and x[1]==c), None)]
                    if True]
        # Print neatly
        cells = []
        for c in range(cols):
            match = next((x[2] for x in fs if x[0]==r and x[1]==c), None)
            cells.append(f"{match:.2f}" if match is not None else " -- ")
        print(f"    row {r}: " + "  ".join(cells))

    vals = np.array([x[2] for x in fs])
    f_mean = float(np.mean(vals))
    f_med  = float(np.median(vals))
    f_std  = float(np.std(vals))

    print(f"\n  f stats:  mean={f_mean:.3f}  median={f_med:.3f}  std={f_std:.3f}")

    # FOV under the cubical-room (depth==width) assumption:
    #   tan(FOV/2) = (1 - f) / (2 * f)
    # And then depth_shader = (1 - f) / (2 * f * tan(FOV/2)) = 1.0  by construction.
    # So for any f, the cubical-room depth in shader units is exactly 1.0.
    # That's a consequence of choosing depth_3d = width_3d.
    # The shader's `depth` in code is the ratio depth_3d / width_3d, so cubical → 1.0.
    # But the "physical" feel depends on how deep we *want* the room to be.
    # We report several depth options for clarity.
    f = f_med
    print(f"\n  → backScale = {f:.2f}  (use median)")
    print(f"\n  depth, given assumed FOV:")
    for theta in (40, 45, 50, 53.13, 55, 60, 65):
        d = (1 - f) / (2 * f * math.tan(math.radians(theta / 2)))
        marker = "  ← cubical room (depth=width)" if abs(theta - 53.13) < 0.1 else ""
        print(f"    FOV {theta:>5.1f}°  →  depth = {d:.3f}{marker}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    analyze_atlas(Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]))
