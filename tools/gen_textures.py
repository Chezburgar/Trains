#!/usr/bin/env python3
"""Generate all PNG textures for the Railway System add-on (stdlib only)."""
import os
import random
import struct
import zlib

random.seed(7)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RP = os.path.join(ROOT, "Trains_RP")
BP = os.path.join(ROOT, "Trains_BP")


def write_png(path, px):
    h, w = len(px), len(px[0])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("4B", *p) for p in row) for row in px
    )

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    hdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", hdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b"")
        )
    print("wrote", os.path.relpath(path, ROOT))


def canvas(w, h, color=(0, 0, 0, 0)):
    return [[tuple(color) for _ in range(w)] for _ in range(h)]


def clamp(v):
    return max(0, min(255, v))


def fill(px, x0, y0, x1, y1, c):
    for y in range(y0, y1):
        for x in range(x0, x1):
            px[y][x] = tuple(c)


def jitter(px, x0, y0, x1, y1, base, amt):
    for y in range(y0, y1):
        for x in range(x0, x1):
            d = random.randint(-amt, amt)
            px[y][x] = (clamp(base[0] + d), clamp(base[1] + d), clamp(base[2] + d), base[3])


# ---------------------------------------------------------------- blocks ----

def gravel_base(px):
    jitter(px, 0, 0, 16, 16, (108, 104, 98, 255), 10)


def draw_rails(px):
    # ties across the plate
    for ty in (2, 7, 12):
        jitter(px, 0, ty, 16, ty + 2, (92, 70, 48, 255), 8)
    # rails run along the texture's v axis (north-south)
    for rx in (3, 11):
        for y in range(16):
            px[y][rx] = (176, 180, 188, 255)
            px[y][rx + 1] = (140, 144, 152, 255)


def tex_track():
    px = canvas(16, 16)
    gravel_base(px)
    draw_rails(px)
    write_png(os.path.join(RP, "textures/blocks/track.png"), px)


