#!/usr/bin/env python3
"""
PDF -> paper.json  +  a list of exactly WHICH questions need a screenshot.

  pip install pdfplumber pypdfium2 pillow
  python scripts/pdf_to_paper.py "SSC-CGL-Paper.pdf" --title "SSC CGL 13 Sep 2025 Shift 1"

Creates the folder  build/<pdf-name>/
    paper.json    -> upload this in Admin > Papers (it carries the flags below)
    review.html   -> open in your browser: every question, answer, flags and crops side by side
    report.txt    -> the plain list of problems / flagged questions
    images/       -> a ready-made crop of every flagged question (whole question, answer line removed)

It reads the REAL layout of the PDF (not just text), so it can see:
    * tables / boxes / drawn diagrams       * pictures (figures, picture options)
    * stacked fractions & equations         * math fonts, superscripts / subscripts
and flags those questions. Two levels:
    NEEDS IMAGE  - text cannot be trusted -> attach a screenshot in the admin screen (import is blocked until you do)
    CHECK        - probably fine, but look (e.g. a square-root sign)
Nothing is guessed: unreadable questions are reported, never silently imported.
Option index convention everywhere: 0 = A (or 1), 1 = B (or 2), 2 = C (or 3), 3 = D (or 4).

TWO PDF LAYOUTS are understood (auto-detected, or force with --format letters|ticks):
  letters : "Q51. ... (a) .. (b) .. (c) .. (d) ..  Ans.(b)"   (answer typed as text)
  ticks   : "Q.1 ...  Ans 1. .. 2. .. 3. .. 4. .."            (answer = GREEN TICK picture next to the right option,
            RED CROSS next to the others; questions restart from Q.1 in every "Section : ..." block;
            comprehension passages sit above their questions). Options are numbered 1-4 in this layout,
            so the paper is imported with "option_style": "numbers" and candidates see buttons 1-2-3-4.
            The tick/cross pictures are read by COLOUR and are painted white in the crops (no answer leak).
"""
import argparse, html, json, os, re, statistics, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_pdf import ANS_RE, LETTERS, ans_index, find_options, missing_letters, parse_key  # noqa: E402

try:
    import pdfplumber
except ImportError:
    sys.exit("Install the tools first:  pip install pdfplumber pypdfium2 pillow")

ANS_LINE = re.compile(r"^\s*(?:correct\s+)?ans(?:wer)?\b", re.I)
SOL_LINE = re.compile(r"^\s*(?:sol(?:ution)?|explanation|exp)\s*[.:\-]", re.I)
KEY_LINE = re.compile(r"^\s*(?:final\s+)?answer\s*key\b", re.I)
MENTION = re.compile(r"\b(table|figure|diagram|graph|chart|pie|histogram|venn|caselet|image|picture|following data|data given|given data|shown in the)\b", re.I)
MATH_SYM = re.compile(r"[∑∫∏∠△∥⊥≈≠≤≥∞∂√∛∜°′″⁄½¼¾⅓⅔⅛]")
SUPER = re.compile(r"[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ₀₁₂₃₄₅₆₇₈₉]")
PUA = re.compile(r"[\uE000-\uF8FF\uFFFD]")
Q_DOT = re.compile(r"^\s*Q\.\s*(\d{1,3})\b\s*(.*)$")
SECTION_LINE = re.compile(r"^\s*Section\s*:\s*(.+?)\s*$", re.I)
PREAMBLE = re.compile(r"^\s*(?:Comprehension|Directions?)\s*:", re.I)
OPT_LINE = re.compile(r"^\s*(?:Ans\s+)?([1-4])\.\s*(.*)$", re.I)
ANS_WORD = re.compile(r"^\s*Ans\b", re.I)


def detect_bands(pdf, args):
    """Header/footer = the SAME logo or rule at the SAME place on most pages. Anything that appears on one page
    only is question content (so a figure or a box line at the top of a page is never mistaken for a header)."""
    n = len(pdf.pages)
    hdr, ftr = {}, {}
    for pi, page in enumerate(pdf.pages):
        W, H = page.width, page.height
        for im in page.images:
            w, h = im["x1"] - im["x0"], im["bottom"] - im["top"]
            if w < 0.12 * W or h >= 0.15 * H:  # tiny tick marks and big figures are never header logos
                continue
            key = ("i", round(im["x0"] / 6), round(w / 6), round(im["top"] / 6))
            if im["bottom"] < 0.22 * H:
                hdr.setdefault(key, {})[pi] = im["bottom"]
            elif im["top"] > 0.88 * H:
                ftr.setdefault(key, {})[pi] = im["top"]
        for o in list(page.rects) + list(page.lines):
            if (o["bottom"] - o["top"]) < 3 and (o["x1"] - o["x0"]) > 0.6 * W:
                key = ("l", round(o["top"] / 3))
                if o["top"] < 0.22 * H:
                    hdr.setdefault(key, {})[pi] = o["bottom"]
                elif o["top"] > 0.88 * H:
                    ftr.setdefault(key, {})[pi] = o["top"]
    need = max(2, int(0.4 * n + 0.5)) if n >= 2 else 10 ** 6
    bands = []
    for pi, page in enumerate(pdf.pages):
        hb, ft = 0.0, page.height
        for d in hdr.values():
            if len(d) >= need and pi in d:
                hb = max(hb, d[pi] + 1)
        for d in ftr.values():
            if len(d) >= need and pi in d:
                ft = min(ft, d[pi])
        if args.header_height is not None:
            hb = args.header_height
        if args.footer_height is not None:
            ft = page.height - args.footer_height
        bands.append((hb, ft))
    return bands


