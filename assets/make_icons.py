#!/usr/bin/env python3
"""facebook-reader icon generator — original artwork, no Facebook mark.

Concept: an amber reading lens over a field of scrambled glyph strokes. Far from the lens the
strokes are randomly rotated (Facebook's obfuscation); close to it they straighten out, and inside
the lens they are clean lines of text (what the plugin returns).

    python3 assets/make_icons.py            writes assets/icon.svg, assets/icon-small.svg and every PNG

PNG targets:
    .claude-plugin/icon.png                              1024 px (plugin listing)
    plugins/facebook-reader/extension/icons/icon{16,32,48,128}.png

Needs Playwright + Chromium for rasterising (same one the test suite uses).
"""
import math, pathlib, random

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN = ROOT / 'plugins' / 'facebook-reader'

BG1, BG2 = '#18424f', '#0a2029'        # deep teal tile
GLYPH = '#86bccb'                       # scrambled strokes
PAPER, INK = '#f6f1e7', '#13313b'       # lens interior / text bars
AMBER1, AMBER2, ACCENT = '#f6b04a', '#d8802a', '#e8902e'

# lens geometry on the 512 grid (ring centre-line radius R, stroke SW)
CX, CY, R, SW = 226, 226, 124, 30
INNER = R - SW / 2


def header(extra=''):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="t">'
            '<title id="t">facebook-reader</title>' + extra)


def defs():
    return (f'<defs>'
            f'<linearGradient id="fbr-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{BG1}"/><stop offset="1" stop-color="{BG2}"/></linearGradient>'
            f'<linearGradient id="fbr-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{AMBER1}"/><stop offset="1" stop-color="{AMBER2}"/></linearGradient>'
            f'<linearGradient id="fbr-f" gradientUnits="userSpaceOnUse" x1="0" y1="76" x2="0" y2="462"><stop offset="0" stop-color="#6db8c9"/><stop offset="1" stop-color="#357a8c"/></linearGradient>'
            f'<clipPath id="fbr-tile"><rect width="512" height="512" rx="112"/></clipPath>'
            f'<clipPath id="fbr-glass"><circle cx="{CX}" cy="{CY}" r="{INNER}"/></clipPath>'
            f'</defs>')


def glyph_field(seed=7):
    """Jittered grid of short strokes; random angle far from the lens, horizontal next to it."""
    rnd = random.Random(seed)
    out = []
    step = 38
    for gy in range(-1, 15):
        for gx in range(-1, 15):
            x = gx * step + 12 + rnd.uniform(-9, 9)
            y = gy * step + 12 + rnd.uniform(-9, 9)
            d = math.hypot(x - CX, y - CY)
            if d < R + SW / 2 + 16:                      # hidden under / hugging the lens
                continue
            if x > 330 and y > 330 and math.hypot(x - 392, y - 392) < 70:   # handle zone
                continue
            order = max(0.0, 1 - (d - R) / 260)          # 1 near the lens, 0 far away
            ang = rnd.uniform(0, 180) * (1 - order) ** 1.4
            if rnd.random() < 0.5:
                ang = -ang
            kind = rnd.random()
            op = 0.22 + 0.5 * order + rnd.uniform(-0.04, 0.06)
            ln = rnd.uniform(11, 26)
            if kind < 0.62:                              # stroke
                dx, dy = math.cos(math.radians(ang)) * ln / 2, math.sin(math.radians(ang)) * ln / 2
                out.append(f'<path d="M{x - dx:.1f} {y - dy:.1f}L{x + dx:.1f} {y + dy:.1f}" opacity="{op:.2f}"/>')
            elif kind < 0.80:                            # dot
                out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.4" fill="{GLYPH}" stroke="none" opacity="{op:.2f}"/>')
            else:                                        # hook ("c"-like glyph fragment)
                r = ln * 0.38
                out.append(f'<path d="M{x + r:.1f} {y - r:.1f}A{r:.1f} {r:.1f} 0 1 0 {x + r:.1f} {y + r:.1f}" opacity="{op:.2f}" transform="rotate({ang:.0f} {x:.1f} {y:.1f})"/>')
    return f'<g fill="none" stroke="{GLYPH}" stroke-width="5.5" stroke-linecap="round" clip-path="url(#fbr-tile)">' + ''.join(out) + '</g>'


