#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Предполётная проверка план-листов перед съёмкой.

    python engine/preflight_plans.py [id ...]

Без аргументов проверяет все flf_plans_*.json. Ловит четыре вещи, каждая из
которых иначе всплывает посреди ночного прогона и стоит часа пода:

1. Кадра, на который ссылается план, нет на диске.
2. Число кадров плана не кратно формуле F=8x+1 при 16 fps — узел FLF2V
   такой длины не примет.
3. Сумма планов сцены короче самой сцены — хвост дотянется стоп-кадром.
4. План ссылается на сцену, которой нет в компиляте.

Планы, чей мастер начинается с `keys/`, — это сцена, собранная цепочкой:
их стартовый кадр создаётся ключом предыдущего плана, поэтому наличие
файла на этом этапе не проверяется.
"""
import json
import io
import os
import sys
import glob

import paths  # noqa: E402  (engine/paths.py)
ROOT = str(paths.ROOT)
TAKES = str(paths.TAKES)
COMPILED = str(paths.COMPILED)
PLANS = os.path.join(ROOT, 'engine')
SKIP = ('title', 'divider', 'memo')


def check(sid):
    pl = os.path.join(PLANS, 'flf_plans_%s.json' % sid)
    cp = os.path.join(COMPILED, '%s.json' % sid)
    if not os.path.exists(cp):
        return ['нет компилята %s.json' % sid]
    d = json.load(io.open(pl, encoding='utf-8'))
    c = json.load(io.open(cp, encoding='utf-8'))
    need = {s['id']: float(s['t'][1]) - float(s['t'][0])
            for s in c['scenes'] if s.get('kind', 'anim') not in SKIP}
    have, problems = {}, []
    for p in d['plans']:
        have[p['scene']] = have.get(p['scene'], 0) + p['frames'] / 16.0
        # Полуфазный план (cycle) снимается двумя половинами, каждая — по
        # формуле 8x+1, поэтому его собственное число кадров всегда чётное
        # и равно удвоенной половине. Обычный план — сам по формуле.
        if p.get('cycle'):
            if p['frames'] % 2 or (p['frames'] // 2) % 8 != 1:
                problems.append('план %d (полуфазный): кадров %d не равно удвоенной половине по формуле 8x+1'
                                % (p['plan'], p['frames']))
        elif p['frames'] % 8 != 1:
            problems.append('план %d: кадров %d не по формуле 8x+1' % (p['plan'], p['frames']))
        if not p['master'].startswith('keys/'):
            m = os.path.join(TAKES, sid, p['master'])
            if not os.path.exists(m):
                problems.append('план %d: нет кадра %s' % (p['plan'], p['master']))
    for s in need:
        if s not in have:
            problems.append('сцена %s: нет ни одного плана' % s)
        elif have[s] + 0.05 < need[s]:   # тот же допуск, что у flf_verify
            problems.append('сцена %s: планов на %.2f с при сцене %.1f с' % (s, have[s], need[s]))
    for s in have:
        if s not in need:
            problems.append('план на несуществующую сцену %s' % s)
    return problems


ids = sys.argv[1:]
if not ids:
    ids = sorted(os.path.basename(f)[10:-5]
                 for f in glob.glob(os.path.join(PLANS, 'flf_plans_*.json')))

total = 0
for sid in ids:
    problems = check(sid)
    total += len(problems)
    print('%-34s %s' % (sid, 'ОК' if not problems else 'ПРОБЛЕМЫ: ' + '; '.join(problems)))
print('\nвсего проблем: %d' % total)
sys.exit(1 if total else 0)
