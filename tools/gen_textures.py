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


def tex_track_corner():
    """Quarter-turn rails connecting the north edge to the east edge
    (arc centred on the NE corner), matching the straight rail offsets."""
    import math
    px = canvas(16, 16)
    gravel_base(px)
    # curved ties (radial dashes between the rails)
    for y in range(16):
        for x in range(16):
            r = math.hypot(15.5 - (x + 0.5), y + 0.5 - 0.5)
            if 5.5 < r < 10.5 and int(math.degrees(math.atan2(y + 0.5, 15.5 - x - 0.5)) / 18) % 2 == 0:
                d = random.randint(-8, 8)
                px[y][x] = (clamp(92 + d), clamp(70 + d), clamp(48 + d), 255)
    # rails as two arcs (radii ~4 and ~11.5 from the NE corner)
    for y in range(16):
        for x in range(16):
            r = math.hypot(15.5 - (x + 0.5), y + 0.5)
            if 3.2 <= r <= 5.0 or 10.7 <= r <= 12.5:
                mid = (3.2 <= r <= 4.1) or (10.7 <= r <= 11.6)
                px[y][x] = (176, 180, 188, 255) if mid else (140, 144, 152, 255)
    write_png(os.path.join(RP, "textures/blocks/track_corner.png"), px)


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
    """32x32 atlas: (0,0)16x16 step top w/ arrow; (16,0)16x8 step riser ribs;
    (0,16)16x14 balustrade panel; (16,16)8x4 handrail rubber; (24,16)8x8 dark."""
    px = canvas(32, 32)
    # step top: brushed steel with lengthwise grooves
    jitter(px, 0, 0, 16, 16, (146, 150, 156, 255), 5)
    for x in range(1, 16, 2):
        for y in range(16):
            px[y][x] = (108, 112, 120, 255)
    # arrow shows travel: up-escalator carries toward +v, down toward -v
    c = (44, 208, 84, 255) if arrow_up else (240, 150, 40, 255)
    if arrow_up:  # points down-image (+v = uphill direction)
        for y in range(3, 9):
            px[y][7] = c
            px[y][8] = c
        for i in range(4):
            for x in range(4 + i, 12 - i):
                px[8 + i][x] = c
    else:  # points up-image (-v = downhill direction)
        for i in range(4):
            for x in range(7 - i, 9 + i):
                px[3 + i][x] = c
        for y in range(7, 13):
            px[y][7] = c
            px[y][8] = c
    # step riser: horizontal ribs
    jitter(px, 16, 0, 32, 8, (120, 124, 132, 255), 4)
    for y in (1, 3, 5):
        for x in range(16, 32):
            px[y][x] = (86, 90, 98, 255)
    # balustrade panel: smoked glass look with metal border
    fill(px, 0, 16, 16, 30, (96, 104, 116, 255))
    fill(px, 1, 17, 15, 29, (128, 140, 156, 255))
    fill(px, 2, 18, 14, 28, (110, 122, 140, 255))
    # handrail rubber
    fill(px, 16, 16, 24, 20, (28, 28, 32, 255))
    for x in range(16, 24, 2):
        px[17][x] = (48, 48, 54, 255)
    # dark metal
    jitter(px, 24, 16, 32, 24, (58, 60, 66, 255), 4)
    write_png(os.path.join(RP, "textures/blocks/%s.png" % name), px)


# ----------------------------------------------------------------- train ----