def detect_watermarks(pdf):
    """The watermark is the SAME big picture at the SAME place on (almost) every page. A big picture that appears on one
    page only (e.g. a table screenshot) is question content and must never be ignored."""
    n = len(pdf.pages)
    seen = {}
    for pi, page in enumerate(pdf.pages):
        W, H = page.width, page.height
        for im in page.images:
            if (im["x1"] - im["x0"]) * (im["bottom"] - im["top"]) > 0.08 * W * H:
                seen.setdefault((round(im["x0"] / 8), round(im["top"] / 8), round(im["x1"] / 8), round(im["bottom"] / 8)), set()).add(pi)
    need = max(2, int(0.4 * n + 0.5)) if n >= 2 else 10 ** 6
    return {k for k, v in seen.items() if len(v) >= need}


def invisible(o):
    """A white-filled shape with no outline is a layout cover, not something a reader can see."""
    col = o.get("non_stroking_color")
    white = col in ((1.0, 1.0, 1.0), (1, 1, 1), (1.0,), (1,), 1, 1.0) or (isinstance(col, (list, tuple)) and len(col) in (1, 3) and all(abs(v - 1) < 1e-3 for v in col))
    return bool(o.get("fill")) and not o.get("stroke") and white


def detect_format(pdf):
    """ticks = 'Q.1' anchors + tiny tick/cross pictures; otherwise the classic typed-answer layout."""
    q = icons = 0
    for page in pdf.pages[:4]:
        q += sum(1 for ln in page.extract_text_lines(return_chars=False) if Q_DOT.match(ln["text"]))
        icons += sum(1 for im in page.images if (im["x1"] - im["x0"]) <= 22 and (im["bottom"] - im["top"]) <= 22)
    return "ticks" if q >= 2 and icons >= 4 else "letters"


def load(pdf, args, strip_re, fmt):
    pages, items = [], []
    bands = detect_bands(pdf, args)
    wm = detect_watermarks(pdf)
    for pi, page in enumerate(pdf.pages):
        W, H = page.width, page.height
        hb, ft = bands[pi]
        single = len(pdf.pages) < 2  # one-page file: fall back to "very big picture = watermark"
        inside = lambda o: o["top"] >= hb - 0.5 and o["bottom"] <= ft + 0.5
        imgs, icons = [], []
        for o in page.images:
            if not inside(o):
                continue
            w, h = o["x1"] - o["x0"], o["bottom"] - o["top"]
            if (round(o["x0"] / 8), round(o["top"] / 8), round(o["x1"] / 8), round(o["bottom"] / 8)) in wm or (single and w * h >= 0.35 * W * H):
                continue
            if fmt == "ticks" and w <= 22 and h <= 22 and o["x1"] <= 0.2 * W:
                icons.append(o)  # the tick / cross marks next to the options
            else:
                imgs.append(o)
        gfx = []
        for o in list(page.rects) + list(page.lines) + list(page.curves):
            if not inside(o):
                continue
            w, h = o["x1"] - o["x0"], o["bottom"] - o["top"]
            if w > 0.85 * W or h > 0.5 * H:  # page frame, full-width separators, section bars
                continue
            if invisible(o):
                continue
            if fmt == "ticks" and o["x1"] <= 0.14 * W:  # the left "Ans" label column
                continue
            gfx.append(o)
        pages.append(dict(W=W, H=H, hb=hb, ft=ft, imgs=imgs, gfx=gfx, icons=icons))
        for ln in page.extract_text_lines(strip=True, return_chars=True):
            if ln["top"] < hb - 1 or ln["bottom"] > ft + 1:
                continue
            if strip_re.search(ln["text"]):
                continue
            items.append(dict(page=pi, top=ln["top"], bottom=ln["bottom"], x0=ln["x0"], x1=ln["x1"], text=ln["text"], chars=ln.get("chars", [])))
    return pages, items


