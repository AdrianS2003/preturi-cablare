#!/usr/bin/env python3
"""Colectează zilnic prețurile din sursele fixe (data/surse.json) și scrie data/preturi.json.

- Ia prețul FĂRĂ reducere (prețul vechi, când pagina arată și unul redus).
- Salvează mereu prețul fără TVA (convertește când pagina arată prețul cu TVA).
- Respectă robots.txt și face o pauză între cereri.
- La eroare păstrează ultimul preț cunoscut și notează eroarea, linkul rămâne în listă.

Rulare: python scripts/colectare.py [--only p001,p002]
"""
import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.robotparser
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
SURSE = ROOT / 'data' / 'surse.json'
PRETURI = ROOT / 'data' / 'preturi.json'
TVA = 1.21
PAUZA = 3.0
UA = 'Mozilla/5.0 (compatible; preturi-cablare/1.0; +https://github.com/AdrianS2003/preturi-cablare)'


# ---------- utilitare ----------
def to_num(s):
    """'3.863,51', '9,92', '27.00', '1.200' -> float (None dacă nu e număr)."""
    if s is None:
        return None
    m = re.search(r'\d[\d.,]*', str(s))
    if not m:
        return None
    t = m.group(0).rstrip('.,')
    if ',' in t and '.' in t:
        t = t.replace('.', '').replace(',', '.')
    elif ',' in t:
        t = t.replace(',', '.')
    elif '.' in t and re.fullmatch(r'\d{1,3}(\.\d{3})+', t):
        t = t.replace('.', '')
    try:
        return float(t)
    except ValueError:
        return None


def lei_values(text):
    return [to_num(x) for x in re.findall(r'\d[\d.,]*\s*lei', text or '')]


def meta(soup, key):
    el = soup.find('meta', attrs={'property': key}) or soup.find('meta', attrs={'itemprop': key}) or soup.find('meta', attrs={'name': key})
    return to_num(el.get('content')) if el and el.get('content') else None


def fara_tva(price, cu_tva):
    return round(price / TVA, 2) if cu_tva else round(price, 2)


# ---------- parsere pe magazin: întorc (preț_curent, preț_fără_reducere|None, cu_tva) ----------
def parse_fiberstore(soup):
    # meta product:price:amount = preț NET (fără TVA); blocul .prod-price arată "preț [vechi] curent lei cu TVA: ..."
    cur = meta(soup, 'product:price:amount')
    reg = None
    blk = soup.select_one('.prod-price')
    if blk:
        txt = blk.get_text(' ', strip=True)
        before = txt.split('cu TVA')[0]
        vals = [v for v in lei_values(before) if v]
        # Atenție: "prețul vechi" tăiat de pe Fiberstore este un preț de listă permanent (ex. 37 lei vs 11,57 lei), nu prețul real,
        # așa că îl ignorăm și luăm prețul curent de vânzare.
        if len(vals) >= 1 and cur is None:
            cur = vals[0]
    return cur, reg, False


def parse_ethercom(soup):
    # PrestaShop: pretax = fără TVA, price = cu TVA; prețul vechi apare în .regular-price din blocul .product-prices
    pre = meta(soup, 'product:pretax_price:amount')
    cu = meta(soup, 'product:price:amount')
    cur_net = pre if pre else (round(cu / TVA, 2) if cu else None)
    reg_net = None
    node = soup.select_one('.current-price')
    for _ in range(6):
        if node is None:
            break
        if 'product-prices' in (node.get('class') or []):
            old = node.select_one('.regular-price')
            if old:
                v = to_num(old.get_text(' ', strip=True))
                if v:
                    reg_net = round(v / TVA, 2)
            break
        node = node.parent
    return cur_net, reg_net, False


def parse_smdplus(soup):
    # Preț cu TVA în [itemprop=price]; prețul vechi (dacă e reducere) în #old_price_display
    el = soup.select_one('[itemprop=price]')
    cur = to_num(el.get('content') or el.get_text()) if el else None
    reg = None
    old = soup.select_one('#old_price_display') or soup.select_one('.old_price')
    if old:
        reg = to_num(old.get_text(' ', strip=True))
    return cur, reg, True