def tex_train():
    """Atlas for the hollow train model:
    A (0,0)84x8 lower side band | B (0,10)84x8 upper side band
    C (86,0)6x10 window pillar  | D (96,0)24x24 interior floor
    E (96,26)24x24 light metal  | F (96,64)24x24 dark underframe
    G (64,64)32x48 roof top     | H (0,32)36x24 end wall
    I (48,32)8x8 bench"""
    px = canvas(128, 128)
    BLUE = (44, 84, 138, 255)
    DBLUE = (34, 66, 110, 255)
    WHITE = (236, 238, 240, 255)
    LT = (200, 204, 208, 255)
    SKIRT = (35, 38, 44, 255)
    SILVER = (172, 176, 182, 255)
    GLASS = (16, 24, 34, 255)
    YELLOW = (250, 224, 90, 255)

    # A: lower side band — white stripe, blue livery, dark skirt
    fill(px, 0, 0, 84, 2, WHITE)
    fill(px, 0, 2, 84, 6, BLUE)
    for x in range(20, 84, 21):  # door seams
        for y in range(2, 6):
            px[y][x] = DBLUE
    fill(px, 0, 6, 84, 8, SKIRT)

    # B: upper side band — roofline trim + blue with destination dashes
    fill(px, 0, 10, 84, 12, LT)
    fill(px, 0, 12, 84, 18, BLUE)
    for x0 in (8, 36, 64):
        fill(px, x0, 14, x0 + 12, 16, (150, 200, 255, 255))

    # C: window pillar — brushed silver with darker edges
    fill(px, 86, 0, 92, 10, SILVER)
    for y in range(10):
        px[y][86] = (128, 132, 140, 255)
        px[y][91] = (128, 132, 140, 255)

    # D: interior floor — light grey with darker walk strip
    jitter(px, 96, 0, 120, 24, (152, 150, 146, 255), 5)
    jitter(px, 104, 0, 112, 24, (128, 126, 122, 255), 4)

    # E: light metal (roof sides, ceiling, interior end walls)
    jitter(px, 96, 26, 120, 50, (168, 172, 176, 255), 4)

    # F: dark underframe
    jitter(px, 96, 64, 120, 88, (38, 40, 44, 255), 4)

    # G: roof top with AC vents
    jitter(px, 64, 64, 96, 112, (134, 138, 144, 255), 4)
    for vy in (68, 84, 98):
        fill(px, 68, vy, 92, vy + 6, (102, 106, 112, 255))
        fill(px, 69, vy + 1, 91, vy + 5, (114, 118, 124, 255))

    # H: end wall — destination sign, windshield, headlights
    fill(px, 0, 32, 36, 56, BLUE)
    fill(px, 9, 33, 27, 36, (10, 14, 20, 255))       # destination screen
    fill(px, 11, 34, 17, 35, (70, 230, 110, 255))    # green text
    fill(px, 19, 34, 25, 35, (70, 230, 110, 255))
    fill(px, 3, 37, 33, 47, SILVER)                  # windshield frame
    fill(px, 4, 38, 32, 46, GLASS)
    fill(px, 6, 39, 30, 41, (40, 60, 84, 255))       # glass reflection
    fill(px, 0, 48, 36, 50, WHITE)                   # stripe
    fill(px, 2, 51, 6, 54, YELLOW)                   # headlights
    fill(px, 30, 51, 34, 54, YELLOW)
    px[54][3] = (220, 60, 50, 255)                   # red marker lights
    px[54][32] = (220, 60, 50, 255)
    fill(px, 0, 55, 36, 56, SKIRT)

    # I: bench — blue plastic
    fill(px, 48, 32, 56, 40, (60, 100, 170, 255))
    fill(px, 48, 32, 56, 33, (96, 140, 210, 255))
    for y in range(32, 40):
        px[y][48] = (40, 72, 130, 255)

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


def tex_tunnel_maker():
    px = canvas(16, 16)
    STEEL = (150, 154, 162, 255)
    DARK = (90, 94, 102, 255)
    YELLOW = (230, 180, 40, 255)
    # drill body: yellow housing bottom-left
    fill(px, 1, 10, 7, 15, YELLOW)
    fill(px, 2, 11, 6, 14, (250, 205, 70, 255))
    px[15][2] = DARK  # grip
    px[15][5] = DARK
    # drill shaft to top-right
    for i in range(7):
        x, y = 6 + i, 10 - i
        px[y][x] = STEEL
        px[y + 1][x] = DARK
    # cone bit
    px[3][13] = STEEL
    px[2][13] = STEEL
    px[3][14] = DARK
    px[1][14] = (210, 214, 220, 255)
    px[2][14] = STEEL
    px[1][15] = (240, 244, 248, 255)
    # rock chips
    for cx, cy in ((11, 1), (14, 5), (9, 3)):
        px[cy][cx] = (128, 128, 128, 255)
    write_png(os.path.join(RP, "textures/items/tunnel_maker.png"), px)


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
    tex_track_corner()
    tex_station_track()
    tex_depot_track()
    tex_platform()
    tex_screen()
    tex_escalator("escalator_up", True)
    tex_escalator("escalator_down", False)
    tex_train()
    tex_blank()
    tex_wand()
    tex_tunnel_maker()
    pack_icon(os.path.join(BP, "pack_icon.png"))
    pack_icon(os.path.join(RP, "pack_icon.png"))
