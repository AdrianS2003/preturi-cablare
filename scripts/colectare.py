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


# ---------- parsere pe magazin ----------
# Fiecare întoarce un dict: cur (preț afișat), reg (preț fără reducere sau None), cu_tva (bool),
# reducere (True dacă pagina semnalează reducere; dacă nu găsim prețul vechi, colectorul nu folosește prețul redus).
def _p(cur, reg, cu_tva, reducere=False):
    if reg is not None and cur is not None and reg <= cur + 0.004:
        reg = None  # "preț vechi" egal sau mai mic = nu e reducere
    return {'cur': cur, 'reg': reg, 'cu_tva': cu_tva, 'reducere': bool(reducere or reg)}


def parse_fiberstore(soup):
    # meta product:price:amount = preț NET (fără TVA) curent; în .prod-price, dacă sunt două valori înainte de "cu TVA",
    # prima este prețul de listă (tăiat) = preț fără reducere. Toate valorile de aici sunt fără TVA.
    cur = meta(soup, 'product:price:amount')
    reg = None
    blk = soup.select_one('.prod-price')
    if blk:
        old = blk.select_one('del, s, .old-price, .regular-price')
        if old:
            reg = to_num(old.get_text(' ', strip=True))
        vals = [v for v in lei_values(blk.get_text(' ', strip=True).split('cu TVA')[0]) if v]
        if reg is None and len(vals) >= 2:
            reg = vals[0]
            cur = cur or vals[1]
        elif cur is None and vals:
            cur = vals[-1]
    return _p(cur, reg, False)


def _in_miniature(el):
    return el.find_parent(class_=re.compile(r'product-miniature|products-section|featured-products|product-accessories|crossselling')) is not None


def parse_ethercom(soup):
    # PrestaShop 1.7: meta pretax = fără TVA (curent); JSON data-product are has_discount / regular_price_amount (cu TVA).
    pre = meta(soup, 'product:pretax_price:amount')
    cu = meta(soup, 'product:price:amount')
    cur_net = pre if pre else (round(cu / TVA, 4) if cu else None)
    reg_net, reducere = None, False
    dp = soup.select_one('#product-details[data-product]') or soup.select_one('[data-product]')
    if dp:
        try:
            j = json.loads(dp.get('data-product'))
            if j.get('has_discount') or j.get('reduction'):
                reducere = True
            r = to_num(j.get('regular_price_amount'))
            pa = to_num(j.get('price_amount'))
            if r and pa and r > pa + 0.004:
                # raportul regular/curent aplicat prețului net, ca să nu depindem de TVA-ul afișat
                reg_net = round(cur_net * r / pa, 4) if cur_net else round(r / TVA, 4)
        except (ValueError, TypeError):
            pass
    if reg_net is None:
        for old in soup.select('.regular-price, .old-price, .product-discount .regular-price'):
            if _in_miniature(old):
                continue
            v = to_num(old.get_text(' ', strip=True))
            if v and cu and v > cu + 0.004:
                reg_net = round(cur_net * v / cu, 4) if cur_net else round(v / TVA, 4)
                break
    for f in soup.select('.product-flag.discount, .product-flag.on-sale, .discount-percentage, .discount-amount, .on-sale'):
        if not _in_miniature(f):
            reducere = True
            break
    return _p(cur_net, reg_net, False, reducere)


def parse_smdplus(soup):
    # PrestaShop 1.6: preț cu TVA în [itemprop=price]; preț vechi în #old_price_display; reducere în #reduction_percent_display.
    el = soup.select_one('[itemprop=price]')
    cur = to_num(el.get('content') or el.get_text()) if el else None
    reg = None
    old = soup.select_one('#old_price_display') or soup.select_one('.old_price')
    if old:
        reg = to_num(old.get_text(' ', strip=True))
    red = False
    for sel in ('#reduction_percent_display', '#reduction_amount_display'):
        r = soup.select_one(sel)
        if r and re.search(r'[1-9]', r.get_text()):
            red = True
    return _p(cur, reg, True, red)


def parse_dedeman(soup):
    # Magento: .old-price = preț vechi, .special-price = preț redus; prețurile sunt cu TVA
    box = soup.select_one('.product-info-price') or soup.select_one('.product-info-main') or soup
    old = box.select_one('.old-price .price')
    special = box.select_one('.special-price .price')
    final = box.select_one('.price-final_price .price')
    cur_el = special or final
    cur = to_num(cur_el.get_text()) if cur_el else meta(soup, 'price')
    reg = to_num(old.get_text()) if old else None
    return _p(cur, reg, True, bool(special))


def parse_mondoplast(soup):
    # Text: "Pret vechi fara TVA : 110,37 LEI  Pret nou fara TVA : 77,57 LEI" sau "Pret fara TVA: 74.42 LEI"
    txt = soup.get_text(' ', strip=True)
    old = re.search(r'Pret\s+vechi\s+fara\s+TVA\s*:?\s*([\d.,]+)\s*LEI', txt, re.I)
    cur = re.search(r'Pret\s+(?:nou\s+)?fara\s+TVA\s*:?\s*([\d.,]+)\s*LEI', txt, re.I)
    return _p(to_num(cur.group(1)) if cur else None, to_num(old.group(1)) if old else None, False, bool(old))


PARSERE = {
    'fiberstore.ro': parse_fiberstore,
    'ethercom.ro': parse_ethercom,
    'itconex.ro': parse_ethercom,  # tot PrestaShop 1.7
    'smd-plus.ro': parse_smdplus,
    'dedeman.ro': parse_dedeman,
    'mondoplast.ro': parse_mondoplast,
}


def domeniu(url):
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith('www.') else host


def extrage(html, url):
    """Întoarce (preț fără TVA, fără reducere, sigur) sau ridică ValueError.
    sigur=False: pagina arată reducere, dar nu am găsit prețul vechi (atunci nu folosim prețul redus)."""
    p = PARSERE.get(domeniu(url))
    if not p:
        raise ValueError('magazin necunoscut: ' + domeniu(url))
    r = p(BeautifulSoup(html, 'html.parser'))
    price = r['reg'] or r['cur']
    if not price or price <= 0:
        raise ValueError('preț negăsit în pagină')
    sigur = not (r['reducere'] and not r['reg'])
    return fara_tva(price, r['cu_tva']), sigur


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
                price, sigur = extrage(html, s['url'])
                price = round(price * float(s.get('factor', 1)), 2)
                if not sigur and prev.get('pret') and prev['pret'] > price:
                    # reducere fără preț vechi vizibil: păstrăm prețul anterior (mai mare), nu pe cel redus
                    price = prev['pret']
                    entry['nota'] = 'reducere în magazin; păstrat prețul fără reducere'
                elif not sigur:
                    entry['nota'] = 'magazinul arată reducere; prețul vechi nu a fost găsit'
                entry['pret'] = price
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
