# -*- coding: utf-8 -*-
"""Сверка состава сцены: кто описан в кадре, но не получил лист персонажа.

Лист персонажа подаётся в Gemini только для тех, кто перечислен в
`chars` сцены. Если человек назван в `img`/`anim`, но в `chars` его нет,
он рисуется «по памяти» — и на экране получается другой человек. Так на
практике «уплывали» лица, когда правку сцены писали, а список `chars`
забывали обновить следом.

Обратный случай тоже брак: персонаж есть в `chars`, но в тексте кадра не
упомянут — тогда модель не знает, что с ним делать, и ставит его как
придётся или не ставит вовсе.

    python engine/check_scene_cast.py [--write]

Без ключа печатает отчёт в консоль, с `--write` — кладёт его в
reports/scene-cast-audit.md.
"""
import io
import json
import os
import re
import sys

import paths  # noqa: E402  (engine/paths.py)
ROOT = str(paths.ROOT)
COMPILED = str(paths.COMPILED)
OUT = str(paths.REPORTS / "scene-cast-audit.md")


def name_stems(name):
    """Основы имени для поиска упоминания в тексте кадра.

    Основа — имя без последней буквы (покрывает падежи: «Анна» → «Анн» →
    «Анной»); для длинных имён с беглой гласной добавляется основа без двух
    букв («Олежек» → «Олеж» → «олежка»). Хвост склонения ограничен тремя
    буквами со границей слова — иначе короткая основа ловит случайные слова
    с тем же началом, а редкие падежи мимо основы не ловятся вовсе.
    """
    first = name.split()[0]
    stems = {first[:-1]} if len(first) > 3 else {first}
    if len(first) >= 6:
        stems.add(first[:-2])
    return stems


def mentioned(text, name):
    for stem in name_stems(name):
        if re.search(r"\b%s[а-яё]{0,3}\b" % re.escape(stem), text, re.IGNORECASE):
            return True
    return False


def audit():
    rows = []
    for fn in sorted(os.listdir(COMPILED)):
        if not fn.endswith(".json"):
            continue
        sn = json.load(io.open(os.path.join(COMPILED, fn), encoding="utf-8"))
        chars_map = sn.get("characters", {})
        for sc in sn.get("scenes", []):
            if sc.get("kind", "scene") != "scene":
                continue
            text = " ".join([sc.get("img", ""), sc.get("anim", "")])
            listed = set(sc.get("chars", []))
            missing, extra = [], []
            for key, meta in chars_map.items():
                if mentioned(text, meta.get("name", key)):
                    if key not in listed:
                        missing.append(meta.get("name", key))
                elif key in listed:
                    extra.append(meta.get("name", key))
            if missing or extra:
                rows.append((sn["id"], sc["id"], missing, extra))
    return rows


def render(rows):
    out = ["# Аудит состава сцен — 29.08.2026", ""]
    out.append("Строится `engine/check_scene_cast.py`.")
    out.append("")
    out.append("- **нет листа** — человек описан в кадре, но не в `chars`:")
    out.append("  Gemini рисует его без референса, получается другой человек;")
    out.append("- **лишний в chars** — лист подаётся, а в тексте кадра человека")
    out.append("  нет: модель ставит его наугад или теряет.")
    out.append("")
    out.append("| ролик | сцена | нет листа | лишний в chars |")
    out.append("| --- | --- | --- | --- |")
    for vid, sid, missing, extra in rows:
        out.append("| %s | %s | %s | %s |" % (
            vid, sid, ", ".join(missing) or "—", ", ".join(extra) or "—"))
    out.append("")
    out.append("Итого строк: %d" % len(rows))
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    rows = audit()
    text = render(rows)
    if "--write" in sys.argv:
        io.open(OUT, "w", encoding="utf-8").write(text)
        print("записано: %s (%d строк)" % (OUT, len(rows)))
    else:
        sys.stdout.buffer.write(text.encode("utf-8"))