def find_anchors(items, expected):
    """Question starts, using sequential numbering so numbers inside text are never mistaken for questions."""
    anchors, warnings, n, key_start = {}, [], 1, None
    start_re = lambda k: re.compile(r"^\s*(?:Q(?:uestion)?\.?\s*)?%d\s*[.):\-]\s*(.*)$" % k, re.I)
    for i, it in enumerate(items):
        if KEY_LINE.match(it["text"]):
            key_start = i
            break
        for k in (n, n + 1, n + 2):
            if k > expected:
                break
            if k > n:
                prev = anchors.get(n - 1)
                cur = "\n".join(x["text"] for x in items[prev:i]) if prev is not None else ""
                if not prev or not find_options(cur):
                    continue
            if start_re(k).match(it["text"]):
                for s in range(n, k):
                    warnings.append(f"Question {s}: start marker not found - check the PDF around this question.")
                anchors[k] = i
                n = k + 1
                break
    return anchors, warnings, key_start


def inside_rect(o, page, top, bottom):
    cy = (o["top"] + o["bottom"]) / 2
    return top <= cy <= bottom


def layout_flags(content, pieces, pages, qtext, opts):
    """What in this question's REAL layout cannot be trusted as text? Returns [(level, reason)]."""
    flags = []
    n_img = n_gfx = 0
    for p, top, bottom in pieces:
        pg = pages[p]
        n_img += sum(1 for o in pg["imgs"] if inside_rect(o, pg, top, bottom))
        n_gfx += sum(1 for o in pg["gfx"] if inside_rect(o, pg, top, bottom))
    if n_img:
        flags.append(("image", f"contains {n_img} picture(s) / figure(s)"))
    if n_gfx >= 3:
        flags.append(("image", "contains a table, box or drawn diagram"))
    elif n_gfx:
        flags.append(("check", "contains a few drawn lines (an UNDERLINED word? a box?) - plain text loses these, verify against the PDF"))

    chars = [c for it in content for c in it.get("chars", []) if c.get("text", "").strip()]
    if chars:
        base = statistics.mode(round(c["size"], 1) for c in chars)  # the usual text size
        small = [c for c in chars if c["size"] < 0.9 * base]
        if len(small) >= 8:
            flags.append(("image", "lots of small raised/lowered text (fraction or equation typed in small font)"))
        elif small:
            flags.append(("check", "superscript / subscript (like km2, x2, 5th) - the text may have lost it, verify"))
        if any(re.search(r"math|cmmi|cmsy|cmex|symbol", c.get("fontname", ""), re.I) for c in chars):
            flags.append(("image", "equation / math font"))
    for a_, b_ in zip(content, content[1:]):
        if a_["page"] == b_["page"]:
            ov = min(a_["bottom"], b_["bottom"]) - max(a_["top"], b_["top"])
            if ov > 0.35 * min(a_["bottom"] - a_["top"], b_["bottom"] - b_["top"]) and abs(a_["x0"] - b_["x0"]) < 200:
                flags.append(("image", "stacked lines of text (fraction or equation)"))
                break
    # borderless tables: several lines that are mostly numbers laid out in columns
    def tableish(t):
        toks = t.split()
        nums = sum(1 for x in toks if re.fullmatch(r"[\d.,%\u20b9$+\-:/]+", x))
        return (len(toks) >= 4 and nums >= 3 and nums >= 0.7 * len(toks)
                and not re.match(r"^\s*(?:Ans\s+)?(?:[(\[]?[a-dA-D][)\].]|[1-4]\.)", t))
    if sum(1 for c in content[1:] if tableish(c["text"])) >= 2:
        flags.append(("image", "rows of numbers laid out like a table (no borders drawn)"))
    alltext = qtext + "\n" + "\n".join(opts)
    if PUA.search(alltext):
        flags.append(("image", "unreadable / private-use characters (equation font)"))
    if MENTION.search(qtext):
        flags.append(("image", "mentions a table / figure / graph / data set"))
    if MATH_SYM.search(alltext):
        flags.append(("check", "contains math symbols (e.g. a root sign) - verify the text"))
    if SUPER.search(alltext):
        flags.append(("check", "contains superscript characters - verify"))
    return flags


