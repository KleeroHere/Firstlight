# -*- coding: utf-8 -*-
"""Сверка счёта людей в план-листах FLF2V со списком персонажей сцены.

Ночь 31.08.2026. В «Ежедневниках» ключ 3 стёр из кадра трёх человек: в
тексте правки осталась фраза «В комнате ровно два человека и больше
никого» — от старой редакции сцены, где их и было двое. Gemini выполнил
инструкцию буквально, а следующий план унаследовал пустой круг. То же
число живёт и в английских текстах движения («Exactly five people are in
the shot»), и Wan читает его так же буквально.

Скрипт проходит по всем flf_plans_*.json, вытаскивает число людей из
русского текста правки и из английского текста движения и сравнивает со
списком chars той же сцены в скомпилированном сценарии.

    python engine/check_plan_counts.py [--fix]

Без --fix только показывает расхождения. С --fix подставляет верное число
(и в русский, и в английский текст) — идемпотентно.
"""
import glob
import io
import json
import os
import re
import sys

import paths  # noqa: E402  (engine/paths.py)
ROOT = str(paths.ROOT)
PLANS = os.path.join(ROOT, "engine")
COMPILED = str(paths.COMPILED)
FIX = "--fix" in sys.argv

RU = {1: "один", 2: "два", 3: "три", 4: "четыре", 5: "пять", 6: "шесть",
      7: "семь", 8: "восемь"}
RU_NUM = {v: k for k, v in RU.items()}
EN = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
      7: "seven", 8: "eight"}
EN_NUM = {v: k for k, v in EN.items()}

# «В комнате ровно два человека», «в кадре ровно 6 ЧЕЛОВЕК»
RU_RE = re.compile(r"(В\s+(?:комнате|кадре)\s+ровно\s+)([а-яё]+|\d+)(\s+(?:человека?|ЧЕЛОВЕК))",
                   re.IGNORECASE)
EN_RE = re.compile(r"(Exactly\s+)(one|two|three|four|five|six|seven|eight)(\s+(?:person|people))")

# Осознанные расхождения — их --fix не трогает.
EXCEPT = {
    # «Изменение в расписании», план 7: в комнате действительно ОДИН человек,
    # а двое других стоят за стеклом во дворе. Ролик снят и принят владельцем
    # именно с этой формулировкой: раньше там стояло «three people in the
    # shot», и Wan заводил обоих дворовых внутрь комнаты.
    ("izmenenie-v-raspisanii", 7, "motion"),
    # «Завершение смены-1», план 9: текст движения вообще от другой сцены
    # (Роксана Сергеевна зовёт кого-то в дверях, а по сцене она одна отпирает
    # кухню). Это не число править надо, а переписывать план целиком, когда
    # владелец пересдаст кадры s3/s4.
    ("zavershenie-smeny-1", 9, "motion"),
}

bad = []
for f in sorted(glob.glob(os.path.join(PLANS, "flf_plans_*.json"))):
    vid = os.path.basename(f)[len("flf_plans_"):-len(".json")]
    cf = os.path.join(COMPILED, vid + ".json")
    if not os.path.exists(cf):
        continue
    scenes = {s["id"]: s for s in json.load(io.open(cf, encoding="utf-8"))["scenes"]}
    data = json.load(io.open(f, encoding="utf-8"))
    touched = False
    for p in data["plans"]:
        # Крупный план (i2v) сознательно снимает одного человека из сцены,
        # где людей больше: счёт по chars к нему не применяется.
        if p.get("i2v"):
            continue
        sc = scenes.get(p["scene"])
        if not sc:
            continue
        want = len(sc.get("chars") or [])
        if not want:
            continue
        for field, rx, words, back in (("edit", RU_RE, RU, RU_NUM),
                                       ("motion", EN_RE, EN, EN_NUM),
                                       ("motionBack", EN_RE, EN, EN_NUM)):
            text = p.get(field)
            if not text:
                continue
            m = rx.search(text)
            if not m:
                continue
            got = back.get(m.group(2).lower())
            if got is None:
                got = int(m.group(2)) if m.group(2).isdigit() else None
            if got is None or got == want:
                continue
            skip = (vid, p["plan"], field) in EXCEPT
            bad.append((vid, p["plan"], p["scene"], field, got, want, skip))
            if FIX and not skip and want in words:
                p[field] = text[:m.start()] + m.group(1) + words[want] + m.group(3) + text[m.end():]
                touched = True
    if touched:
        io.open(f, "w", encoding="utf-8").write(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n")

if not bad:
    print("счёт людей во всех план-листах совпадает со сценами")
else:
    print("%-32s %-5s %-5s %-11s %s" % ("ролик", "план", "сцена", "поле", "в тексте -> в сцене"))
    for vid, plan, scene, field, got, want, skip in bad:
        print("%-32s %-5d %-5s %-11s %d -> %d%s"
              % (vid, plan, scene, field, got, want, "   (так и надо)" if skip else ""))
    n = len([b for b in bad if not b[6]])
    print("\nрасхождений: %d, из них осознанных: %d%s"
          % (len(bad), len(bad) - n, "; исправлено %d" % n if FIX else "; прогон без --fix"))
