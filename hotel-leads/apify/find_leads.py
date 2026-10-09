"""Find more Bangkok hotels that use Cloudbeds, via Apify (Google Maps) + website check.

  APIFY_TOKEN=... python3 apify/find_leads.py --districts all --max 40

1. Runs the Apify actor "compass/crawler-google-places" with searches like
   "hotel in Watthana Bangkok" for each district.
2. Opens every place's own website and looks for its booking engine
   (Cloudbeds reservation links, or another engine such as SiteMinder).
3. Adds each new Cloudbeds hotel to data/hotels.json and its phone/website to
   data/phones-apify.json, and writes every place it checked to
   data/apify-places.json and data/other-engines.csv.
Run build.py afterwards to refresh the page and spreadsheet.
"""
import argparse, csv, json, os, re, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
ACTOR = "compass~crawler-google-places"

# Bangkok's 50 districts: English (as Google writes it) -> Thai
KHET = {
    "Phra Nakhon": "พระนคร", "Dusit": "ดุสิต", "Nong Chok": "หนองจอก", "Bang Rak": "บางรัก", "Bang Khen": "บางเขน",
    "Bang Kapi": "บางกะปิ", "Pathum Wan": "ปทุมวัน", "Pom Prap Sattru Phai": "ป้อมปราบศัตรูพ่าย", "Phra Khanong": "พระโขนง",
    "Min Buri": "มีนบุรี", "Lat Krabang": "ลาดกระบัง", "Yan Nawa": "ยานนาวา", "Samphanthawong": "สัมพันธวงศ์", "Phaya Thai": "พญาไท",
    "Thon Buri": "ธนบุรี", "Bangkok Yai": "บางกอกใหญ่", "Huai Khwang": "ห้วยขวาง", "Khlong San": "คลองสาน", "Taling Chan": "ตลิ่งชัน",
    "Bangkok Noi": "บางกอกน้อย", "Bang Khun Thian": "บางขุนเทียน", "Phasi Charoen": "ภาษีเจริญ", "Nong Khaem": "หนองแขม",
    "Rat Burana": "ราษฎร์บูรณะ", "Bang Phlat": "บางพลัด", "Din Daeng": "ดินแดง", "Bueng Kum": "บึงกุ่ม", "Sathon": "สาทร",
    "Bang Sue": "บางซื่อ", "Chatuchak": "จตุจักร", "Bang Kho Laem": "บางคอแหลม", "Prawet": "ประเวศ", "Khlong Toei": "คลองเตย",
    "Suan Luang": "สวนหลวง", "Chom Thong": "จอมทอง", "Don Mueang": "ดอนเมือง", "Ratchathewi": "ราชเทวี", "Lat Phrao": "ลาดพร้าว",
    "Watthana": "วัฒนา", "Bang Khae": "บางแค", "Lak Si": "หลักสี่", "Sai Mai": "สายไหม", "Khan Na Yao": "คันนายาว",
    "Saphan Sung": "สะพานสูง", "Wang Thonglang": "วังทองหลาง", "Khlong Sam Wa": "คลองสามวา", "Bang Na": "บางนา",
    "Thawi Watthana": "ทวีวัฒนา", "Thung Khru": "ทุ่งครุ", "Bang Bon": "บางบอน",
}
ALIASES = {"Pathumwan": "Pathum Wan", "Sathorn": "Sathon", "Yannawa": "Yan Nawa", "Thonburi": "Thon Buri", "Vadhana": "Watthana",
           "Wattana": "Watthana", "Khlong Toei": "Khlong Toei", "Klong Toey": "Khlong Toei", "Bangrak": "Bang Rak", "Ratchatewi": "Ratchathewi",
           "Huaikhwang": "Huai Khwang", "Don Muang": "Don Mueang", "Bang Kapi": "Bang Kapi", "Lat Phrao": "Lat Phrao", "Ladprao": "Lat Phrao",
           "Phrakhanong": "Phra Khanong", "Bangna": "Bang Na", "Chatuchak": "Chatuchak", "Samphanthawong": "Samphanthawong"}