def analyse(q, items, a, e, pages, expected_text_flags):
    """Everything about one question: text, answer, geometry pieces, and flags."""
    seg = items[a:e]
    cut, ans_line = len(seg), None
    for j, it in enumerate(seg):
        if j > 0 and (ANS_LINE.match(it["text"]) and ANS_RE.search(it["text"])):
            cut, ans_line = j, it
            break
        if j > 0 and SOL_LINE.match(it["text"]):
            cut = j
            break
    content = seg[:cut]
    text = "\n".join(c["text"] for c in content)
    text = re.sub(r"^\s*(?:Q(?:uestion)?\.?\s*)?\d+\s*[.):\-]\s*", "", text, count=1, flags=re.I)

    answer = None
    if ans_line:
        m = ANS_RE.search(ans_line["text"])
        answer = ans_index(m.group(1))
    else:  # answer printed on the same line as the options, or on a later line before the next question
        ms = list(ANS_RE.finditer("\n".join(x["text"] for x in seg)))
        if ms:
            answer = ans_index(ms[-1].group(1))
            text = ANS_RE.sub("", text) if ANS_RE.search(text) else text

    errors, flags = [], []
    found = find_options(text)
    if found:
        qtext = "\n".join(s.strip() for s in found[0].split("\n") if s.strip())
        opts = found[1]
        for i, o in enumerate(opts):
            if not o:
                errors.append(f"Question {q}: option {LETTERS[i]} is empty.")
                flags.append(("image", f"option {LETTERS[i]} is empty (probably a picture)"))
        if not qtext:
            errors.append(f"Question {q}: question text is empty.")
    else:
        miss = missing_letters(text)
        errors.append(f"Could not parse Question {q}. Possible reason: option marker{'s' if len(miss) > 1 else ''} {', '.join(miss)} missing.")
        flags.append(("image", f"options not detected (marker {', '.join(miss)} missing) - options may be pictures"))
        qtext, opts = text.strip(), ["", "", "", ""]

    # ---- pieces (page, top, bottom) covering the question across page breaks
    p0, p1 = content[0]["page"], content[-1]["page"] if content else seg[0]["page"]
    if ans_line:
        p1 = ans_line["page"]
    elif e < len(items):
        p1 = max(p1, items[e]["page"])
    pieces = []
    for p in range(p0, p1 + 1):
        pg = pages[p]
        top = items[a]["top"] - 3 if p == p0 else pg["hb"]
        if p == p1:
            if ans_line:
                bottom = ans_line["top"] - 2
            elif e < len(items) and items[e]["page"] == p:
                bottom = items[e]["top"] - 2
            else:
                bottom = pg["ft"]
        else:
            bottom = pg["ft"]
        if bottom > top:
            pieces.append((p, top, bottom))

    flags += layout_flags(content, pieces, pages, qtext, opts)
    if ans_line is None and answer is not None:
        flags.append(("check", "answer was not on its own line - the crop may show it"))

    # de-duplicate, keep order
    seen, uniq = set(), []
    for lv, why in flags:
        if why not in seen:
            seen.add(why)
            uniq.append({"level": lv, "reason": why})
    return dict(question_number=q, question_text=qtext, options=opts, correct_option=answer,
                page=p0 + 1, flags=uniq, _pieces=pieces), errors


def find_anchors_ticks(items, expected):
    """'Q.n' questions that restart in every 'Section :' block. Global number = running counter."""
    anchors, starts, secnames, sections, warnings = [], [], [], [], []
    cur_sec, last_local, pending = "", 0, None
    for i, it in enumerate(items):
        t = it["text"]
        ms = SECTION_LINE.match(t)
        if ms:
            cur_sec, last_local, pending = ms.group(1), 0, None
            sections.append([cur_sec, len(anchors) + 1, 0])
            continue
        if PREAMBLE.match(t) and pending is None:
            pending = i  # a comprehension passage belongs to the question that follows it
            continue
        m = Q_DOT.match(t)
        if m:
            local = int(m.group(1))
            if local != last_local + 1:
                warnings.append(f"Section '{cur_sec}': found Q.{local} after Q.{last_local} - check the PDF around there.")
            last_local = local
            anchors.append(i)
            starts.append(pending if pending is not None else i)
            secnames.append(cur_sec)
            pending = None
            if sections:
                sections[-1][2] += 1
    return anchors, starts, secnames, sections, warnings


def classify_icons(pages, scale):
    """Colour of every tick/cross picture (green = correct, red = wrong), then paint them white in the page render
    so they can never appear in a crop. Returns {page_index: PIL image}."""
    from PIL import ImageDraw
    renders = {}
    for p, pg in enumerate(pages):
        if not pg["icons"]:
            continue
        im = pg["_pdfium"].render(scale=scale).to_pil().convert("RGB")
        px = im.load()
        for ic in pg["icons"]:
            x0, y0, x1, y1 = [int(v * scale) for v in (ic["x0"], ic["top"], ic["x1"], ic["bottom"])]
            col = []
            for x in range(max(0, x0), min(im.width, x1 + 1)):
                for y in range(max(0, y0), min(im.height, y1 + 1)):
                    r, g, b = px[x, y]
                    if min(r, g, b) < 200 and (max(r, g, b) - min(r, g, b)) > 40:
                        col.append((r, g, b))
            kind = None
            if col:
                r = sum(c[0] for c in col) / len(col); g = sum(c[1] for c in col) / len(col)
                kind = "tick" if g > r + 15 else "cross" if r > g + 15 else None
            ic["kind"] = kind
        d = ImageDraw.Draw(im)
        for ic in pg["icons"]:
            d.rectangle([ic["x0"] * scale - 3, ic["top"] * scale - 3, ic["x1"] * scale + 3, ic["bottom"] * scale + 3], fill="white")
        renders[p] = im
    return renders


