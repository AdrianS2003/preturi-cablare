#!/usr/bin/env python3
"""Caută candidați pentru fiecare produs în toate magazinele.

1. Citește lista completă de produse a fiecărui magazin din sitemap (link declarat în robots.txt).
2. Potrivește fiecare produs din catalog cu adresele paginilor (cuvinte cheie din REGULI).
3. Deschide cei mai buni candidați și citește titlul + prețul.
4. Scrie data/candidati.json, pentru verificare manuală (nimic nu intră automat în surse.json).

Rulare: python scripts/cautare.py [--only p001,p002] [--max 4]
"""
import argparse
import gzip
import json
import re
import sys
import threading
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlparse, unquote

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent))
import colectare as C  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'candidati.json'
PAUZA = 2.0

MAGAZINE = {
    'Dedeman': {'base': 'https://www.dedeman.ro', 'prod': r'/p/\d+'},
    'Ethercom': {'base': 'https://ethercom.ro', 'prod': r'/\d+-[^/]+\.html$'},
    'SMD Plus': {'base': 'https://smd-plus.ro', 'prod': r'/\d+-[^/]+\.html$'},
    'Fiberstore': {'base': 'https://fiberstore.ro', 'prod': r'.'},
    'ITConex': {'base': 'https://itconex.ro', 'prod': r'/produse/\d+-', 'start': 'https://itconex.ro/ro/'},
    'Mondo Plast': {'base': 'https://www.mondoplast.ro', 'prod': r'-pg_ft-\d+'},
    'Starbit': {'base': 'https://startbit.ro', 'prod': r'.'},
}

# ---------- reguli de potrivire: toate grupurile "req" trebuie găsite; "neg" exclude ----------
LC = r'\blc(?:upc|pc)?\b'
MM = r'om3|om4|multimod|multi mode|\bmm\b|50 125'
SM = r'\bsm\b|os2|singlemod|single mode|9 125|\bom2\b|\bom1\b|62 5'
D4025 = r'40 ?x ?25|25 ?x ?40'
D6040 = r'60 ?x ?40|40 ?x ?60'
CANAL = r'canal|jgheab|plinta|traseu'


def L(rx):  # lungime patchcord
    return rx


