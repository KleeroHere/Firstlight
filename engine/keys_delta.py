# -*- coding: utf-8 -*-
"""Сколько на самом деле меняет каждый ключ К1 по сравнению со своим началом.

Вопрос владельца 31.08.2026: «убедись, что ключи вообще нужны — опорные
кадры вечернего круга и так выглядят как ключи». Вопрос денежный: ключ
стоит $0.067, и если ключ почти копия начального кадра, эти деньги
выброшены дважды — и на генерацию, и на пятисекундный клип, в котором
ничего не происходит.

Метрика простая и честная: доля пикселей, отличающихся заметно для глаза.
Кадры приводятся к одному размеру, переводятся в серый, берётся модуль
разности; «изменившимся» считается пиксель с разностью больше 24 из 255
(ниже этого порога разница читается как перерисовка контура, а не как
движение). Печатается доля таких пикселей в процентах.

Ориентиры набраны на принятых ключах ночи 31.08:
    < 1.0 %   ключ почти копия — клип будет стоять на месте;
    1-3 %     движение одной руки или поворот головы (нормальный ключ);
    > 8 %     меняется больше, чем одна деталь, — смотреть глазами.

    python engine/keys_delta.py [--id <ролик>] [--all]

Ничего не удаляет и не тратит: только считает и печатает.
"""
import glob
import io
import json
import os
import sys

import numpy as np
from PIL import Image

import paths  # noqa: E402  (engine/paths.py)
ROOT = str(paths.ROOT)
PLANS = os.path.join(ROOT, "engine")
TAKES = str(paths.TAKES)
THRESH = 24


def load(path, size=None):
    im = Image.open(path).convert("L")
    if size and im.size != size:
        im = im.resize(size, Image.BILINEAR)
    return np.asarray(im, dtype=np.int16)


def delta(a_path, b_path):
    a = Image.open(a_path).convert("L")
    size = a.size
    a = np.asarray(a, dtype=np.int16)
    b = load(b_path, size)
    d = np.abs(a - b)
    return float((d > THRESH).mean() * 100.0)


def resolve(takes_dir, ref):
    """Мастер плана: либо файл в корне ролика, либо ключ предыдущего плана."""
    p = os.path.join(takes_dir, ref.replace("/", os.sep))
    return p if os.path.exists(p) else None


def report(vid):
    path = os.path.join(PLANS, "flf_plans_%s.json" % vid)
    if not os.path.exists(path):
        return
    plans = json.load(io.open(path, encoding="utf-8"))["plans"]
    takes_dir = os.path.join(TAKES, vid)
    rows = []
    for p in plans:
        key = os.path.join(takes_dir, "keys", "plan%d_key.png" % p["plan"])
        src = resolve(takes_dir, p["master"])
        if not os.path.exists(key) or not src:
            continue
        rows.append((p["plan"], p["scene"], delta(src, key)))
    if not rows:
        return
    print("\n%s" % vid)
    for plan, scene, d in rows:
        mark = "  ПОЧТИ КОПИЯ" if d < 1.0 else ("  много" if d > 8.0 else "")
        print("  план %-3d %-5s %5.2f %%%s" % (plan, scene, d, mark))
    weak = [r for r in rows if r[2] < 1.0]
    print("  итого планов %d, из них почти-копий %d" % (len(rows), len(weak)))


args = sys.argv[1:]
if "--id" in args:
    report(args[args.index("--id") + 1])
else:
    for f in sorted(glob.glob(os.path.join(PLANS, "flf_plans_*.json"))):
        report(os.path.basename(f)[len("flf_plans_"):-len(".json")])