def analyse_ticks(g, items, anchors, starts, secnames, pages):
    """One question of the 'ticks' layout: text, 4 options, the answer (green tick), geometry, flags."""
    a, s = anchors[g - 1], starts[g - 1]
    e = starts[g] if g < len(starts) else len(items)
    seg = items[s:e]
    cut, sec_line = len(seg), None
    for j, it in enumerate(seg):
        if j > 0 and SECTION_LINE.match(it["text"]):
            cut, sec_line = j, it
            break
    content = seg[:cut]
    errors = []
    ai = next((j for j, it in enumerate(content) if j >= a - s and ANS_WORD.match(it["text"])), None)
    qlines = []
    for j, it in enumerate(content[: ai if ai is not None else len(content)]):
        t = it["text"]
        if s + j == a:
            t = Q_DOT.match(t).group(2)
        if t.strip():
            qlines.append(t.strip())
    qtext = "\n".join(qlines)
    opts, cur, markers = ["", "", "", ""], -1, [None] * 4
    for it in (content[ai:] if ai is not None else []):
        m = OPT_LINE.match(it["text"])
        if m and int(m.group(1)) == cur + 2:
            cur += 1
            opts[cur] = m.group(2).strip()
            markers[cur] = it
        elif cur >= 0:
            opts[cur] = (opts[cur] + " " + it["text"].strip()).strip()
    if ai is None:
        errors.append(f"Question {g}: no 'Ans' line found.")
    elif cur != 3:
        errors.append(f"Question {g}: found {cur + 1} option marker(s), expected 4 (1. 2. 3. 4.).")

    # geometry: the question's pieces across page breaks
    p0 = items[s]["page"]
    last_page = content[-1]["page"]
    if sec_line:
        p1 = max(last_page, sec_line["page"])
    elif e < len(items):
        p1 = max(last_page, items[e]["page"])
    else:
        p1 = last_page
    pieces = []
    for p in range(p0, p1 + 1):
        pg = pages[p]
        top = max(pg["hb"], items[s]["top"] - 3) if p == p0 else pg["hb"]
        if p == p1 and sec_line and sec_line["page"] == p:
            bottom = sec_line["top"] - 2
        elif p == p1 and not sec_line and e < len(items) and items[e]["page"] == p:
            bottom = items[e]["top"] - 2
        else:
            bottom = pg["ft"]
        if bottom > top:
            pieces.append((p, top, bottom))

    # the answer: read the colour of the 4 tick/cross pictures
    icons = []
    for p, top, bottom in pieces:
        pg = pages[p]
        icons += [(p, ic) for ic in pg["icons"] if inside_rect(ic, pg, top, bottom)]
    icons.sort(key=lambda t: (t[0], t[1]["top"]))
    answer = None
    if len(icons) == 4:
        order = [ic for _, ic in icons]
    else:
        order = []
        for k in range(4):
            mk = markers[k]
            near = [ic for p, ic in icons if mk and p == mk["page"] and abs((ic["top"] + ic["bottom"]) / 2 - (mk["top"] + mk["bottom"]) / 2) < 14]
            order.append(near[0] if len(near) == 1 else None)
    if any(ic is None for ic in order) or any(ic.get("kind") is None for ic in order):
        errors.append(f"Question {g}: could not read the green tick / red cross for every option ({len(icons)} mark(s) found).")
    else:
        ticks = [k for k, ic in enumerate(order) if ic["kind"] == "tick"]
        if len(ticks) == 1:
            answer = ticks[0]
        else:
            errors.append(f"Question {g}: expected exactly one green tick but found {len(ticks)}.")

    flags = []
    for k, o in enumerate(opts):
        if not o:
            flags.append(("image", f"option {k + 1} has no text (probably a picture)"))
    flags += layout_flags(content, pieces, pages, qtext, opts)
    seen, uniq = set(), []
    for lv, why in flags:
        if why not in seen:
            seen.add(why)
            uniq.append({"level": lv, "reason": why})
    ans_item = content[ai] if ai is not None else None
    return dict(question_number=g, question_text=qtext, options=opts, correct_option=answer, page=p0 + 1,
                section=secnames[g - 1], flags=uniq, _pieces=pieces,
                _ans=(ans_item["page"], ans_item["top"]) if ans_item else None), errors


