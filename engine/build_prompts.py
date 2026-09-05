#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Сборка промптов серии из машинночитаемых сценариев.

Читает:
  workspace/prompts/series.yaml       — стиль, персонажи, фоны
  workspace/prompts/scenarios/*.yaml  — сценарии

Пишет:
  workspace/prompts/sheets/<id>.md    — листы промптов
      (копировать в Gemini: промпт кадра + список вложений + промпт анимации)
  workspace/prompts/sheets/_backgrounds.md — промпты фонов
  workspace/prompts/compiled/<id>.json — компилят для
      конвейера монтажа (engine/assemble_video.mjs)

Запуск:  python engine/build_prompts.py
Идемпотентен: перегенерирует всё каждый раз.
"""
import json
import sys
from pathlib import Path

import yaml

import paths  # engine/paths.py
ROOT = paths.ROOT
PROMPTS = paths.PROMPTS
SHEETS = PROMPTS / "sheets"
COMPILED = PROMPTS / "compiled"

# LoRA trigger tokens, if the series has a trained LoRA: the character's
# `lora_trigger` field in series.yaml. Without one the prompt carries only the
# description — enough for the reference-sheet approach (see README).
TRIGGERS = {}


def _load_triggers(series):
    TRIGGERS.update({cid: ch["lora_trigger"] for cid, ch in series["characters"].items() if ch.get("lora_trigger")})


def load_yaml(path: Path):
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def fmt_t(t):
    def mmss(sec):
        return f"{int(sec) // 60}:{int(sec) % 60:02d}"
    return f"{mmss(t[0])}–{mmss(t[1])}"


def char_attachments(series, char_id, ref_keys):
    ch = series["characters"].get(char_id)
    if ch is None:
        raise KeyError(f"неизвестный персонаж: {char_id}")
    if ch.get("planned"):
        return [f"⛔ {ch['name']}: лист персонажа ещё не сгенерирован "
                f"(см. characters-new.md) — сцена заблокирована"]
    base_dir = ch["dir"]
    out = []
    for key in ref_keys:
        fname = ch["refs"].get(key)
        if fname is None:
            out.append(f"⚠ {ch['name']}: нет референса «{key}»")
        else:
            out.append(f"{base_dir}/{fname}  ({ch['name']}: {key})")
    return out


def image_prompt(series, sc):
    parts = [series["style"].strip()]
    bg = series["backgrounds"].get(sc.get("bg", ""), None)
    if bg:
        parts.append(f"Локация: {bg['desc'].strip()}.")
    for cid in sc.get("chars", []):
        ch = series["characters"][cid]
        parts.append(ch["passport"].strip() + ".")
    parts.append(sc["img"].strip())
    parts.append(series["negative"].strip())
    if sc.get("chars"):
        parts.append(series["consistency"].strip())
    return "\n\n".join(parts)


def anim_prompt(series, sc):
    return (f"Оживи этот кадр (image-to-video, первый кадр — приложенное "
            f"изображение): {sc['anim'].strip()} "
            + series["animation_rules"].strip()
            + " Длительность сегмента: 8 секунд.")


def scene_attachments(series, sc):
    out = []
    for cid in sc.get("chars", []):
        ch = series["characters"][cid]
        keys = (sc.get("refs") or {}).get(cid) or ch.get("attach_default") or []
        out.extend(char_attachments(series, cid, keys))
    bg_id = sc.get("bg")
    if bg_id:
        bg = series["backgrounds"][bg_id]
        path = bg.get("file") or f"workspace/backgrounds/{bg_id}.png"
        mark = "" if bg.get("file") else "  ⚠ файл фона ещё не сгенерирован"
        out.append(f"{path}  (фон «{bg['name']}»){mark}")
    return out


def build_sheet(series, sn):
    lines = []
    lines.append(f"# Промпты — «{sn['title']}»")
    lines.append("")
    lines.append(f"Раскадровка: `../scenarios/{sn['scenario']}` · Цель "
                 f"хронометража: ~{sn['duration_target']} с")
    if sn.get("blocked_by"):
        lines.append("")
        lines.append(f"⛔ **Блокер:** {sn['blocked_by']}")
    if sn.get("approval_required"):
        lines.append("")
        lines.append(f"⚠ **Перед продакшеном:** {sn['approval_required']}")
    lines.append("")
    lines.append("Порядок работы с каждой сценой: ① сгенерировать кадр "
                 "(промпт + вложения) → ② выбрать лучший дубль → ③ оживить "
                 "кадр промптом анимации (image-to-video, вложение — "
                 "выбранный кадр). Заставка, разделители и памятка не "
                 "генерируются — их рендерит конвейер.")
    lines.append("")
    for sc in sn["scenes"]:
        kind = sc.get("kind", "scene")
        if kind == "title":
            lines.append(f"## {sc['id']} · Заставка ({fmt_t(sc['t'])}) — "
                         f"программный рендер")
            lines.append("")
            lines.append(f"- Название на плашке: **{sc['plate']}**")
            lines.append(f"- Войсовер: «{sc['vo']}»")
            lines.append("")
            continue
        if kind == "divider":
            lines.append(f"## {sc['id']} · Разделитель ({fmt_t(sc['t'])}) — "
                         f"программный рендер")
            lines.append("")
            lines.append(f"- Надпись: **{sc['plate']}**")
            if sc.get("vo"):
                lines.append(f"- Войсовер: «{sc['vo']}»")
            lines.append("")
            continue
        if kind == "clip":
            # Сцена, картинка которой уже существует файлом: запись экрана,
            # отрисованная схема, врезка из готового эпизода. Генерировать
            # нечего — лист только фиксирует источник и войсовер.
            lines.append(f"## {sc['id']} · Готовая вставка ({fmt_t(sc['t'])}) — "
                         f"`{sc.get('file', '?')}`")
            lines.append("")
            if sc.get("plate"):
                lines.append(f"- Плашка: **{sc['plate']}**")
            if sc.get("at"):
                lines.append(f"- Смещение в источнике: {sc['at']} с")
            if sc.get("vo"):
                lines.append(f"- Войсовер: «{sc['vo']}»")
            lines.append("")
            continue
        if kind == "memo":
            lines.append(f"## {sc['id']} · Финальная памятка "
                         f"({fmt_t(sc['t'])}) — программный рендер")
            lines.append("")
            lines.append(f"- Заголовок: **{sc['memo']['title']}**")
            for item in sc["memo"]["items"]:
                lines.append(f"  - {item}")
            lines.append(f"- Войсовер: «{sc['vo']}»")
            lines.append("")
            continue
        lines.append(f"## {sc['id']} · Сцена ({fmt_t(sc['t'])}) — плашка: "
                     f"«{sc['plate']}»")
        lines.append("")
        if sc.get("vo"):
            lines.append(f"Войсовер сцены: «{sc['vo']}»")
            lines.append("")
        lines.append("### ① Промпт кадра (Gemini, генерация изображения)")
        lines.append("")
        lines.append("```")
        lines.append(image_prompt(series, sc))
        lines.append("```")
        lines.append("")
        atts = scene_attachments(series, sc)
        lines.append("**Вложения к промпту кадра:**")
        lines.append("")
        if atts:
            for a in atts:
                lines.append(f"- `{a}`" if not a.startswith(("⛔", "⚠")) else f"- {a}")
        else:
            lines.append("- (без вложений — сцена без персонажей; стиль "
                         "держится текстом и референсом фона)")
        lines.append("")
        lines.append("### ② Промпт анимации (Flow/Veo, image-to-video)")
        lines.append("")
        lines.append("```")
        lines.append(anim_prompt(series, sc))
        lines.append("```")
        lines.append("")
        lines.append("**Вложение:** выбранный дубль кадра из шага ①.")
        lines.append("")
        lines.append(f"Готовый сегмент сохранить как "
                     f"`production/takes/{sn['id']}/{sc['id']}_take1.mp4` "
                     f"(дубли — take2, take3…).")
        lines.append("")
    return "\n".join(lines) + "\n"


# Негатив для пустых локаций: правила про рты и взгляды персонажей
# здесь неприменимы, поэтому у фонов свой блок.
BG_NEGATIVE = (
    "В кадре нет людей. В кадре нет текста, надписей, вывесок, логотипов, "
    "брендов и субтитров. Никаких экранов с интерфейсами. Перспектива без "
    "искажений, линии стен прямые."
)

BG_SAME_ROOM = (
    "Помещение то же самое, что на приложенном референсном изображении: "
    "те же стены, пол, окна, мебель и освещение. Меняется только ракурс "
    "и то, что перечислено ниже."
)


def flat(value):
    return " ".join(str(value).split())


def build_backgrounds_sheet(series):
    """Лист промптов банка фонов.

    Поля фона в series.yaml:
      wave      — 0 базовый состав, 1 добор 22.08
      priority  — high | normal, порядок генерации
      base_ref  — id фона, PNG которого прикладывается к промпту: вариант
                  должен читаться как то же помещение
      note      — пояснение генерящему, в лист выносится цитатой
    """
    backgrounds = series["backgrounds"]
    style = flat(series["style"])

    lines = [
        "# Промпты банка фонов",
        "",
        "<!-- Файл собирается engine/build_prompts.py из блока",
        "     `backgrounds` в series.yaml. Руками не править. -->",
        "",
        "Каждый фон генерируется один раз, без персонажей; лучший дубль "
        "сохраняется в `production/backgrounds/<id>.png` и дальше "
        "прикладывается к промптам сцен этой локации.",
        "",
        "Волна 0 — состав, спроектированный вместе со сценариями. Волна 1 — "
        "добор от 22.08: санузлы, адаптационная квартира по комнатам, улица "
        "с фургоном, молитвенный угол. Порядок генерации — сначала всё "
        "`приоритет: high`.",
        "",
        "У фона с полем «референс» к промпту обязательно прикладывается "
        "готовый PNG указанного фона: вариант должен читаться как то же "
        "помещение, а не как другое здание.",
        "",
    ]

    waves = sorted({int(b.get("wave", 0)) for b in backgrounds.values()})
    for wave in waves:
        lines.append(f"## Волна {wave} — "
                     + ("добор 22.08" if wave else "базовый состав"))
        lines.append("")
        for bid, bg in backgrounds.items():
            if int(bg.get("wave", 0)) != wave:
                continue
            lines.append(f"### {bid} — {bg['name']}")
            lines.append("")
            marks = []
            if bg.get("priority"):
                marks.append(f"приоритет: {bg['priority']}")
            if bg.get("base_ref"):
                marks.append(f"референс: `{bg['base_ref']}.png`")
            if bg.get("generated_by"):
                marks.append(f"сгенерирован: {bg['generated_by']}")
            if bg.get("file"):
                marks.append(f"готов: `{bg['file'].rsplit('/', 1)[-1]}`")
            if marks:
                lines.append("*" + "; ".join(marks) + "*")
                lines.append("")
            if bg.get("note"):
                lines.append("> " + flat(bg["note"]))
                lines.append("")
            lines.append("```")
            lines.append(style)
            lines.append("")
            if bg.get("base_ref"):
                lines.append(BG_SAME_ROOM)
                lines.append("")
            lines.append(f"Пустая локация без людей: {flat(bg['desc'])}.")
            lines.append("")
            lines.append(BG_NEGATIVE)
            lines.append("```")
            lines.append("")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main():
    series = load_yaml(PROMPTS / "series.yaml")
    _load_triggers(series)
    for bid, bg in series["backgrounds"].items():
        ref = bg.get("base_ref")
        if ref and ref not in series["backgrounds"]:
            print(f"series.yaml: фон {bid} ссылается на несуществующий "
                  f"base_ref {ref}", file=sys.stderr)
            return 1
    SHEETS.mkdir(exist_ok=True)
    COMPILED.mkdir(exist_ok=True)

    scen_files = sorted((PROMPTS / "scenarios").glob("*.yaml"))
    if not scen_files:
        print("Нет сценариев в prompts/scenarios/", file=sys.stderr)
        return 1

    index = []
    retired = []
    errors = 0
    for f in scen_files:
        sn = load_yaml(f)
        if sn.get("retired"):
            # Ролик снят с производства: листы и компилят не собираем,
            # файл сценария остаётся в репозитории как история.
            retired.append((sn["id"], sn["title"], sn["retired"]))
            print(f"{sn['id']}: снят — {sn['retired'][:60]}…")
            continue
        # валидация
        for sc in sn["scenes"]:
            kind = sc.get("kind", "scene")
            if kind == "scene":
                for req in ("img", "anim", "t", "plate"):
                    if req not in sc:
                        print(f"{f.name}: сцена {sc.get('id')} без поля "
                              f"«{req}»", file=sys.stderr)
                        errors += 1
                for cid in sc.get("chars", []):
                    if cid not in series["characters"]:
                        print(f"{f.name}: неизвестный персонаж {cid}",
                              file=sys.stderr)
                        errors += 1
                if sc.get("bg") and sc["bg"] not in series["backgrounds"]:
                    print(f"{f.name}: неизвестный фон {sc['bg']}",
                          file=sys.stderr)
                    errors += 1
        sheet = build_sheet(series, sn)
        out_md = SHEETS / f"{sn['id']}.md"
        out_md.write_text(sheet, encoding="utf-8")
        # В компилят кладём и то, что живёт на уровне серии: конвейеру
        # генерации (comfy_batch.mjs) нужен хвост промпта анимации, а
        # сборщику — палитра и негатив. Иначе им пришлось бы читать YAML.
        compiled = dict(sn)
        compiled["animation_rules"] = series["animation_rules"].strip()
        compiled["style"] = series["style"].strip()
        compiled["negative"] = series["negative"].strip()
        # Звену генерации кадров (comfy_frames.mjs) нужны две вещи, которых
        # в сценарии нет: файл фона и триггер-токен персонажа. Кладём в
        # компилят только то, что этот ролик реально использует.
        used_bg = {sc["bg"] for sc in sn["scenes"] if sc.get("bg")}
        used_ch = {c for sc in sn["scenes"] for c in sc.get("chars", [])}
        compiled["backgrounds"] = {
            b: {"name": series["backgrounds"][b].get("name", b),
                "file": series["backgrounds"][b].get("file"),
                "desc": series["backgrounds"][b].get("desc", "").strip()}
            for b in sorted(used_bg) if b in series["backgrounds"]}
        compiled["characters"] = {
            c: {"name": series["characters"][c].get("name", c),
                "trigger": TRIGGERS.get(c),
                "passport": series["characters"][c].get("passport", "").strip()}
            for c in sorted(used_ch) if c in series["characters"]}
        out_json = COMPILED / f"{sn['id']}.json"
        out_json.write_text(json.dumps(compiled, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        n_gen = sum(1 for sc in sn["scenes"]
                    if sc.get("kind", "scene") == "scene")
        index.append((sn["id"], sn["title"], n_gen,
                      sn.get("blocked_by", "")))
        print(f"{sn['id']}: {n_gen} генерируемых сцен -> sheets/{sn['id']}.md")

    (SHEETS / "_backgrounds.md").write_text(
        build_backgrounds_sheet(series), encoding="utf-8")

    idx = ["# Индекс листов промптов", "",
           f"В производстве: {len(index)} роликов.", "",
           "| Ролик | Сцен на генерацию | Блокер |", "|---|---|---|"]
    for sid, title, n, blocked in index:
        idx.append(f"| [{title}]({sid}.md) | {n} | {blocked or '—'} |")
    if retired:
        idx += ["", "## Сняты с производства", "",
                "| Ролик | Основание |", "|---|---|"]
        for sid, title, why in retired:
            idx.append(f"| {title} | {why} |")
    (SHEETS / "_index.md").write_text("\n".join(idx) + "\n", encoding="utf-8")

    total = sum(n for _, _, n, _ in index)
    print(f"\nИтого: {len(index)} роликов, {total} генерируемых сцен, "
          f"ошибок валидации: {errors}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