def parse_dedeman(soup):
    # Magento: .old-price = preț vechi, .special-price = preț redus; prețurile sunt cu TVA
    box = soup.select_one('.product-info-price') or soup
    old = box.select_one('.old-price .price')
    special = box.select_one('.special-price .price')
    final = box.select_one('.price-final_price .price')
    cur_el = special or final
    cur = to_num(cur_el.get_text()) if cur_el else meta(soup, 'price')
    reg = to_num(old.get_text()) if old else None
    return cur, reg, True


PARSERE = {
    'fiberstore.ro': parse_fiberstore,
    'ethercom.ro': parse_ethercom,
    'smd-plus.ro': parse_smdplus,
    'dedeman.ro': parse_dedeman,
}


def domeniu(url):
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith('www.') else host


def extrage(html, url):
    """Întoarce prețul fără TVA, fără reducere, sau ridică ValueError."""
    p = PARSERE.get(domeniu(url))
    if not p:
        raise ValueError('magazin necunoscut: ' + domeniu(url))
    soup = BeautifulSoup(html, 'html.parser')
    cur, reg, cu_tva = p(soup)
    price = reg if reg else cur
    if not price or price <= 0:
        raise ValueError('preț negăsit în pagină')
    # prețurile vechi ale fiecărui parser sunt în aceeași formă (cu/fără TVA) ca prețul curent, cu excepția Ethercom (deja fără TVA)
    return fara_tva(price, cu_tva), bool(reg)


# ---------- rețea ----------
_robots = {}


def permis(url):
    u = urlparse(url)
    base = f'{u.scheme}://{u.netloc}'
    if base not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = requests.get(base + '/robots.txt', headers={'User-Agent': UA}, timeout=20)
            rp.parse(r.text.splitlines() if r.status_code == 200 else [])
        except requests.RequestException:
            rp.parse([])
        _robots[base] = rp
    return _robots[base].can_fetch(UA, url)


def descarca(url):
    if not permis(url):
        raise ValueError('interzis de robots.txt')
    last = None
    for incercare in range(2):
        try:
            r = requests.get(url, headers={'User-Agent': UA, 'Accept-Language': 'ro-RO,ro;q=0.9'}, timeout=30)
            if r.status_code == 200:
                return r.text
            last = f'HTTP {r.status_code}'
        except requests.RequestException as e:
            last = type(e).__name__
        time.sleep(PAUZA)
    raise ValueError(last or 'eroare de rețea')


# ---------- principal ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='', help='ID-uri de produs separate prin virgulă')
    args = ap.parse_args()
    only = {x.strip() for x in args.only.split(',') if x.strip()}

    surse = json.loads(SURSE.read_text(encoding='utf-8'))
    try:
        vechi = json.loads(PRETURI.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        vechi = {}
    old_surse = vechi.get('surse', {}) or {}
    out = {}
    acum = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')
    ok = err = 0

    for pid, lista in surse.items():
        if only and pid not in only:
            out[pid] = old_surse.get(pid, [])
            continue
        rez = []
        for s in lista:
            prev = next((x for x in old_surse.get(pid, []) if x.get('url') == s['url']), {})
            entry = {'nume': s['nume'], 'url': s['url'], 'pret': prev.get('pret'), 'verificat': prev.get('verificat')}
            try:
                html = descarca(s['url'])
                price, _ = extrage(html, s['url'])
                entry['pret'] = round(price * float(s.get('factor', 1)), 2)
                entry['verificat'] = acum
                ok += 1
            except Exception as e:  # noqa: BLE001
                entry['eroare'] = str(e)[:120]
                err += 1
                print(f'  ! {pid} {s["nume"]}: {e}', file=sys.stderr)
            rez.append(entry)
            time.sleep(PAUZA)
        out[pid] = rez

    # variația față de rularea anterioară: cel mai mic preț activ
    def minim(lst):
        v = [x['pret'] for x in lst if x.get('pret')]
        return min(v) if v else None
    variatie = {}
    for pid, lst in out.items():
        a, b = minim(old_surse.get(pid, [])), minim(lst)
        if a and b and abs(a - b) > 0.0049:
            variatie[pid] = round((b - a) / a * 100, 1)

    ultim = acum if ok else vechi.get('actualizat')
    PRETURI.write_text(json.dumps({'actualizat': ultim, 'surse': out, 'variatie': variatie}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'Gata: {ok} prețuri citite, {err} erori.')
    # nu eșuăm jobul pentru erori izolate; eșuăm doar dacă nu s-a citit nimic dintr-o rulare completă
    if not only and ok == 0 and err > 0:
        sys.exit(1)


if __name__ == '__main__':
    main()
