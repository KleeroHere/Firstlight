#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пересчёт ритма серии под принцип «показываем → рассказываем».

Сцена больше не равна длине озвучки. Она открывается немой картинкой
(`lead`), затем вступает диктор (`vo_at`), затем остаётся тишина
(`tail`). Текст озвучки НЕ меняется — переозвучивать ничего не нужно.

Поля, которые скрипт проставляет в сценариях:
  t      — новый хронометраж сцены
  vo_at  — на какой секунде ОТ НАЧАЛА СЦЕНЫ вступает диктор
  motion — anim: в сцене есть сгенерированный клип, дальше стоп-кадр
                 с медленным наездом;
           pan:  генерация не нужна, кадр статичный с наездом.

Запуск из корня репозитория:
    python engine/repace_scenes.py            # применить
    python engine/repace_scenes.py --check    # только отчёт
"""
import argparse
import math
import re
import sys
from pathlib import Path

import yaml

import paths  # engine/paths.py
ROOT = paths.ROOT
PROMPTS = paths.PROMPTS
SCEN = PROMPTS / "scenarios"

# Движение по кадру: перемещение фигур, передача предметов, смена
# состояния объекта. Панорамой такое не подменишь — нужен клип.
MOTION_ANIM = re.compile(
    r"идёт|идут|входит|входят|выходит|выходят|уходит|уходят|заходят|"
    r"проход|подходит|отходит|отступ|садится|садятся|садят|встаёт|встают|"
    r"поднимаются|расходятся|сдвигаются|сходятся|уводит|отводит|вкатыва|"
    r"открывается|открывает|запирает|закрывается|поворот ключа|передаётся|"
    r"передача|протягивает|разгорается|заливает|делает шаг|шаг вперёд|"
    r"шаг между|задвигается|два шага|движение обоих|отъезжает|уплывает|"
    r"переворачивается|пульсирует|"
    # работа руками крупным планом — обучающая суть бытовых роликов
    r"тряпк|губк|щётк|швабр|пересч[её]т|перекладыва|проба|пробует|дует|"
    r"выносит|накрыва|опускают|ставит|наливает|нажатие|высыпа|протирание",
    re.I)


def vo_seconds(text, cps):
    n = len(" ".join(str(text or "").split()))
    return n / cps if n else 0.0


def plan(scen, pac):
    cps = pac["chars_per_sec"]
    cursor = 0
    out = []
    for sc in scen["scenes"]:
        kind = sc.get("kind", "scene")
        vs = vo_seconds(sc.get("vo"), cps)
        if kind == "title":
            dur, at, motion = max(pac["title"], math.ceil(vs + 3)), 1, None
        elif kind == "divider":
            dur, at, motion = max(pac["divider"], math.ceil(vs + 2)), 1, None
        elif kind == "memo":
            # памятке нужно время на чтение уже после того, как диктор смолк
            dur, at, motion = max(pac["memo_min"], math.ceil(vs + 8)), 2, None
        else:
            dur = math.ceil(pac["lead"] + vs + pac["tail"])
            dur = max(pac["min_scene"], min(pac["max_scene"], dur))
            at = pac["lead"]
            # если фраза длинная, а сцена упёрлась в потолок — сдвигаем
            # вступление диктора ближе к началу, чтобы текст поместился
            if at + vs > dur - 1:
                at = max(1, math.floor(dur - vs - 1))
            motion = "anim" if MOTION_ANIM.search(
                " ".join(str(sc.get("anim", "")).split())) else "pan"
        out.append((sc["id"], [cursor, cursor + dur], at, motion))
        cursor += dur
    return out, cursor


def apply(path, rows, total):
    text = path.read_text(encoding="utf-8")
    for sid, t, at, motion in rows:
        head = re.compile(r"(- id: " + re.escape(sid) + r"\n(?:.*\n)*?\s*t: )\[\d+, \d+\]")
        text, n = head.subn(lambda m: m.group(1) + f"[{t[0]}, {t[1]}]", text, count=1)
        if n != 1:
            sys.exit(f"{path.name}: не нашла сцену {sid}")
        # vo_at и motion ставим сразу после строки t: этой сцены
        line = re.compile(r"(- id: " + re.escape(sid) + r"\n(?:.*\n)*?)(\s*)t: \[\d+, \d+\]\n"
                          r"(?:\s*vo_at: \d+\n)?(?:\s*motion: \w+\n)?")

        def repl(m):
            ind = m.group(2)
            extra = f"{ind}vo_at: {at}\n"
            if motion:
                extra += f"{ind}motion: {motion}\n"
            return m.group(1) + f"{ind}t: [{t[0]}, {t[1]}]\n" + extra
        text, n = line.subn(repl, text, count=1)
        if n != 1:
            sys.exit(f"{path.name}: не смогла вписать vo_at для {sid}")
    text = re.sub(r"^duration_target: \d+$", f"duration_target: {total}",
                  text, count=1, flags=re.M)
    path.write_text(text, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    pac = yaml.safe_load((PROMPTS / "series.yaml").read_text(encoding="utf-8"))["pacing"]
    total_anim = total_pan = 0
    rows_report = []

    for f in sorted(SCEN.glob("*.yaml")):
        scen = yaml.safe_load(f.read_text(encoding="utf-8"))
        if scen.get("retired"):
            continue
        rows, total = plan(scen, pac)
        was = scen["duration_target"]
        n_anim = sum(1 for r in rows if r[3] == "anim")
        n_pan = sum(1 for r in rows if r[3] == "pan")
        total_anim += n_anim
        total_pan += n_pan
        rows_report.append((scen["id"], was, total, n_anim, n_pan))
        if not args.check:
            apply(f, rows, total)
            after = yaml.safe_load(f.read_text(encoding="utf-8"))
            prev = 0
            for sc in after["scenes"]:
                assert sc["t"][0] == prev, f"{f.name}: разрыв на {sc['id']}"
                assert sc["vo_at"] + vo_seconds(sc.get("vo"), pac["chars_per_sec"]) \
                    <= sc["t"][1] - sc["t"][0] + 0.5, f"{f.name}: {sc['id']} озвучка не влезла"
                prev = sc["t"][1]
            assert after["duration_target"] == prev

    print(f"{'ролик':34} {'было':>6} {'стало':>7}  клип  панорама")
    for vid, was, now, na, np in rows_report:
        print(f"{vid:34} {was:5}с {now:6}с {na:5} {np:9}")
    tot = sum(r[2] for r in rows_report)
    print(f"\nроликов: {len(rows_report)}   общий хронометраж: {tot/60:.0f} мин "
          f"(было {sum(r[1] for r in rows_report)/60:.0f} мин)")
    print(f"средняя длина ролика: {tot/len(rows_report)/60:.1f} мин")
    print(f"клипов на генерацию: {total_anim}   панорам бесплатно: {total_pan}")
    inrange = sum(1 for r in rows_report if 180 <= r[2] <= 420)
    print(f"в диапазоне 3–7 минут: {inrange} из {len(rows_report)}")


if __name__ == "__main__":
    main()
