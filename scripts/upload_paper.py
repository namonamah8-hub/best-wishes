#!/usr/bin/env python3
"""
Upload a paper made by pdf_to_paper.py to your Best Wishes site - AUTOMATICALLY.

  python scripts/upload_paper.py build/<pdf-name> --site https://your-site.vercel.app
  python scripts/upload_paper.py build/<hindi-pdf-name> --site https://your-site.vercel.app --hindi-for <english-paper-id>

What it does (needs only Python - no extra packages):
  1. logs in to /admin with your admin username + password
       (taken from ADMIN_USERNAME / ADMIN_PASSWORD in your environment or .env.local, otherwise asked - never stored)
  2. imports paper.json  (refuses if a paper with the same title already exists - use --force to import anyway)
  3. attaches every crop in  images/qNNN.png  to question NNN as a "whole question" screenshot
  4. VERIFIES: downloads every stored screenshot back and compares it byte-for-byte with your local file
  5. writes  upload_report.txt  and  upload_report.csv  next to paper.json - your tracking sheet

Options:  --images all (default: every crop)  |  needed (only questions that cannot work as plain text)
          --paper-id <id>   re-run only the screenshots for an already-imported paper (e.g. after a network error)
"""
import argparse, csv, getpass, hashlib, http.cookiejar, json, os, re, sys, urllib.error, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    env = dict(os.environ)
    for path in (os.path.join(os.getcwd(), ".env.local"), os.path.join(HERE, "..", ".env.local")):
        if os.path.exists(path):
            for line in open(path, encoding="utf-8"):
                m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*?)\s*$", line)
                if m and m.group(1) not in env:
                    env[m.group(1)] = m.group(2).strip("'\"")
    return env


class Site:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, multipart=None, raw=False):
        headers, data = {"User-Agent": "best-wishes-uploader/1.0"}, None
        if body is not None:
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        if multipart is not None:
            headers["Content-Type"], data = multipart
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=120) as r:
                status, payload = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, payload = e.code, e.read()
        except urllib.error.URLError as e:
            return 0, {"message": f"cannot reach {self.base}: {e.reason}"}
        if raw:
            return status, payload
        try:
            return status, json.loads(payload.decode("utf-8"))
        except ValueError:
            return status, {"message": payload[:200].decode("utf-8", "replace")}


def multipart(fields, filename, content):
    boundary = "----bw" + uuid.uuid4().hex
    out = []
    for k, v in fields.items():
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n'.encode() + content + b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", b"".join(out)


def incomplete(q):
    opts = q.get("options") or []
    return not (q.get("question_text") or "").strip() or any(not ((opts[i] if i < len(opts) else "") or "").strip() for i in range(4))


def login(site, args, env):
    user = args.user or env.get("ADMIN_USERNAME") or "admin"
    pw = args.password or env.get("ADMIN_PASSWORD")
    for attempt in range(2):
        if not pw:
            try:
                pw = getpass.getpass(f"Admin password for {site.base}: ")
            except (EOFError, KeyboardInterrupt):
                return False
        st, d = site.call("POST", "/api/admin/login", {"username": user, "password": pw})
        if st == 200:
            return True
        print(f"  login failed ({d.get('message', st)})")
        pw = None
        if st == 0:
            return False
    return False


