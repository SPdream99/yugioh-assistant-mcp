"""
Print-ready proxy sheet for Yu-Gi-Oh! cards.

Cards are drawn at the real OCG/TCG size (59 x 86 mm) on A4 portrait, 3 x 3 per
page, centred, with crop marks in the margins and a 50 mm scale bar so the
printout can be checked with a ruler. The PDF asks viewers not to scale it on
print (PrintScaling=None); the user must still print at "Actual size / 100%".

Card art comes from YGOPRODeck's image CDN (fixed host, integer passcode only)
and is cached. Cards without art (custom cards, offline, missing image) become
a clean text proxy: name, type line, stats and the full effect text.

Input is a JSON file written by proxy-pdf.ts; this script never builds a URL or
a path from free text.
"""

import argparse
import io
import json
import os
import sys
import urllib.request

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

CARD_W = 59 * mm
CARD_H = 86 * mm
COLS = 3
ROWS = 3
IMAGE_HOST = "https://images.ygoprodeck.com/images/cards/"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
CACHE_DIR = os.path.join(os.getcwd(), "data", "cache", "card_images_full")

FONT = "Helvetica"
FONT_BOLD = "Helvetica-Bold"


def register_unicode_font():
    """Vietnamese/accented names need a TTF; fall back to Helvetica when none exists."""
    global FONT, FONT_BOLD
    candidates = [
        (r"C:\Windows\Fonts\arial.ttf", r"C:\Windows\Fonts\arialbd.ttf"),
        (r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\segoeuib.ttf"),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
        ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ]
    for regular, bold in candidates:
        if os.path.exists(regular):
            try:
                pdfmetrics.registerFont(TTFont("ProxySans", regular))
                FONT = FONT_BOLD = "ProxySans"
                if os.path.exists(bold):
                    pdfmetrics.registerFont(TTFont("ProxySans-Bold", bold))
                    FONT_BOLD = "ProxySans-Bold"
                return
            except Exception:
                continue


def fetch_card_image(card_id, offline):
    """Returns a PIL image for an official passcode, or None. Never raises."""
    if not isinstance(card_id, int) or card_id <= 0 or card_id >= 990000000:
        return None
    os.makedirs(CACHE_DIR, exist_ok=True)
    cached = os.path.join(CACHE_DIR, f"{card_id}.jpg")
    if os.path.exists(cached):
        try:
            return Image.open(cached).convert("RGB")
        except Exception:
            os.remove(cached)
    if offline:
        return None
    try:
        req = urllib.request.Request(f"{IMAGE_HOST}{card_id}.jpg", headers={"User-Agent": "yugioh-assistant-mcp proxy sheet"})
        with urllib.request.urlopen(req, timeout=8) as response:
            data = response.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            return None
        image = Image.open(io.BytesIO(data))
        image.verify()  # reject anything that is not a real image before caching it
        image = Image.open(io.BytesIO(data)).convert("RGB")
        with open(cached, "wb") as handle:
            handle.write(data)
        return image
    except Exception:
        return None


def wrap_text(text, font, size, max_width):
    lines = []
    for paragraph in str(text or "").replace("\r", "").split("\n"):
        words = paragraph.split(" ")
        line = ""
        for word in words:
            candidate = f"{line} {word}".strip()
            if pdfmetrics.stringWidth(candidate, font, size) <= max_width:
                line = candidate
            else:
                if line:
                    lines.append(line)
                # A single word longer than the box is split by characters.
                while pdfmetrics.stringWidth(word, font, size) > max_width and len(word) > 1:
                    cut = len(word)
                    while cut > 1 and pdfmetrics.stringWidth(word[:cut], font, size) > max_width:
                        cut -= 1
                    lines.append(word[:cut])
                    word = word[cut:]
                line = word
        lines.append(line)
    return lines


def draw_text_proxy(c, x, y, card):
    pad = 3 * mm
    c.setStrokeColorRGB(0.15, 0.15, 0.15)
    c.setLineWidth(0.6)
    c.setFillColorRGB(0.97, 0.96, 0.93)
    c.rect(x, y, CARD_W, CARD_H, stroke=1, fill=1)
    c.setFillColorRGB(0.1, 0.1, 0.1)

    # Name, shrunk to fit one line.
    name = str(card.get("name") or f"Card {card.get('id')}")
    size = 9.5
    while size > 6 and pdfmetrics.stringWidth(name, FONT_BOLD, size) > CARD_W - 2 * pad:
        size -= 0.25
    c.setFont(FONT_BOLD, size)
    c.drawString(x + pad, y + CARD_H - pad - size, name[:80])

    top = y + CARD_H - pad - size - 2.2 * mm
    c.setFont(FONT, 6.5)
    for line in [card.get("statLine") or "", card.get("typeLine") or ""]:
        if line:
            c.drawString(x + pad, top, line[:90])
            top -= 3 * mm
    c.line(x + pad, top + 1.2 * mm, x + CARD_W - pad, top + 1.2 * mm)

    # Effect text: largest size that fits between the header and the footer.
    footer = card.get("footer") or ""
    bottom = y + pad + (4 * mm if footer else 0)
    available = top - bottom
    desc = card.get("desc") or ""
    body_size = 7.0
    while body_size > 4.2:
        lines = wrap_text(desc, FONT, body_size, CARD_W - 2 * pad)
        if len(lines) * body_size * 1.18 <= available:
            break
        body_size -= 0.2
    lines = wrap_text(desc, FONT, body_size, CARD_W - 2 * pad)
    c.setFont(FONT, body_size)
    cursor = top - body_size * 0.4
    for line in lines:
        if cursor - body_size < bottom:
            break
        c.drawString(x + pad, cursor - body_size, line)
        cursor -= body_size * 1.18

    if footer:
        c.setFont(FONT_BOLD, 7)
        c.drawRightString(x + CARD_W - pad, y + pad, footer)


def draw_crop_marks(c, xs, ys, grid_left, grid_right, grid_bottom, grid_top):
    """Short marks in the margins at every cut line, never over the cards."""
    length = 5 * mm
    offset = 1.5 * mm
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.25)
    for x in xs:
        c.line(x, grid_top + offset, x, grid_top + offset + length)
        c.line(x, grid_bottom - offset, x, grid_bottom - offset - length)
    for y in ys:
        c.line(grid_left - offset, y, grid_left - offset - length, y)
        c.line(grid_right + offset, y, grid_right + offset + length, y)