def tex_station_track():
    px = canvas(16, 16)
    gravel_base(px)
    draw_rails(px)
    for y in range(16):  # hazard-striped platform edges
        c = (232, 198, 40, 255) if (y // 2) % 2 == 0 else (30, 30, 30, 255)
        for x in (0, 1, 14, 15):
            px[y][x] = c
    write_png(os.path.join(RP, "textures/blocks/station_track.png"), px)


def tex_depot_track():
    px = canvas(16, 16)
    gravel_base(px)
    draw_rails(px)
    g = (60, 214, 92, 255)
    # chevron arrow pointing "north" (v=0) — the direction trains depart
    for i in range(4):  # arrow head
        for x in range(7 - i, 9 + i):
            px[2 + i][x] = g
    for y in range(6, 13):  # stem
        px[y][7] = g
        px[y][8] = g
    write_png(os.path.join(RP, "textures/blocks/depot_track.png"), px)


def tex_platform():
    px = canvas(16, 16)
    jitter(px, 0, 0, 16, 16, (168, 168, 162, 255), 6)
    for i in range(16):  # panel seams
        px[0][i] = (150, 150, 144, 255)
        px[15][i] = (140, 140, 134, 255)
        px[i][0] = (150, 150, 144, 255)
        px[i][15] = (140, 140, 134, 255)
    for _ in range(6):
        x, y = random.randint(2, 13), random.randint(2, 13)
        px[y][x] = (120, 120, 116, 255)
    write_png(os.path.join(RP, "textures/blocks/platform.png"), px)


def tex_screen():
    px = canvas(32, 32)
    fill(px, 0, 0, 32, 32, (66, 68, 74, 255))          # metal frame
    fill(px, 2, 2, 30, 30, (8, 12, 22, 255))           # dark display
    fill(px, 3, 3, 29, 8, (16, 42, 66, 255))           # header band
    fill(px, 4, 4, 14, 7, (90, 200, 255, 255))         # header "text"
    fill(px, 24, 4, 28, 7, (240, 210, 60, 255))        # clock
    for seg in ((4, 10), (13, 19), (21, 27)):          # row 1: green text
        fill(px, seg[0], 11, seg[1], 13, (70, 230, 110, 255))
    for seg in ((4, 12), (15, 25)):                    # row 2: white text
        fill(px, seg[0], 16, seg[1], 18, (210, 214, 220, 255))
    for seg in ((4, 9), (12, 20), (23, 27)):           # row 3: amber text
        fill(px, seg[0], 21, seg[1], 23, (240, 170, 60, 255))
    fill(px, 4, 26, 20, 28, (70, 230, 110, 255))       # ticker bar
    write_png(os.path.join(RP, "textures/blocks/screen_panel.png"), px)


def tex_escalator(name, arrow_up):
    px = canvas(16, 16)
    jitter(px, 0, 0, 16, 16, (138, 142, 148, 255), 6)
    for y in (1, 4, 7, 10, 13):  # step ribs
        for x in range(16):
            px[y][x] = (92, 96, 104, 255)
    for y in range(16):  # side rails
        px[y][0] = (70, 74, 82, 255)
        px[y][15] = (70, 74, 82, 255)
    c = (44, 208, 84, 255) if arrow_up else (240, 150, 40, 255)
    if arrow_up:
        for i in range(4):
            for x in range(7 - i, 9 + i):
                px[3 + i][x] = c
        for y in range(7, 13):
            px[y][7] = c
            px[y][8] = c
    else:
        for y in range(3, 9):
            px[y][7] = c
            px[y][8] = c
        for i in range(4):
            for x in range(4 + i, 12 - i):
                px[9 + i][x] = c
    write_png(os.path.join(RP, "textures/blocks/%s.png" % name), px)


# ----------------------------------------------------------------- train ----

def tex_train():
    px = canvas(128, 128)
    BLUE = (44, 84, 138, 255)
    LT = (200, 204, 208, 255)
    WHITE = (236, 238, 240, 255)
    SKIRT = (35, 38, 44, 255)
    SILVER = (168, 172, 178, 255)
    GLASS = (18, 26, 36, 255)
    CLEAR = (0, 0, 0, 0)

    # --- side band (0,0)-(96,28): windows are fully transparent ---
    fill(px, 0, 0, 96, 3, LT)
    fill(px, 0, 3, 96, 20, BLUE)
    fill(px, 0, 20, 96, 23, WHITE)
    fill(px, 0, 23, 96, 28, SKIRT)
    for wx in (4, 19, 34, 49, 64, 79):
        fill(px, wx, 5, wx + 12, 17, SILVER)   # frame
        fill(px, wx + 1, 6, wx + 11, 16, CLEAR)  # open window

    # --- end face (0,32)-(36,60) ---
    fill(px, 0, 32, 36, 35, LT)
    fill(px, 0, 35, 36, 52, BLUE)
    fill(px, 0, 52, 36, 55, WHITE)
    fill(px, 0, 55, 36, 60, SKIRT)
    fill(px, 3, 35, 33, 45, SILVER)
    fill(px, 4, 36, 32, 44, GLASS)
    fill(px, 3, 53, 7, 57, (250, 224, 90, 255))    # headlights
    fill(px, 29, 53, 33, 57, (250, 224, 90, 255))
    fill(px, 15, 56, 21, 60, (24, 26, 30, 255))    # coupler shadow

    # --- roof metal (96,0)-(120,24) ---
    jitter(px, 96, 0, 120, 24, (150, 154, 158, 255), 5)

    # --- dark underframe (96,64)-(120,88) ---
    jitter(px, 96, 64, 120, 88, (38, 40, 44, 255), 4)

    # --- roof top with vents (64,64)-(96,112) ---
    jitter(px, 64, 64, 96, 112, (134, 138, 144, 255), 4)
    for vy in (68, 84, 98):
        fill(px, 68, vy, 92, vy + 6, (102, 106, 112, 255))
        fill(px, 69, vy + 1, 91, vy + 5, (114, 118, 124, 255))

    write_png(os.path.join(RP, "textures/entity/train.png"), px)


def tex_blank():
    write_png(os.path.join(RP, "textures/entity/blank.png"), canvas(4, 4))


# ----------------------------------------------------------------- items ----

def tex_wand():
    px = canvas(16, 16)
    GOLD = (214, 176, 56, 255)
    DARK = (150, 116, 30, 255)
    for i in range(11):  # diagonal shaft
        x, y = 2 + i, 13 - i
        px[y][x] = GOLD
        px[y + 1][x] = DARK
    # sparkle tip
    for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
        px[2 + dy][13 + dx] = (140, 235, 255, 255)
    px[2][13] = (255, 255, 255, 255)
    # tiny rail glyph bottom-right
    for x in range(10, 15):
        px[14][x] = (120, 124, 132, 255)
    for x in (10, 12, 14):
        px[13][x] = (92, 70, 48, 255)
    write_png(os.path.join(RP, "textures/items/track_planner.png"), px)


# ------------------------------------------------------------------ icon ----

def pack_icon(path):
    W = 128
    px = canvas(W, W)
    for y in range(W):  # sky gradient
        t = y / W
        px[y] = [(clamp(int(120 + 90 * t)), clamp(int(180 + 40 * t)), 235, 255)] * W
    jitter(px, 0, 108, W, W, (95, 92, 88, 255), 8)  # ballast
    for rx in (30, 92):  # rails
        fill(px, rx, 108, rx + 6, W, (60, 62, 68, 255))
    BLUE = (44, 84, 138, 255)
    fill(px, 30, 24, 98, 32, (200, 204, 208, 255))  # roof
    fill(px, 30, 32, 98, 108, BLUE)                 # body
    fill(px, 36, 38, 92, 62, (168, 172, 178, 255))  # windshield frame
    fill(px, 38, 40, 90, 60, (18, 26, 36, 255))     # glass
    fill(px, 30, 78, 98, 86, (236, 238, 240, 255))  # stripe
    fill(px, 34, 90, 44, 100, (250, 224, 90, 255))  # headlights
    fill(px, 84, 90, 94, 100, (250, 224, 90, 255))
    fill(px, 30, 100, 98, 108, (35, 38, 44, 255))   # skirt
    write_png(path, px)


if __name__ == "__main__":
    tex_track()
    tex_station_track()
    tex_depot_track()
    tex_platform()
    tex_screen()
    tex_escalator("escalator_up", True)
    tex_escalator("escalator_down", False)
    tex_train()
    tex_blank()
    tex_wand()
    pack_icon(os.path.join(BP, "pack_icon.png"))
    pack_icon(os.path.join(RP, "pack_icon.png"))