REGULI = {
    'p001': {'req': [r'rack|cabinet|dulap', r'42 ?u']},
    'p002': {'req': [r'rack|cabinet|dulap', r'(?<!\d)9 ?u\b', r'600']},
    'p003': {'req': [r'pdu|prize|priza|bara alimentare|bara de alimentare', r'(?<!\d)8(?!\d)', r'rack|19']},
    'p004': {'req': [r'organizator', r'(?<!\d)1 ?u\b|orizontal|rack|19|okr']},
    'p005': {'req': [r'\bups\b', r'3000|3 ?k(?:va)?\b', r'rack']},
    'p006': {'req': [r'rack', r'surub|montaj|piulit']},
    'p007': {'req': [r'priza|cutie|terminal|ftth|rozeta', r'fibra|optic|\bfo\b|ftth', LC]},
    'p008': {'req': [r'cablu', r'fibra|optic|\bfo\b', r'om4', r'(?<!\d)48(?!\d)']},
    'p009': {'req': [r'cablu', r'fibra|optic|\bfo\b', r'om4', r'(?<!\d)4 ?(?:fibre|f\b|g\b|x)|1x4|4xom4']},
    'p010': {'req': [r'switch', r'sfp', r'24|28']},
    'p011': {'req': [r'patch ?panel|odf', r'(?<!\d)24(?!\d)', LC]},
    'p012': {'req': [r'patch ?cord', LC, MM, L(r'(?<!\d)0 5 ?m\b|(?<!\d)05 ?m\b|50 ?cm')], 'neg': SM},
    'p013': {'req': [r'patch ?cord', LC, MM, L(r'(?<![\d ])1 ?m\b|(?<!\d)(?<!\d )1 ?m\b')], 'neg': SM + r'|1 5 ?m'},
    'p014': {'req': [r'patch ?cord', LC, MM, L(r'(?<!\d)(?<!\d )2 ?m\b')], 'neg': SM},
    'p015': {'req': [r'patch ?cord', LC, MM, L(r'(?<!\d)(?<!\d )3 ?m\b')], 'neg': SM},
    'p016': {'req': [r'patch ?cord', LC, MM, L(r'(?<!\d)10 ?m\b')], 'neg': SM},
    'p017': {'req': [r'patch ?cord', LC, MM, L(r'(?<!\d)30 ?m\b')], 'neg': SM},
    'p018': {'req': [r'jgheab|canal', r'metal|zincat|perforat|otel', r'(?<!\d)100(?!\d)', r'(?<!\d)35(?!\d)'], 'neg': r'capac(?! cu)|cot|teu|cuplaj|consola'},
    'p019': {'req': [r'profil|sina|consola', r'jgheab|suspendare|tavan|strut|cablu']},
    'p020': {'req': [r'tija|tije', r'filetat', r'\bm ?8\b'], 'neg': r'inox|mufa|imbinare|cuplare|(?<!\d)(?:80|100|120) mm'},
    'p021': {'req': [r'ancora|diblu metalic|expandabil|conexpand', r'\bm ?8\b']},
    'p022': {'req': [r'piulit', r'\bm ?8\b', r'hexagonal|934'], 'neg': r'cuplare|conica|inox|fluture|sigurant|nituit|oxid'},
    'p023': {'req': [r'mufa|cuplare|prelungire|imbinare', r'\bm ?8\b']},
    'p024': {'req': [r'surub', r'\bm ?6\b', r'rotund|bombat|semirotund|jgheab|piulit']},
    'p025': {'req': [r'surub', r'\bm ?8\b', r'rotund|bombat|semirotund|jgheab|piulit']},
    'p026': {'req': [r'saiba', r'plat', r'\bm ?6\b'], 'neg': r'inox|cauciuc'},
    'p027': {'req': [r'saiba', r'plat', r'\bm ?8\b'], 'neg': r'inox|cauciuc'},
    'p028': {'req': [r'disc', r'metal|debitare|taiere', r'(?<!\d)125(?!\d)', r'x 1 mm|x 1\b|x1 mm|125 ?x ?1(?!\d)|1 0 ?mm']},
    'p029': {'req': [CANAL, D4025], 'neg': r'\bcot\b|capac capat|colt|teu|imbinare|lemn|stejar|pin\b'},
    'p030': {'req': [r'cot|colt|unghi', r'interior|intern', D4025]},
    'p031': {'req': [r'cot|colt|unghi', r'exterior|extern', D4025]},
    'p032': {'req': [r'cot|colt|unghi', r'plan|drept|\bl\b|90', D4025]},
    'p033': {'req': [r'capat|terminal|dop|inchidere', D4025]},
    'p034': {'req': [CANAL, D6040], 'neg': r'\bcot\b|capac capat|colt|teu|imbinare'},
    'p035': {'req': [r'cot|colt|unghi', r'interior|intern', D6040]},
    'p036': {'req': [r'cot|colt|unghi', r'exterior|extern', D6040]},
    'p037': {'req': [r'cot|colt|unghi', r'plan|drept|\bl\b|90', D6040]},
    'p038': {'req': [r'capat|terminal|dop|inchidere', D6040]},
    'p039': {'req': [r'diblu|holtsurub|surub', r'8 ?x ?80']},
    'p040': {'req': [r'diblu', r'gips|rigips|carton', r'metal|zamac|autoforant|autoperforant|driva']},
    'p041': {'req': [r'colier|zimtat', r'4 8 ?x ?200|200 ?x ?4 8']},
    'p042': {'req': [r'colier|zimtat', r'2 5 ?x ?100|100 ?x ?2 5']},
    'p043': {'req': [r'alcool|izopropil']},
    'p044': {'req': [r'servet', r'fibr|optic|curatare|lint']},
    'p045': {'req': [r'tub|termo|manson', r'sudur|protectie|splice', r'(?<!\d)60 ?mm|(?<!\d)60(?!\d)']},
    'p046': {'req': [r'tub|termo|manson', r'sudur|protectie|splice', r'(?<!\d)40 ?mm|(?<!\d)40(?!\d)']},
    'p047': {'req': [r'aer comprimat|aer sub presiune|duster']},
    'p048': {'req': [r'banda|scotch', r'izolat']},
    'p049': {'req': [r'banda|scotch', r'hartie|mascare|crep', r'(?<!\d)38(?!\d)']},
    'p050': {'req': [r'banda|caseta|rola|tze|tz2', r'(?<!\d)19 ?mm|(?<!\d)19(?!\d)', r'etichet|tze|brother|dymo|labelling']},
}


def norm(s):
    s = unicodedata.normalize('NFKD', unquote(s or '')).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return ' ' + re.sub(r'\s+', ' ', s).strip() + ' '