def draw_page_footer(c, page_w, page_no, page_count, margin_bottom):
    # 50 mm scale bar: measure it after printing to confirm 100% scale.
    y = max(margin_bottom / 2 - 1.5 * mm, 4 * mm)
    x = 15 * mm
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.5)
    c.line(x, y, x + 50 * mm, y)
    for tick in (0, 10, 20, 30, 40, 50):
        c.line(x + tick * mm, y, x + tick * mm, y + (2 * mm if tick % 50 == 0 else 1.2 * mm))
    c.setFont(FONT, 6)
    c.setFillColorRGB(0.3, 0.3, 0.3)
    c.drawString(x + 52 * mm, y - 0.8 * mm, "50 mm - print at Actual size / 100%")
    c.drawRightString(page_w - 15 * mm, y - 0.8 * mm, f"Proxy sheet - not for sale - page {page_no}/{page_count}")


def generate(spec_path, output_path):
    with open(spec_path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    cards = spec.get("cards", [])
    style = spec.get("style", "image")
    gap = max(0.0, min(float(spec.get("gapMm", 0)), 5.0)) * mm
    crop_marks = bool(spec.get("cropMarks", True))
    offline = bool(spec.get("offline", False))

    register_unicode_font()
    page_w, page_h = A4
    grid_w = COLS * CARD_W + (COLS - 1) * gap
    grid_h = ROWS * CARD_H + (ROWS - 1) * gap
    left = (page_w - grid_w) / 2
    bottom = (page_h - grid_h) / 2

    c = canvas.Canvas(output_path, pagesize=A4)
    c.setTitle(str(spec.get("title") or "Proxy sheet")[:120])
    c.setAuthor("yugioh-assistant-mcp")
    c.setCreator("yugioh-assistant-mcp proxy sheet")
    try:
        c.setViewerPreference("PrintScaling", "None")
    except Exception:
        pass

    per_page = COLS * ROWS
    page_count = max(1, (len(cards) + per_page - 1) // per_page)
    images_used = 0
    text_proxies = []
    image_cache = {}

    for page in range(page_count):
        batch = cards[page * per_page:(page + 1) * per_page]
        for index, card in enumerate(batch):
            col = index % COLS
            row = index // COLS
            x = left + col * (CARD_W + gap)
            y = bottom + grid_h - (row + 1) * CARD_H - row * gap
            image = None
            if style == "image" and not card.get("custom"):
                card_id = card.get("id")
                if card_id not in image_cache:
                    image_cache[card_id] = fetch_card_image(card_id, offline)
                image = image_cache[card_id]
            if image is not None:
                c.drawImage(ImageReader(image), x, y, width=CARD_W, height=CARD_H)
                images_used += 1
            else:
                draw_text_proxy(c, x, y, card)
                text_proxies.append(card.get("id"))

        if crop_marks:
            xs = sorted({left + i * (CARD_W + gap) for i in range(COLS)} | {left + i * (CARD_W + gap) + CARD_W for i in range(COLS)})
            ys = sorted({bottom + i * (CARD_H + gap) for i in range(ROWS)} | {bottom + i * (CARD_H + gap) + CARD_H for i in range(ROWS)})
            draw_crop_marks(c, xs, ys, left, left + grid_w, bottom, bottom + grid_h)
        draw_page_footer(c, page_w, page + 1, page_count, bottom)
        c.showPage()

    c.save()
    return {
        "success": True,
        "outputPath": output_path,
        "pages": page_count,
        "cards": len(cards),
        "imagesUsed": images_used,
        "textProxies": len(text_proxies),
        "textProxyIds": sorted({i for i in text_proxies if i is not None})[:50],
        "cardSizeMm": [59, 86],
        "pageSizeMm": [210, 297],
        "marginsMm": [round(left / mm, 2), round(bottom / mm, 2)],
        "gapMm": round(gap / mm, 2),
    }


def main():
    parser = argparse.ArgumentParser(description="Generate a Yu-Gi-Oh! proxy sheet (A4, real card size)")
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(generate(args.spec, args.output)))
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
