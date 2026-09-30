"""
Render the NCLEX infant growth-trend chart deterministically.

The image model was asked for this chart and produced one whose weight points sat below their
labels, which makes the figure unreadable for a question that turns on which percentiles the
weight line crosses. That is not a prompting problem. The specification already gave every
vertex by coordinate — weight 50, 50, 25, 10, 5 at ages 2 to 10 months, with length and head
circumference flat at 50 — and a diffusion model does not plot coordinates. The same failure
produced a rhythm strip that ignored an equally exact specification.

A chart with known data points should be drawn by arithmetic, not generated. Every marker and
label here is placed from the data, so they cannot drift apart.

Two things the specification did not resolve, handled here:
  - Length and head circumference are both flat at the 50th percentile, so they occupy identical
    pixels. The head-circumference series is dashed and drawn last, so it reads as a dashed green
    line over the solid blue one and both remain visible.
  - Their value labels would collide for the same reason, so length is labelled below its markers
    and head circumference above.

Writes a PNG. No new dependencies: PIL only.
"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1100, 720
L, R, T, B = 130, 1040, 96, 590          # plot area
AGE_MIN, AGE_MAX = 2, 10
PCT_MIN, PCT_MAX = 0, 100

WEIGHT = [(2, 50), (4, 50), (6, 25), (8, 10), (10, 5)]
LENGTH = [(2, 50), (4, 50), (6, 50), (8, 50), (10, 50)]
HEAD   = [(2, 50), (4, 50), (6, 50), (8, 50), (10, 50)]

RED, BLUE, GREEN = (200, 30, 30), (30, 70, 190), (20, 130, 60)
INK, GRID, MUTED = (20, 20, 20), (218, 218, 218), (110, 110, 110)


def font(size, bold=False):
    for path in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold
                 else "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/System/Library/Fonts/Helvetica.ttc",
                 "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


F_TITLE, F_AXIS, F_TICK, F_VAL, F_LEG = font(26, True), font(19, True), font(17), font(16, True), font(18)


def x_of(age):
    return L + (age - AGE_MIN) / (AGE_MAX - AGE_MIN) * (R - L)


def y_of(pct):
    return B - (pct - PCT_MIN) / (PCT_MAX - PCT_MIN) * (B - T)


def centre(d, text, f, cx, y, fill=INK):
    w = d.textbbox((0, 0), text, font=f)[2]
    d.text((cx - w / 2, y), text, font=f, fill=fill)


def dashed(d, p0, p1, colour, width=3, dash=11, gap=8):
    import math
    x0, y0 = p0
    x1, y1 = p1
    total = math.hypot(x1 - x0, y1 - y0)
    if total == 0:
        return
    ux, uy = (x1 - x0) / total, (y1 - y0) / total
    pos = 0.0
    while pos < total:
        seg = min(dash, total - pos)
        d.line([(x0 + ux * pos, y0 + uy * pos),
                (x0 + ux * (pos + seg), y0 + uy * (pos + seg))], fill=colour, width=width)
        pos += dash + gap


def marker(d, kind, x, y, colour, r=7):
    if kind == "circle":
        d.ellipse([x - r, y - r, x + r, y + r], fill=colour, outline=(255, 255, 255), width=2)
    elif kind == "square":
        d.rectangle([x - r, y - r, x + r, y + r], fill=colour, outline=(255, 255, 255), width=2)
    else:  # triangle
        d.polygon([(x, y - r - 1), (x - r - 1, y + r), (x + r + 1, y + r)],
                  fill=colour, outline=(255, 255, 255))


img = Image.new("RGB", (W, H), (255, 255, 255))
d = ImageDraw.Draw(img)

centre(d, "Infant Growth Trends From 2 to 10 Months", F_TITLE, W / 2, 34)

# Gridlines and y ticks at the percentile levels the question is read against.
for pct in (0, 5, 10, 25, 50, 75, 90, 100):
    y = y_of(pct)
    d.line([(L, y), (R, y)], fill=GRID, width=1)
    d.line([(L - 7, y), (L, y)], fill=INK, width=2)
    label = str(pct)
    w = d.textbbox((0, 0), label, font=F_TICK)[2]
    d.text((L - 14 - w, y - 9), label, font=F_TICK, fill=INK)

for age in (2, 4, 6, 8, 10):
    x = x_of(age)
    d.line([(x, T), (x, B)], fill=GRID, width=1)
    d.line([(x, B), (x, B + 7)], fill=INK, width=2)
    centre(d, str(age), F_TICK, x, B + 13)

d.line([(L, T), (L, B)], fill=INK, width=2)
d.line([(L, B), (R, B)], fill=INK, width=2)

centre(d, "Age (months)", F_AXIS, (L + R) / 2, B + 44)
# Vertical axis title, drawn rotated so it reads bottom-to-top.
lab = Image.new("RGBA", (260, 30), (255, 255, 255, 0))
ImageDraw.Draw(lab).text((0, 0), "Documented percentile", font=F_AXIS, fill=INK)
img.paste(lab.rotate(90, expand=True), (22, int((T + B) / 2) - 130), lab.rotate(90, expand=True))

# Series, drawn back to front. Length first, then head circumference dashed over it so both stay
# visible where they coincide, and weight LAST: all three sit at the 50th percentile at 2 and 4
# months, and the weight line is the one the question is read from, so its markers must not end up
# underneath the others at exactly the point a candidate checks where the decline begins.
for pts, colour, kind, dash_it in (
    (LENGTH, BLUE, "square", False),
    (HEAD, GREEN, "triangle", True),
    (WEIGHT, RED, "circle", False),
):
    xy = [(x_of(a), y_of(p)) for a, p in pts]
    for i in range(len(xy) - 1):
        if dash_it:
            dashed(d, xy[i], xy[i + 1], colour)
        else:
            d.line([xy[i], xy[i + 1]], fill=colour, width=3)
    for (x, y), (_, p) in zip(xy, pts):
        marker(d, kind, x, y, colour)

# Value labels, offset per series so the three do not collide where the lines coincide.
for (a, p) in WEIGHT:
    centre(d, str(p), F_VAL, x_of(a), y_of(p) - 32, RED)
for (a, p) in LENGTH:
    centre(d, str(p), F_VAL, x_of(a), y_of(p) + 14, BLUE)
for (a, p) in HEAD:
    centre(d, str(p), F_VAL, x_of(a), y_of(p) - 32 - 22, GREEN)

# Legend
lx, ly = L + 16, T + 12
d.rectangle([lx - 10, ly - 10, lx + 330, ly + 92], fill=(252, 252, 252), outline=GRID, width=1)
for i, (name, colour, kind, dash_it) in enumerate((
    ("Weight percentile", RED, "circle", False),
    ("Length percentile", BLUE, "square", False),
    ("Head circumference percentile", GREEN, "triangle", True),
)):
    y = ly + i * 28 + 8
    if dash_it:
        dashed(d, (lx, y), (lx + 46, y), colour)
    else:
        d.line([(lx, y), (lx + 46, y)], fill=colour, width=3)
    marker(d, kind, lx + 23, y, colour)
    d.text((lx + 58, y - 11), name, font=F_LEG, fill=INK)

d.text((L, H - 42), "Percentile values are printed beside each marker.", font=F_TICK, fill=MUTED)

out = os.environ.get("OUT", "/tmp/qfix3/growth.png")
img.save(out, "PNG")
print(f"wrote {out} ({os.path.getsize(out)} bytes, {W}x{H})")
print("weight crosses:", " -> ".join(f"{p}th" for _, p in WEIGHT))
print("length flat at:", LENGTH[0][1], "| head circumference flat at:", HEAD[0][1])
