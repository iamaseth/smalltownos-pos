#!/usr/bin/env python3
"""Build a reusable restaurant menu photo library from CSV exports of staging tabs.

Usage:
  python3 scripts/backstreet_image_library.py --csv-dir ./menu-csv --out ./menu-images
  python3 scripts/backstreet_image_library.py --csv-dir ./menu-csv --out ./menu-images --download

Only Wikimedia Commons files with a recognized free/public-domain license are
accepted. All results are suggestions until a person checks dish accuracy.
Requires Python 3 standard library only.
"""
import argparse
import csv
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "BackStreetMenuLibrary/0.1 (restaurant menu image research)"}
GOOD_LICENSE = ("CC0", "PUBLIC DOMAIN", "CC BY", "CC-BY", "CC BY-SA", "CC-BY-SA")
BAD_TERMS = ("logo", "icon", "diagram", "illustration", "drawing", "map", "poster", "packaging")

def get_json(params):
    url = API + "?" + urlencode(params)
    with urlopen(Request(url, headers=HEADERS), timeout=25) as response:
        return json.load(response)

def clean(value):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", value or "")).strip()

def key(item):
    return re.sub(r"[^a-z0-9]+", " ", item.lower()).strip()

def commons_candidates(item):
    query = item.replace("&", "and")
    search = get_json({"action":"query","format":"json","generator":"search",
        "gsrsearch":f'filetype:bitmap {query} food',
        "gsrnamespace":6,"gsrlimit":12,"prop":"imageinfo",
        "iiprop":"url|mime|extmetadata","iiurlwidth":640})
    pages = search.get("query", {}).get("pages", {})
    choices = []
    words = set(key(item).split())
    for page in pages.values():
        title = page.get("title", "")
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata", {})
        license_name = clean(meta.get("LicenseShortName", {}).get("value", ""))
        if not any(license_name.upper().startswith(x) for x in GOOD_LICENSE):
            continue
        if info.get("mime", "") not in ("image/jpeg", "image/png", "image/webp"):
            continue
        if any(t in title.lower() for t in BAD_TERMS):
            continue
        score = len(words & set(key(title).split()))
        choices.append({"title":title, "url":info.get("thumburl") or info.get("url"),
            "source":info.get("descriptionurl"), "license":license_name,
            "license_url":clean(meta.get("LicenseUrl",{}).get("value","")),
            "artist":clean(meta.get("Artist",{}).get("value","")),
            "score":score})
    return sorted(choices, key=lambda c: c["score"], reverse=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--download", action="store_true")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted(args.csv_dir.glob("*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                name = (row.get("Item name") or "").strip()
                if name:
                    rows.append({"page":path.stem,"name":name,
                        "existing":(row.get("Approved image URL") or "").strip()})
    unique = {}
    for row in rows:
        unique.setdefault(key(row["name"]), row["name"])
    catalog = {}
    for index, (k, name) in enumerate(unique.items(), 1):
        existing = next((r["existing"] for r in rows if key(r["name"]) == k and r["existing"]), "")
        if existing:
            catalog[k] = {"item":name,"status":"existing_candidate","url":existing}
            continue
        try:
            candidates = commons_candidates(name)
            catalog[k] = {"item":name,"status":"review_required" if candidates else "no_match",
                "candidates":candidates[:3], "url":candidates[0]["url"] if candidates else ""}
        except Exception as exc:
            catalog[k] = {"item":name,"status":"search_error","error":str(exc)}
        print(f"{index}/{len(unique)} {name}: {catalog[k]['status']}", flush=True)
        time.sleep(0.35)
    (args.out/"catalog.json").write_text(json.dumps(catalog, indent=2, ensure_ascii=False))
    with (args.out/"menu-image-review.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["page","item","image_url","status","source","license","artist"])
        writer.writeheader()
        for row in rows:
            entry = catalog[key(row["name"])]
            top = (entry.get("candidates") or [{}])[0]
            writer.writerow({"page":row["page"],"item":row["name"],"image_url":entry.get("url",""),
                "status":entry["status"],"source":top.get("source",""),
                "license":top.get("license",""),"artist":top.get("artist","")})
    if args.download:
        folder = args.out/"photos"
        folder.mkdir(exist_ok=True)
        for k, entry in catalog.items():
            url = entry.get("url", "")
            if not url or entry["status"] != "review_required":
                continue
            target = folder/(hashlib.sha256(k.encode()).hexdigest()[:16]+".jpg")
            try:
                with urlopen(Request(url,headers=HEADERS),timeout=30) as response:
                    data = response.read(8_000_001)
                if len(data) > 8_000_000:
                    continue
                target.write_bytes(data)
            except Exception as exc:
                print("download failed",entry["item"],exc)
    print(f"Saved {len(rows)} menu rows, {len(unique)} unique names to {args.out}")

if __name__ == "__main__":
    main()