def potriveste(rule, text):
    if rule.get('neg') and re.search(rule['neg'], text):
        return False
    return all(re.search(g, text) for g in rule['req'])


# ---------- sitemap ----------
def get(url):
    if not C.permis(url):
        raise ValueError('robots')
    r = requests.get(url, headers={'User-Agent': C.UA}, timeout=60)
    r.raise_for_status()
    data = r.content
    if url.endswith('.gz') or data[:2] == b'\x1f\x8b':
        data = gzip.decompress(data)
    return data.decode('utf-8', 'replace')


def sitemap_urls(base, log):
    starts = []
    try:
        rb = requests.get(base + '/robots.txt', headers={'User-Agent': C.UA}, timeout=30).text
        starts = re.findall(r'(?im)^\s*sitemap:\s*(\S+)', rb)
    except requests.RequestException:
        pass
    if not starts:
        starts = [base + p for p in ('/sitemap.xml', '/sitemap_index.xml', '/1_index_sitemap.xml', '/wp-sitemap.xml')]
    seen, out, queue = set(), [], list(dict.fromkeys(starts))
    while queue and len(seen) < 400:
        sm = queue.pop(0)
        if sm in seen:
            continue
        seen.add(sm)
        try:
            xml = get(sm)
        except Exception as e:  # noqa: BLE001
            log.append(f'sitemap {sm}: {type(e).__name__} {str(e)[:60]}')
            continue
        locs = re.findall(r'<loc>\s*([^<\s]+)\s*</loc>', xml)
        if '<sitemapindex' in xml[:2000] or (locs and all(re.search(r'\.xml(\.gz)?$|sitemap', u) for u in locs[:20])):
            # index: urmăm doar sitemap-urile care par de produse (sau toate, dacă nu se poate deosebi)
            subs = [u for u in locs if not re.search(r'categor|cms|manufacturer|supplier|brand|blog|post|page|tag|author|image', u, re.I)]
            queue.extend(subs or locs)
        else:
            out.extend(u.replace('&amp;', '&') for u in locs)
        time.sleep(0.5)
    log.append(f'{len(seen)} sitemap-uri, {len(out)} adrese')
    return out



# ---------- rezervă: parcurgerea categoriilor (când nu există sitemap) ----------
CAT_OK = (r'fibr|optic|\bfo\b|rack|patch|cablu|cabluri|pdu|ups|organizator|accesor|consumabil|scule|canal|retea|retele|'
          r'data ?center|pasive|odf|priz|cutii|conectica|alimentare|surse|cabinet|dulap|sfp|switch|fixare|curatare|termo|unelte|electric')
CAT_NU = r'cont|login|cos|cart|checkout|comanda|contact|blog|termeni|politic|gdpr|cookie|wishlist|compar|search|cautare|despre|livrare|retur|brand|producator|manufacturer'


def crawl(cfg, log, max_pagini=450):
    base = cfg['base']
    host = urlparse(base).netloc
    prod = re.compile(cfg['prod'])
    coada, vazute, produse = [cfg.get('start', base + '/')], set(), {}
    while coada and len(vazute) < max_pagini:
        u = coada.pop(0)
        if u in vazute:
            continue
        vazute.add(u)
        try:
            html = C.descarca(u)
        except Exception as e:  # noqa: BLE001
            log.append(f'crawl {u[:60]}: {str(e)[:40]}')
            continue
        soup = BeautifulSoup(html, 'html.parser')
        for a in soup.find_all('a', href=True):
            h = a['href'].split('#')[0]
            if h.startswith('/'):
                h = f'{urlparse(base).scheme}://{host}{h}'
            if urlparse(h).netloc.replace('www.', '') != host.replace('www.', ''):
                continue
            if prod.search(urlparse(h).path):
                t = a.get('title') or a.get_text(' ', strip=True)
                if len(t) > len(produse.get(h.split('?')[0], '')):
                    produse[h.split('?')[0]] = t
                continue
            low = norm(h)
            pag = re.search(r'[?&](?:page|p)=\d+', h)
            if (re.search(CAT_OK, low) or pag) and not re.search(CAT_NU, low) and h not in vazute:
                if pag or '?' not in h:
                    coada.append(h)
        time.sleep(1.0)
    log.append(f'parcurs {len(vazute)} pagini de categorie')
    return produse

