# -*- coding: utf-8 -*-
"""Заготовка план-листа FLF2V из сценария.

31.08.2026. Девять роликов серии дошли до съёмки без план-листов, а писать
их руками — по десять блоков текста на ролик. Скрипт делает скелет: разбивку
сцены на планы, имена мастеров, чейнинг ключей внутри сцены, счёт людей и
все постоянные оговорки (рамка, одежда, пустые поверхности, лишние руки).

Что скрипт НЕ делает: не придумывает действие. Русское описание берётся из
поля `anim` сцены, английский текст движения остаётся меткой <ДЕЙСТВИЕ>,
которую заполняет человек — по одной строке на план. Иначе Wan получает
пересказ вместо режиссуры, а это и есть источник половины брака.

    python engine/make_plans.py --id fog-signal-check
    python engine/make_plans.py --id ... --write

Без --write печатает, что получится, и ничего не пишет. Существующий
план-лист не перезаписывается никогда: если файл есть, скрипт откажется.
"""
import io
import json
import math
import os
import sys

import paths  # noqa: E402  (engine/paths.py)
ROOT = str(paths.ROOT)
PLANS = os.path.join(ROOT, "engine")
COMPILED = str(paths.COMPILED)

SEC_PER_PLAN = 5.0          # 81 кадр при 16 fps
MAX_PLANS_PER_SCENE = 3

WORDS_EN = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
            7: "seven", 8: "eight"}

EDIT_HEAD = ("Отредактируй это изображение, сохранив его точь-в-точь: та же "
             "комната, тот же свет, тот же стиль тонкого контура с бледной "
             "акварельной заливкой, те же персонажи в той же одежде на тех же "
             "местах. Изменение только одно: ")
EDIT_TAIL = (" Композиция, камера и предметы не меняются. В кадре ровно те же "
             "люди, что на исходном изображении, каждый в одном экземпляре; "
             "лишних рук в кадре нет. Всё, что написано или нарисовано на "
             "досках, экранах, бумагах и обложках, остаётся в точности таким "
             "же, как на исходном изображении: где поверхность пустая — она "
             "остаётся пустой. Рамка кадра в точности та же, что на исходном "
             "изображении: те же границы кадра, тот же масштаб и та же точка "
             "съёмки. Каждый предмет и каждый человек остаются того же размера "
             "в кадре и на том же месте относительно краёв кадра; ни "
             "приближения, ни отъезда, ни сдвига камеры. Одежда каждого "
             "человека остаётся ровно той же, что на исходном изображении: тот "
             "же покрой, тот же вырез, те же рукава и та же застёжка, та же "
             "ткань и тот же цвет. Причёска у каждого тоже та же.")

MOTION_TAIL = (" Every hand in the frame belongs to a person fully visible in "
               "the shot: there is no disembodied hand, no arm reaching in from "
               "outside the frame and no extra person. Nobody enters or leaves "
               "the frame and nobody appears twice. Everyone keeps their seat "
               "and nobody stands up. Hand-drawn illustration, thin ink "
               "outlines, pale watercolor wash. Static locked-off camera, no "
               "camera movement, no cuts. All characters keep their exact "
               "appearance, clothing and positions.")

MARK = "<ДЕЙСТВИЕ>"


def head_en(n):
    if n == 1:
        return ("Exactly one person is in the shot and nobody else enters the "
                "room; every hand in the frame belongs to them. ")
    return ("Exactly %s people are in the shot and nobody else enters the room; "
            "every hand in the frame belongs to one of them. " % WORDS_EN[n])


def main():
    argv = sys.argv[1:]
    if "--id" not in argv:
        print(__doc__)
        return 2
    vid = argv[argv.index("--id") + 1]
    write = "--write" in argv

    out = os.path.join(PLANS, "flf_plans_%s.json" % vid)
    if os.path.exists(out) and write:
        print("%s уже существует — не трогаю" % os.path.basename(out))
        return 1

    scen = json.load(io.open(os.path.join(COMPILED, vid + ".json"), encoding="utf-8"))
    plans = []
    n = 0
    for sc in scen["scenes"]:
        if sc.get("kind") in ("title", "memo") or not sc.get("img"):
            continue
        t = sc.get("t") or [0, 10]
        dur = max(SEC_PER_PLAN, t[1] - t[0])
        count = min(MAX_PLANS_PER_SCENE, max(1, int(math.ceil(dur / SEC_PER_PLAN))))
        chars = len(sc.get("chars") or []) or 1
        anim = (sc.get("anim") or "").strip().rstrip(".")
        # Схема сцены: один ОБЩИЙ план (мастер -> ключ) плюс крупные планы
        # одного человека без ключа. Крупный стоит только опорного кадра
        # (krupno.mjs), ключ ему не нужен — узел FLF2V работает и без
        # конечного кадра. Выходит та же цена, что у второго общего плана,
        # но брака меньше: в кадре один человек, уводить нечего.
        n += 1
        plans.append({
            "plan": n,
            "scene": sc["id"],
            "master": "%s_sh1_frame.png" % sc["id"],
            "frames": 81,
            "edit": EDIT_HEAD + (anim if anim else MARK) + "." + EDIT_TAIL,
            "motion": head_en(chars) + MARK + MOTION_TAIL,
        })
        speaker = (sc.get("chars") or ["roksana"])[0]
        for k in range(count - 1):
            n += 1
            plans.append({
                "plan": n,
                "scene": sc["id"],
                "master": "%s_sh%d_frame.png" % (sc["id"], 7 + k),
                "frames": 81,
                "i2v": True,
                "krupno": speaker,
                "edit": "",
                "motion": ("Exactly one person is in the shot: " + MARK +
                           " This person is alone in the frame from the first "
                           "frame to the last. The left edge, the right edge, "
                           "the top and the bottom of the frame stay empty: the "
                           "room continues quietly behind them and nothing else "
                           "moves there. Nobody hands them anything, nobody "
                           "touches them, nobody greets them, and their own two "
                           "hands are the only hands in the picture. They stay "
                           "in their seat and keep the same object in their "
                           "hands the whole time. Hand-drawn illustration, thin "
                           "ink outlines, pale watercolor wash, shallow depth of "
                           "field. Static locked-off camera, no camera movement, "
                           "no cuts. The character keeps their exact appearance "
                           "and clothing."),
            })

    doc = {"id": vid, "plans": plans}
    todo = [p["plan"] for p in plans if MARK in p["motion"] or MARK in p["edit"]]
    print("%s: сцен %d, планов %d" % (vid, len({p["scene"] for p in plans}), len(plans)))
    for p in plans:
        print("  план %-3d %-5s %-26s %s" % (
            p["plan"], p["scene"], p["master"],
            "русское действие из сценария" if MARK not in p["edit"] else "НУЖНО ДЕЙСТВИЕ"))
    print("\nзаполнить <ДЕЙСТВИЕ> в планах: %s" % ", ".join(map(str, todo)))
    if write:
        io.open(out, "w", encoding="utf-8").write(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        print("записано: %s" % os.path.relpath(out, ROOT))
    else:
        print("(вхолостую; добавьте --write)")
    return 0


sys.exit(main())