ENGINES = [  # (name, regex) – first match wins; Cloudbeds handled separately
    ("SiteMinder", r"book-directonline\.com|thebookingbutton\.com|siteminder"),
    ("Little Hotelier", r"littlehotelier\.com"),
    ("SynXis", r"synxis\.com"),
    ("TravelClick", r"travelclick\.com|ihotelier"),
    ("eZee", r"ipms247\.com|ezeetechnosys|live\.ipms"),
    ("STAAH", r"staah\.net|staah\.com"),
    ("Simple Booking", r"simplebooking\.it"),
    ("HotelRunner", r"hotelrunner\.com"),
    ("eviivo", r"eviivo\.com"),
    ("Hotelogix", r"hotelogix"),
    ("Mews", r"mews\.(?:li|com)"),
    ("Agoda YCS", r"ycs\.agoda\.com"),
]
CB_RE = re.compile(r"(?:hotels|us2|us1|eu1)?\.?cloudbeds\.com/(?:[a-z]{2}/)?reservation/([A-Za-z0-9]{5,8})")
UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"


def api(method, path, token, body=None):
    url = f"https://api.apify.com/v2{path}{'&' if '?' in path else '?'}token={token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def run_google_maps(token, districts, max_per, kinds):
    searches = [f"{k} in {d} Bangkok" for d in districts for k in kinds]
    inp = {"searchStringsArray": searches, "maxCrawledPlacesPerSearch": max_per, "language": "en",
           "countryCode": "th", "skipClosedPlaces": True}
    print(f"Apify: {len(searches)} searches x up to {max_per} places", flush=True)
    run = api("POST", f"/acts/{ACTOR}/runs", token, inp)["data"]
    rid, ds = run["id"], run["defaultDatasetId"]
    while True:
        time.sleep(20)
        st = api("GET", f"/actor-runs/{rid}", token)["data"]["status"]
        print("  run status:", st, flush=True)
        if st in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"): break
    if st != "SUCCEEDED": sys.exit(f"Apify run {st}")
    items, offset = [], 0
    while True:
        url = f"/datasets/{ds}/items?clean=true&format=json&limit=1000&offset={offset}"
        req = urllib.request.Request(f"https://api.apify.com/v2{url}&token={token}")
        with urllib.request.urlopen(req, timeout=120) as r:
            page = json.loads(r.read().decode())
        items += page; offset += len(page)
        if len(page) < 1000: break
    return items


def fetch(url, limit=600_000):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,th"})
        with urllib.request.urlopen(req, timeout=12) as r:
            return r.read(limit).decode("utf-8", "ignore"), r.geturl()
    except Exception:
        return "", url


def detect(site):
    """Return (engine, cloudbeds_code) for a hotel website."""
    html, final = fetch(site)
    if not html: return ("unreachable", None)
    pages = [html]
    # also open up to 2 "book now" pages on the site
    links = re.findall(r'href=["\']([^"\']+)["\']', html, re.I)
    book = [urllib.parse.urljoin(final, l) for l in links if re.search(r"book|reserv|จอง|availability", l, re.I)]
    for b in list(dict.fromkeys(book))[:2]:
        m = CB_RE.search(b)
        if m: return ("Cloudbeds", m.group(1))
        if urllib.parse.urlparse(b).netloc == urllib.parse.urlparse(final).netloc:
            pages.append(fetch(b)[0])
    text = "\n".join(pages)
    m = CB_RE.search(text)
    if m: return ("Cloudbeds", m.group(1))
    if "cloudbeds" in text.lower(): return ("Cloudbeds (no code)", None)
    for name, rx in ENGINES:
        if re.search(rx, text, re.I): return (name, None)
    return ("unknown", None)


def khet_of(place, fallback):
    # The district is usually the address segment right before "Bangkok"; check segments from the end
    # so a sub-district like "Khlong Toei Nuea" (in Watthana) is not mistaken for Khlong Toei.
    names = {**{k.lower(): k for k in KHET}, **{a.lower(): r for a, r in ALIASES.items()}}
    for seg in reversed([s.strip() for s in str(place.get("address") or "").split(",")]):
        seg = re.sub(r"^(khet|district)\s+|\s+(district|\d{5}).*$", "", seg, flags=re.I).strip().lower()
        if seg in names: return names[seg]
    hay = " ".join(str(place.get(k) or "") for k in ("address", "neighborhood", "street", "city"))
    for alias, real in ALIASES.items():
        if alias.lower() in hay.lower(): return real
    for en in KHET:
        if en.lower() in hay.lower(): return en
    return fallback