def neutralize(img, y_from):
    """The PDF prints the RIGHT option in green and the wrong ones in red. Repaint red/green text below y_from in plain
    black (both colours get exactly the same treatment) so a crop can never reveal the answer by colour or by weight.
    The faint pink watermark is only desaturated, never darkened."""
    from PIL import Image, ImageChops
    if y_from >= img.height:
        return img
    part = img.crop((0, y_from, img.width, img.height))
    r, g, b = part.split()
    mn = ImageChops.darker(ImageChops.darker(r, g), b)
    mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
    sat = ImageChops.subtract(mx, mn)
    strong = sat.point(lambda v: 255 if v > 40 else 0)          # real coloured text (core + decent anti-aliasing)
    core = mn.point(lambda v: 255 if v < 170 else 0)            # dark enough to be text, not watermark
    for dom, other, fallback in ((r, g, 60), (g, r, 80)):       # red-dominant, then green-dominant
        cls = ImageChops.multiply(strong, ImageChops.subtract(dom, other).point(lambda v: 255 if v > 0 else 0))
        hist = mn.histogram(ImageChops.multiply(cls, core))
        total = sum(hist)
        full = fallback
        if total >= 20:
            acc = 0
            for v, c in enumerate(hist):
                acc += c
                if acc >= 0.05 * total:
                    full = v
                    break
        den = max(40, 255 - full)
        gray = mn.point(lambda v, d=den: 255 - max(0, min(255, int((255 - v) * 255 / d))))
        part = Image.composite(Image.merge("RGB", (gray, gray, gray)), part, cls)
    # whatever faint colour is left (anti-aliasing fringes, pink watermark): drop the hue, keep the lightness
    weak = ImageChops.multiply(sat.point(lambda v: 255 if 8 < v <= 40 else 0), Image.new("L", part.size, 255))
    r2, g2, b2 = part.split()
    avg = Image.eval(ImageChops.add(ImageChops.add(r2.point(lambda v: v // 3), g2.point(lambda v: v // 3)), b2.point(lambda v: v // 3)), lambda v: v)
    part = Image.composite(Image.merge("RGB", (avg, avg, avg)), part, weak)
    out = img.copy()
    out.paste(part, (0, y_from))
    return out


def make_crop(pieces, pages, renders, items_by_page, dpi, out_path, ans_pos=None):
    from PIL import Image
    scale = dpi / 72.0
    crops = []
    for p, top, bottom in pieces:
        pg = pages[p]
        xs0, xs1, ys0, ys1 = [], [], [], []
        for it in items_by_page[p]:
            if top <= (it["top"] + it["bottom"]) / 2 <= bottom:
                xs0.append(it["x0"]); xs1.append(it["x1"]); ys0.append(it["top"]); ys1.append(it["bottom"])
        for o in pg["imgs"] + pg["gfx"]:
            if inside_rect(o, pg, top, bottom):
                xs0.append(o["x0"]); xs1.append(o["x1"]); ys0.append(o["top"]); ys1.append(o["bottom"])
        if not xs0:
            continue
        pad = 6
        # vertical padding is clamped to the piece so the "Ans.(x)" line below can NEVER peek into the crop
        box = (max(0, min(xs0) - pad), max(top, min(ys0) - pad), min(pg["W"], max(xs1) + pad), min(bottom, max(ys1) + pad))
        if p not in renders:
            renders[p] = pg["_pdfium"].render(scale=scale).to_pil().convert("RGB")
        im = renders[p]
        c = im.crop(tuple(int(v * scale) for v in box))
        if ans_pos is not None:  # everything from the "Ans" line down is option area -> remove the green/red hint
            ap, at = ans_pos
            if p > ap:
                c = neutralize(c, 0)
            elif p == ap:
                c = neutralize(c, max(0, int((at - 1 - box[1]) * scale)))
        crops.append(c)
    if not crops:
        return False
    w, h = max(c.width for c in crops), sum(c.height for c in crops)
    sheet = Image.new("RGB", (w, h), "white")
    y = 0
    for c in crops:
        sheet.paste(c, (0, y)); y += c.height
    sheet.save(out_path, optimize=True)
    return True


def review_html(paper, folder):
    numbers = paper.get("option_style") == "numbers"
    lab = ["1", "2", "3", "4"] if numbers else list(LETTERS)
    rows = []
    for q in paper["questions"]:
        fl = "".join(f'<li class="{f["level"]}">{"NEEDS IMAGE" if f["level"] == "image" else "check"}: {html.escape(f["reason"])}</li>' for f in q["flags"])
        ans = lab[q["correct_option"]] if q["correct_option"] is not None else "?"
        img = f'<img src="{q["crop"]}">' if q.get("crop") else ""
        opts = "<br>".join(f"{lab[i]}) {html.escape(o)}" for i, o in enumerate(q["options"]))
        sec = f'<br><small>{html.escape(q["section"])}</small>' if q.get("section") else ""
        rows.append(f'<tr class="{"flag" if any(f["level"] == "image" for f in q["flags"]) else ""}"><td><b>Q{q["question_number"]}</b><br>p.{q["page"]}<br>Ans: <b>{ans}</b>{sec}</td>'
                    f'<td><ul>{fl}</ul>{img}</td><td>{html.escape(q["question_text"])}<br><br>{opts}</td></tr>')
    css = ("body{font-family:system-ui;margin:20px}table{border-collapse:collapse;width:100%}td{border:1px solid #ccc;padding:8px;vertical-align:top;font-size:14px}"
           "tr.flag{background:#fff6e0}img{max-width:560px;border:1px solid #bbb}li.image{color:#b00020;font-weight:600}li.check{color:#8a6d00}ul{padding-left:18px;margin:0 0 6px}")
    s = "".join(rows)
    open(os.path.join(folder, "review.html"), "w", encoding="utf-8").write(
        f"<!doctype html><meta charset=utf-8><title>Review</title><style>{css}</style><h2>{html.escape(paper['title'])}</h2>"
        f"<p>Highlighted rows need a screenshot. Compare each answer and text with the PDF.</p><table>{s}</table>")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--title", default=None)
    ap.add_argument("--out", default=None, help="output folder (default build/<pdf-name>)")
    ap.add_argument("--expected", type=int, default=100)
    ap.add_argument("--format", choices=["auto", "letters", "ticks"], default="auto", help="PDF layout (default: auto-detect)")
    ap.add_argument("--dpi", type=int, default=170, help="resolution of the crops")
    ap.add_argument("--no-crops", action="store_true", help="do not render crop images")
    ap.add_argument("--all-images", action="store_true", help="treat EVERY question as a screenshot (use for Hindi PDFs whose text comes out garbled): crops for all questions")
    ap.add_argument("--header-height", type=float, default=None, help="force header height in points (default: auto-detect a logo/rule repeated on most pages)")
    ap.add_argument("--footer-height", type=float, default=None)
    ap.add_argument("--strip", default=r"adda\s*247|get\s*it\s*on|google\s*play|telegram|join\s+our", help="regex of watermark/ad lines to ignore")
    args = ap.parse_args()

    strip_re = re.compile(args.strip, re.I)
    name = os.path.splitext(os.path.basename(args.pdf))[0]
    folder = args.out or os.path.join("build", name)
    os.makedirs(os.path.join(folder, "images"), exist_ok=True)
    for old in os.listdir(os.path.join(folder, "images")):  # never leave crops from an earlier run lying around
        if re.fullmatch(r"q\d{3}\.png", old):
            os.remove(os.path.join(folder, "images", old))
    scale = args.dpi / 72.0

    with pdfplumber.open(args.pdf) as pdf:
        fmt = detect_format(pdf) if args.format == "auto" else args.format
        print(f"Layout: {fmt}" + ("  (answers read from the green tick / red cross pictures)" if fmt == "ticks" else "  (answers read from the 'Ans.(x)' text or the answer key)"))
        pages, items = load(pdf, args, strip_re, fmt)
        if sum(len(i["text"]) for i in items) < 100:
            sys.exit("No text found - this looks like a scanned PDF. Run OCR first:  ocrmypdf in.pdf out.pdf")

        items_by_page = {}
        for it in items:
            items_by_page.setdefault(it["page"], []).append(it)
        renders = {}
        if fmt == "ticks" or not args.no_crops:
            try:
                import pypdfium2 as pdfium
                doc = pdfium.PdfDocument(args.pdf)
                for i, pg in enumerate(pages):
                    pg["_pdfium"] = doc[i]
            except ImportError:
                if fmt == "ticks":
                    sys.exit("This layout needs pypdfium2 to read the tick marks:  pip install pypdfium2 pillow")
                print("(pypdfium2 not installed - skipping crop images)")
                args.no_crops = True
        if fmt == "ticks":
            renders = classify_icons(pages, scale)

        questions, errors, warnings, sections = [], [], [], []
        if fmt == "ticks":
            anchors, starts, secnames, sections, warnings = find_anchors_ticks(items, args.expected)
            found = len(anchors)
            for q in range(1, args.expected + 1):
                if q > found:
                    errors.append(f"Could not parse Question {q}. Possible reason: the 'Q.n' marker was not found.")
                    questions.append(dict(question_number=q, question_text="", options=["", "", "", ""], correct_option=None, page=0,
                                          flags=[{"level": "image", "reason": "question not found in the PDF text"}], crop=None))
                    continue
                rec, errs = analyse_ticks(q, items, anchors, starts, secnames, pages)
                errors += errs
                if args.all_images:
                    rec["flags"].insert(0, {"level": "image", "reason": "all-images mode"})
                rec["crop"] = None
                if rec["flags"] and not args.no_crops:
                    path = os.path.join(folder, "images", f"q{q:03d}.png")
                    if make_crop(rec["_pieces"], pages, renders, items_by_page, args.dpi, path, ans_pos=rec.get("_ans")):
                        rec["crop"] = f"images/q{q:03d}.png"
                del rec["_pieces"]
                rec.pop("_ans", None)
                questions.append(rec)
            if args.expected == 100 and sections and any(c != 25 for _, _, c in sections):
                warnings.append("Subject sections are not 25 questions each (" + ", ".join(f"{n}: {c}" for n, _, c in sections) +
                                "). The exam's 4 timed sections are always questions 1-25, 26-50, 51-75, 76-100.")
        else:
            anchors, warnings, key_start = find_anchors(items, args.expected)
            found = len(anchors)
            end_all = key_start if key_start is not None else len(items)
            key = parse_key("\n".join(i["text"] for i in items[key_start:]) if key_start is not None else "", args.expected)
            order = sorted(anchors)
            for q in range(1, args.expected + 1):
                if q not in anchors:
                    errors.append(f"Could not parse Question {q}. Possible reason: the question number marker was not found.")
                    questions.append(dict(question_number=q, question_text="", options=["", "", "", ""], correct_option=key.get(q), page=0,
                                          flags=[{"level": "image", "reason": "question not found in the PDF text"}], crop=None))
                    continue
                a = anchors[q]
                nxt = [anchors[k] for k in order if k > q]
                e = nxt[0] if nxt else end_all
                rec, errs = analyse(q, items, a, e, pages, None)
                errors += errs
                if args.all_images:
                    rec["flags"].insert(0, {"level": "image", "reason": "all-images mode"})
                if rec["correct_option"] is None:
                    rec["correct_option"] = key.get(q)
                elif q in key and key[q] != rec["correct_option"]:
                    warnings.append(f"Question {q}: inline answer ({LETTERS[rec['correct_option']]}) differs from the answer key ({LETTERS[key[q]]}). Inline answer used - verify.")
                if rec["correct_option"] is None:
                    errors.append(f'Question {q}: answer not found (no "Ans" line and not in the answer key).')
                rec["crop"] = None
                if rec["flags"] and not args.no_crops:
                    path = os.path.join(folder, "images", f"q{q:03d}.png")
                    if make_crop(rec["_pieces"], pages, renders, items_by_page, args.dpi, path):
                        rec["crop"] = f"images/q{q:03d}.png"
                del rec["_pieces"]
                questions.append(rec)

    if found != args.expected:
        errors.insert(0, f"Detected {found} questions but expected {args.expected}.")
    title = args.title or name.replace("-", " ").replace("_", " ")
    paper = dict(title=title, description="", source_filename=os.path.basename(args.pdf), correct_marks=1, wrong_marks=0,
                 option_style="numbers" if fmt == "ticks" else "letters",
                 report=dict(errors=errors, warnings=warnings), questions=questions)
    json.dump(paper, open(os.path.join(folder, "paper.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    review_html(paper, folder)

    need = [q for q in questions if any(f["level"] == "image" for f in q["flags"])]
    chk = [q for q in questions if q["flags"] and q not in need]
    lines = [f"{os.path.basename(args.pdf)}: {found}/{args.expected} questions found, {len(errors)} problem(s), {len(warnings)} warning(s)"]
    if sections:
        lines.append("Sections: " + "; ".join(f"{n} = {c} questions" for n, _, c in sections))
    lines.append("")
    lines.append(f"NEEDS A SCREENSHOT ({len(need)}): " + (", ".join(f"Q{q['question_number']}" for q in need) or "none"))
    for q in need:
        lines.append(f"  Q{q['question_number']} (PDF page {q['page']}): " + "; ".join(f["reason"] for f in q["flags"]))
    lines += ["", f"CHECK THE TEXT ({len(chk)}): " + (", ".join(f"Q{q['question_number']}" for q in chk) or "none")]
    for q in chk:
        lines.append(f"  Q{q['question_number']} (PDF page {q['page']}): " + "; ".join(f["reason"] for f in q["flags"]))
    if errors or warnings:
        lines += ["", "PROBLEMS / WARNINGS:"] + [f"  - {x}" for x in errors + warnings]
    report = "\n".join(lines)
    open(os.path.join(folder, "report.txt"), "w", encoding="utf-8").write(report)
    print(report)
    print(f"\nOutput folder: {folder}\n  - open {os.path.join(folder, 'review.html')} in your browser to eyeball everything\n  - upload {os.path.join(folder, 'paper.json')} in Admin > Papers")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