def lens(bars, handle_w=46, ring_w=SW, show_hl=True):
    ang = math.radians(45)
    sx, sy = CX + math.cos(ang) * (R + ring_w / 2 - 2), CY + math.sin(ang) * (R + ring_w / 2 - 2)
    ex, ey = CX + math.cos(ang) * (R + 128), CY + math.sin(ang) * (R + 128)
    g = [f'<g id="fbr-lens">',
         f'<circle cx="{CX + 9}" cy="{CY + 11}" r="{R + ring_w / 2}" fill="#000" opacity="0.22"/>',           # soft offset shadow
         f'<path d="M{sx + 9:.1f} {sy + 11:.1f}L{ex + 9:.1f} {ey + 11:.1f}" stroke="#000" stroke-opacity="0.22" stroke-width="{handle_w}" stroke-linecap="round" fill="none"/>',
         f'<path d="M{sx:.1f} {sy:.1f}L{ex:.1f} {ey:.1f}" stroke="url(#fbr-ring)" stroke-width="{handle_w}" stroke-linecap="round" fill="none"/>',
         f'<circle cx="{CX}" cy="{CY}" r="{INNER + 1}" fill="{PAPER}"/>',
         f'<g clip-path="url(#fbr-glass)">' + ''.join(bars) + '</g>']
    if show_hl:
        g.append(f'<path d="M{CX - INNER * 0.72:.1f} {CY - INNER * 0.30:.1f}A{INNER * 0.78:.1f} {INNER * 0.78:.1f} 0 0 1 {CX - INNER * 0.30:.1f} {CY - INNER * 0.72:.1f}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="7" stroke-linecap="round"/>')
    g.append(f'<circle cx="{CX}" cy="{CY}" r="{R}" fill="none" stroke="url(#fbr-ring)" stroke-width="{ring_w}"/>')
    g.append('</g>')
    return ''.join(g)


def f_letter(w=58):
    """A plain lowercase f behind the lens: stem + hook + crossbar, round caps, own proportions."""
    return (f'<g id="fbr-f" fill="none" stroke="url(#fbr-f)" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round">'
            f'<path d="M338 462V160C338 108 368 76 434 80"/><path d="M262 222H426"/></g>')


def bar(x, y, w, h, fill=INK):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h / 2}" fill="{fill}"/>'


def master():
    bars = [bar(146, 162, 158, 20), bar(146, 198, 118, 20, ACCENT), bar(146, 234, 160, 20), bar(146, 270, 96, 20)]
    return (header() + defs()
            + '<rect width="512" height="512" rx="112" fill="url(#fbr-bg)"/>'
            + glyph_field() + f_letter() + lens(bars)
            + '</svg>')


def small():
    """16–48 px: no glyph field, thicker ring and bars, three text lines."""
    bars = [bar(150, 168, 142, 32), bar(150, 222, 100, 32, ACCENT), bar(150, 276, 128, 32)]
    return (header() + defs()
            + '<rect width="512" height="512" rx="112" fill="url(#fbr-bg)"/>'
            + f_letter(66) + lens(bars, handle_w=62, ring_w=40, show_hl=False)
            + '</svg>')


def raster(svg_path, out, size):
    from playwright.sync_api import sync_playwright
    svg = pathlib.Path(svg_path).read_text(encoding='utf-8')
    sized = svg.replace('<svg ', '<svg width="%d" height="%d" ' % (size, size), 1)
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': size, 'height': size})
        pg.set_content('<html><body style="margin:0;background:transparent"><div style="width:%dpx;height:%dpx">%s</div></body></html>' % (size, size, sized))
        pg.screenshot(path=str(out), omit_background=True, clip={'x': 0, 'y': 0, 'width': size, 'height': size})
        b.close()


if __name__ == '__main__':
    here = pathlib.Path(__file__).resolve().parent
    (here / 'icon.svg').write_text(master(), encoding='utf-8')
    (here / 'icon-small.svg').write_text(small(), encoding='utf-8')
    (PLUGIN / '.claude-plugin').mkdir(exist_ok=True)
    icons = PLUGIN / 'extension' / 'icons'
    icons.mkdir(parents=True, exist_ok=True)
    raster(here / 'icon.svg', PLUGIN / '.claude-plugin' / 'icon.png', 1024)
    for s in (16, 32, 48):
        raster(here / 'icon-small.svg', icons / f'icon{s}.png', s)
    raster(here / 'icon.svg', icons / 'icon128.png', 128)
    print('icons written:', *(sorted(p.name for p in icons.glob('*.png'))), '+ .claude-plugin/icon.png')