def run(folder, site_url, hindi_for=None, images="all", force=False, user=None, password=None, paper_id=None):
    args = argparse.Namespace(user=user, password=password)
    env = load_env()
    pj = os.path.join(folder, "paper.json")
    if not os.path.exists(pj):
        print(f"No paper.json in {folder}. Run pdf_to_paper.py first.")
        return 1
    paper = json.load(open(pj, encoding="utf-8"))
    qs = paper["questions"]
    lang = "hi" if hindi_for else "en"
    rep = paper.get("report", {})
    if rep.get("errors"):
        print(f"paper.json still has {len(rep['errors'])} unresolved parser problem(s); fix them first (see report.txt):")
        for e in rep["errors"][:10]:
            print("  -", e)
        return 1

    # ---- which crops go where
    wanted, missing = [], []
    for q in qs:
        must = incomplete(q) or any(f["level"] == "image" for f in q.get("flags", []))
        path = os.path.join(folder, q["crop"]) if q.get("crop") else None
        if path and os.path.exists(path) and (images == "all" or must):
            wanted.append((q, path))
        elif must:
            missing.append(q["question_number"])
    if missing:
        print(f"Q{', Q'.join(map(str, missing))} need a screenshot but no crop file exists (re-run pdf_to_paper.py without --no-crops).")
        return 1

    site = Site(site_url)
    print(f"Logging in to {site.base} ...")
    if not login(site, args, env):
        print("Could not log in.")
        return 1

    # ---- import (English) or attach Hindi text
    target = hindi_for or paper_id
    if hindi_for:
        print(f"Saving the Hindi text for paper {hindi_for} ...")
        body = {"paperId": hindi_for, "questions": [{k: q.get(k) for k in ("question_number", "question_text", "options", "correct_option")} for q in qs]}
        st, d = site.call("POST", "/api/admin/hindi", body)
        if st != 200:
            print(f"Hindi import refused: {d.get('message')}")
            for x in (d.get("details") or [])[:15]:
                print("  -", x)
            return 1
    elif not paper_id:
        st, d = site.call("GET", "/api/admin/papers")
        same = [p for p in (d.get("papers") or []) if p.get("title") == paper["title"]] if st == 200 else []
        if same and not force:
            print(f'A paper called "{paper["title"]}" already exists (id {same[0]["id"]}). Nothing was changed.')
            print("  - use --force to import another copy, or --paper-id " + same[0]["id"] + " to re-attach screenshots to that one.")
            return 1
        body = {k: paper.get(k) for k in ("title", "description", "source_filename", "correct_marks", "wrong_marks", "option_style")}
        body["questions"] = [dict({k: q.get(k) for k in ("question_number", "question_text", "options", "correct_option")}, needs_image=incomplete(q)) for q in qs]
        print("Importing the paper ...")
        st, d = site.call("POST", "/api/admin/papers", body)
        if st != 201:
            print(f"Import refused: {d.get('message')}")
            for x in (d.get("details") or [])[:15]:
                print("  -", x)
            return 1
        target = d["id"]
        print(f"  imported {d['questions']} questions, {d['sections']} sections  (paper id {target})")

    # ---- screenshots
    results = {}
    for k, (q, path) in enumerate(wanted, 1):
        n = q["question_number"]
        content = open(path, "rb").read()
        fields = {"paperId": target, "questionNumber": n, "whole": "true", "lang": lang}
        st, d = 0, {}
        for _ in range(2):  # one retry on a network hiccup
            st, d = site.call("POST", "/api/admin/questions/image", multipart=multipart(fields, os.path.basename(path), content))
            if st in (200, 409, 400, 404, 413):
                break
        results[n] = (st == 200, d.get("message", "") if st != 200 else "")
        print(f"  [{k:>2}/{len(wanted)}] Q{n:<3} {'uploaded' if st == 200 else 'FAILED: ' + str(d.get('message'))}")

    # ---- verify against the site (status + byte-for-byte)
    st, status = site.call("GET", f"/api/admin/papers/status?paper={target}")
    rows = {r["number"]: r for r in status.get("questions", [])} if st == 200 else {}
    verified = {}
    for q, path in wanted:
        n = q["question_number"]
        row = rows.get(n)
        ok_has = bool(row and (row["hasImageHi"] if lang == "hi" else row["hasImage"]))
        match = False
        if row and ok_has:
            s2, blob = site.call("GET", f"/api/admin/images/{row['id']}?lang={lang}", raw=True)
            match = s2 == 200 and hashlib.sha256(blob).hexdigest() == hashlib.sha256(open(path, "rb").read()).hexdigest()
        verified[n] = match

    # ---- readiness
    if lang == "hi":
        not_ready = [n for n, r in rows.items() if not r["hindiComplete"]]
    else:
        not_ready = [n for n, r in rows.items() if not (r["textComplete"] or (r["hasImage"] and r["imageWhole"]))]
    n_up = sum(1 for v in results.values() if v[0])
    n_ver = sum(1 for v in verified.values() if v)

    # ---- report
    lab = ["1", "2", "3", "4"] if paper.get("option_style") == "numbers" else list("ABCD")
    out = [f"UPLOAD REPORT - {paper['title']}" + (" (HINDI)" if lang == "hi" else ""), f"Site: {site.base}    Paper id: {target}",
           f"Screenshots: {len(wanted)} planned, {n_up} uploaded, {n_ver} verified identical to your local file, {len(wanted) - n_up} failed",
           f"Ready to schedule: {'YES' if not not_ready and rows else 'NO - still incomplete: Q' + ', Q'.join(map(str, not_ready))}", "",
           f"{'Q':<5}{'Section':<34}{'File':<12}{'KB':>5}  {'Upload':<8}{'Verified':<9}Why it has a screenshot"]
    csv_rows = [["question", "section", "file", "kb", "uploaded", "verified", "why", "correct_answer"]]
    for q, path in wanted:
        n = q["question_number"]
        why = "; ".join(f["reason"] for f in q.get("flags", []))[:70]
        kb = os.path.getsize(path) // 1024
        up = "OK" if results[n][0] else "FAILED"
        vf = "OK" if verified.get(n) else "NO"
        ans = lab[q["correct_option"]] if q.get("correct_option") is not None else "?"
        sec = (q.get("section") or "")[:32]
        out.append(f"Q{n:<4}{sec:<34}{os.path.basename(path):<12}{kb:>5}  {up:<8}{vf:<9}{why}")
        csv_rows.append([n, q.get("section", ""), os.path.basename(path), kb, up, vf, why, ans])
    plain = [q["question_number"] for q in qs if q["question_number"] not in {w[0]["question_number"] for w in wanted}]
    out += ["", f"Questions imported as plain text (no screenshot): {len(plain)}"]
    if plain:
        out.append("  Q" + ", Q".join(map(str, plain)))
    failed = [n for n, v in results.items() if not v[0]]
    if failed:
        out += ["", "FAILED uploads: Q" + ", Q".join(map(str, failed)), f"  retry with:  python scripts/upload_paper.py {folder} --site {site.base} --paper-id {target}"]
    open(os.path.join(folder, "upload_report.txt"), "w", encoding="utf-8").write("\n".join(out))
    with open(os.path.join(folder, "upload_report.csv"), "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(csv_rows)
    print("\n" + "\n".join(out[:4]))
    print(f"\nFull tracking sheet: {os.path.join(folder, 'upload_report.txt')}  (and .csv for Excel)")
    print(f"Open in admin: {site.base}/admin/papers/{target}")
    return 0 if (n_up == len(wanted) and n_ver == len(wanted) and not not_ready and rows) else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="build folder made by pdf_to_paper.py (contains paper.json and images/)")
    ap.add_argument("--site", required=True, help="your site, e.g. https://best-wishes-ten.vercel.app or http://localhost:3000")
    ap.add_argument("--hindi-for", default=None, metavar="PAPER_ID", help="this folder is the HINDI version of an already imported paper")
    ap.add_argument("--paper-id", default=None, help="skip the import; (re)attach screenshots to this existing paper")
    ap.add_argument("--images", choices=["all", "needed"], default="all")
    ap.add_argument("--force", action="store_true", help="import even if a paper with the same title exists")
    ap.add_argument("--user", default=None)
    ap.add_argument("--password", default=None, help="better: put ADMIN_PASSWORD in .env.local or type it when asked")
    a = ap.parse_args()
    sys.exit(run(a.folder, a.site, a.hindi_for, a.images, a.force, a.user, a.password, a.paper_id))


if __name__ == "__main__":
    main()