# ---------- citire pagină candidat ----------
def titlu(soup):
    for sel in ('meta[property="og:title"]',):
        el = soup.select_one(sel)
        if el and el.get('content'):
            return el['content'].strip()
    h = soup.find('h1')
    if h:
        return h.get_text(' ', strip=True)
    return soup.title.get_text(strip=True) if soup.title else ''


def pret_generic(soup):
    """Pentru magazinele fără parser dedicat: JSON-LD, meta, itemprop. Întoarce (preț, sursa_valorii)."""
    for s in soup.find_all('script', type='application/ld+json'):
        try:
            d = json.loads(s.string or '')
        except (ValueError, TypeError):
            continue
        items = d if isinstance(d, list) else d.get('@graph', [d]) if isinstance(d, dict) else []
        for it in items:
            if isinstance(it, dict) and 'offers' in it:
                of = it['offers']
                of = of[0] if isinstance(of, list) and of else of
                if isinstance(of, dict):
                    ps = of.get('priceSpecification')
                    p = of.get('price') or (ps.get('price') if isinstance(ps, dict) else None)
                    if p:
                        return C.to_num(p), 'jsonld'
    for key in ('product:price:amount', 'og:price:amount', 'price'):
        v = C.meta(soup, key)
        if v:
            return v, 'meta ' + key
    el = soup.select_one('[itemprop=price]')
    if el:
        return C.to_num(el.get('content') or el.get_text()), 'itemprop'
    return None, None


def citeste(url):
    html = C.descarca(url)
    soup = BeautifulSoup(html, 'html.parser')
    r = {'titlu': titlu(soup)[:200]}
    dom = C.domeniu(url)
    if dom in C.PARSERE:
        try:
            pret, sigur = C.extrage(html, url)
            r['pret'] = pret
            if not sigur:
                r['nota'] = 'reducere fără preț vechi'
        except ValueError as e:
            r['eroare'] = str(e)
    else:
        p, src = pret_generic(soup)
        r['pret_brut'] = p
        r['sursa_pret'] = src
        txt = soup.get_text(' ', strip=True)
        m = re.search(r'.{0,120}TVA.{0,120}', txt, re.I)
        r['text_tva'] = m.group(0) if m else ''
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--max', type=int, default=4, help='candidați deschiși pe produs și magazin')
    ap.add_argument('--magazine', default='')
    a = ap.parse_args()
    only = {x.strip() for x in a.only.split(',') if x.strip()}
    mags = {k: v for k, v in MAGAZINE.items() if not a.magazine or k in a.magazine.split(',')}
    reguli = {k: v for k, v in REGULI.items() if not only or k in only}

    rez = {pid: [] for pid in reguli}
    stat = {}
    lock = threading.Lock()

    def lucreaza(nume, cfg):
        log = []
        try:
            urls = [u for u in sitemap_urls(cfg['base'], log) if re.search(cfg['prod'], u)]
        except Exception as e:  # noqa: BLE001
            log.append('eroare sitemap: ' + str(e)[:100])
            urls = []
        nume_pag = {u: '' for u in dict.fromkeys(urls)}
        if len(nume_pag) < 50:
            nume_pag.update(crawl(cfg, log))
        urls = list(nume_pag)
        texte = [(u, norm(urlparse(u).path + ' ' + nume_pag[u])) for u in urls]
        deschise = 0
        for pid, rule in reguli.items():
            hits = [u for u, t in texte if potriveste(rule, t)]
            hits.sort(key=lambda u: len(u))  # adresele mai scurte sunt de obicei produsul de bază
            for u in hits[:a.max]:
                item = {'magazin': nume, 'url': u, 'potriviri': len(hits)}
                try:
                    item.update(citeste(u))
                    # verificare dublă pe titlul real al paginii
                    item['titlu_potrivit'] = potriveste(rule, norm(item.get('titlu', '')))
                except Exception as e:  # noqa: BLE001
                    item['eroare'] = str(e)[:100]
                deschise += 1
                with lock:
                    rez[pid].append(item)
                time.sleep(PAUZA)
        log.append(f'{len(urls)} pagini de produs, {deschise} candidați deschiși')
        with lock:
            stat[nume] = log
        print(nume, '|', ' ; '.join(log), flush=True)

    th = [threading.Thread(target=lucreaza, args=(n, c)) for n, c in mags.items()]
    for t in th:
        t.start()
    for t in th:
        t.join()

    OUT.write_text(json.dumps({'magazine': stat, 'candidati': rez}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print('Gata:', sum(len(v) for v in rez.values()), 'candidați')


if __name__ == '__main__':
    main()