def kind_of(cat):
    c = (cat or "").lower()
    if "hostel" in c or "guest" in c: return "hostel"
    if "apartment" in c: return "apt"
    if "boutique" in c: return "boutique"
    return "hotel"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--districts", default="all", help='"all" or comma list, e.g. "Watthana,Bang Rak"')
    ap.add_argument("--max", type=int, default=40, help="max places per search")
    ap.add_argument("--kinds", default="hotel,hostel,serviced apartment")
    args = ap.parse_args()
    token = os.environ.get("APIFY_TOKEN") or sys.exit("APIFY_TOKEN is not set")
    districts = list(KHET) if args.districts.strip().lower() == "all" else [d.strip() for d in args.districts.split(",") if d.strip()]

    places = run_google_maps(token, districts, args.max, [k.strip() for k in args.kinds.split(",")])
    seen, uniq = set(), []
    for p in places:
        key = p.get("placeId") or p.get("url") or p.get("title")
        if key in seen: continue
        seen.add(key); uniq.append(p)
    print(f"{len(uniq)} unique places; checking websites…", flush=True)

    with_site = [p for p in uniq if p.get("website")]
    with ThreadPoolExecutor(12) as ex:
        results = list(ex.map(lambda p: detect(p["website"]), with_site))
    for p, (eng, code) in zip(with_site, results):
        p["_engine"], p["_cb"] = eng, code

    hotels = json.load(open(os.path.join(DATA, "hotels.json"), encoding="utf-8"))
    have = {h["id"] for h in hotels}
    phones_path = os.path.join(DATA, "phones-apify.json")
    phones = json.load(open(phones_path, encoding="utf-8")) if os.path.exists(phones_path) else []
    have_ph = {c["id"] for c in phones}
    added = 0
    for p in with_site:
        code = p.get("_cb")
        if not code or code in have: continue
        en = khet_of(p, (p.get("searchString") or "").split(" in ")[-1].replace(" Bangkok", "") or "Bangkok")
        stars = re.search(r"(\d(?:\.\d)?)", str(p.get("hotelStars") or ""))
        hotels.append({
            "id": code, "n": p.get("title"), "ken": en, "kth": KHET.get(en, en), "t": kind_of(p.get("categoryName")),
            "s": float(stars.group(1)) if stars else None,
            "rv": round(p["totalScore"] * 2, 1) if p.get("totalScore") else None,
            "rc": p.get("reviewsCount"), "src": "Google" if p.get("totalScore") else "",
            "p": None, "rm": None, "a": p.get("address") or "",
            "u": f"https://hotels.cloudbeds.com/reservation/{code}",
            "no": f"พบจาก Google Maps (Apify) · {p.get('categoryName') or ''}".strip(" ·"),
        })
        if code not in have_ph:
            ph = re.sub(r"^\+66\s*", "0", str(p.get("phone") or "")).strip() or None
            phones.append({"id": code, "phone": ph, "phone2": None, "email": None, "line": None, "website": p.get("website")})
        have.add(code); added += 1

    json.dump(hotels, open(os.path.join(DATA, "hotels.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(phones, open(phones_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    keep = ["title", "categoryName", "address", "phone", "website", "totalScore", "reviewsCount", "hotelStars", "url", "_engine", "_cb"]
    json.dump([{k: p.get(k) for k in keep} for p in uniq], open(os.path.join(DATA, "apify-places.json"), "w", encoding="utf-8"), ensure_ascii=False)
    with open(os.path.join(DATA, "other-engines.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(["ชื่อ", "ประเภท", "ระบบจอง", "เบอร์", "เว็บ", "Google", "รีวิว", "ที่อยู่"])
        for p in uniq:
            if p.get("_engine") and not str(p["_engine"]).startswith("Cloudbeds"):
                w.writerow([p.get("title"), p.get("categoryName"), p.get("_engine"), p.get("phone"), p.get("website"), p.get("totalScore"), p.get("reviewsCount"), p.get("address")])
    eng = {}
    for p in with_site: eng[p["_engine"]] = eng.get(p["_engine"], 0) + 1
    print("engines:", json.dumps(eng, ensure_ascii=False))
    print(f"added {added} new Cloudbeds hotels (total {len(hotels)})")


if __name__ == "__main__":
    main()
