"""Read, create and edit scenario YAML — the one place that touches those files.

The scenario is the source of truth for an episode: everything downstream is
compiled from it. So editing it needs to keep the file readable by a person
afterwards (block scalars for prose, keys in a fixed order) rather than the
flattened one-line YAML a naive dump produces.

The interface calls this; so can you:

    python engine/scenario.py list
    python engine/scenario.py read --id fog-signal-check
    python engine/scenario.py new  --id my-roll --title "My roll" --duration 72
    python engine/scenario.py write --id my-roll        # JSON on stdin
    python engine/scenario.py delete --id my-roll

`read` and `list` print JSON. `new` and `write` print the path they wrote.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import yaml

import paths

SCENARIOS = paths.PROMPTS / "scenarios"
# Prose fields are written as block scalars: a scene description is a paragraph,
# and a paragraph on one 400-character line is unreadable in a diff.
BLOCK_FIELDS = {"img", "anim", "vo", "style", "negative", "consistency"}
SCENE_ORDER = ["id", "kind", "t", "vo_at", "motion", "plate", "chars", "refs", "bg",
               "img", "anim", "memo", "items", "vo"]
TOP_ORDER = ["id", "title", "scenario", "duration_target", "scenes"]


def slugify(title):
    """A title to a file-safe id: lowercase, ASCII, hyphens."""
    table = {"а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
             "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
             "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
             "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
             "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya"}
    s = "".join(table.get(ch, ch) for ch in (title or "").lower())
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "roll"


class _Dumper(yaml.SafeDumper):
    """Indents list items under their key, the way the hand-written files are."""

    def increase_indent(self, flow=False, indentless=False):
        return super().increase_indent(flow, False)


def _block(dumper, data):
    if "\n" in data or len(data) > 70:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=">")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


class _Prose(str):
    pass


class _Inline(list):
    """A short list that stays on one line: [0, 6] reads better than two rows."""


_Dumper.add_representer(_Prose, _block)
_Dumper.add_representer(
    _Inline, lambda d, v: d.represent_sequence("tag:yaml.org,2002:seq", list(v), flow_style=True)
)


def _ordered(d, order):
    """Keys in a fixed order, so a rewritten file diffs against the old one."""
    out = {k: d[k] for k in order if k in d}
    out.update({k: v for k, v in d.items() if k not in out})
    return out


def _mark_prose(scene):
    out = {}
    for k, v in scene.items():
        if k in BLOCK_FIELDS and isinstance(v, str):
            out[k] = _Prose(v)
        elif k == "t" and isinstance(v, (list, tuple)):
            out[k] = _Inline(v)
        else:
            out[k] = v
    return out


def path_of(roll_id):
    return SCENARIOS / f"{roll_id}.yaml"


def read(roll_id):
    p = path_of(roll_id)
    if not p.exists():
        raise SystemExit(f"no scenario for {roll_id}: {p}")
    return yaml.safe_load(p.read_text(encoding="utf-8"))


def write(doc):
    """Write the scenario back, keeping it readable."""
    roll_id = doc["id"]
    doc = _ordered(doc, TOP_ORDER)
    doc["scenes"] = [_mark_prose(_ordered(s, SCENE_ORDER)) for s in doc.get("scenes", [])]
    SCENARIOS.mkdir(parents=True, exist_ok=True)
    p = path_of(roll_id)
    body = yaml.dump(doc, Dumper=_Dumper, allow_unicode=True, sort_keys=False, width=78)
    header = (f"# {doc.get('title', roll_id)}\n"
              "#\n"
              "# Edited through the interface or by hand — both write this file. Compile it\n"
              "# with: python engine/build_prompts.py\n\n")
    p.write_text(header + body, encoding="utf-8")
    return p


def new(roll_id, title, duration):
    """A starter episode: title card, one scene to fill in, closing memo."""
    if path_of(roll_id).exists():
        raise SystemExit(f"{roll_id} already exists: {path_of(roll_id)}")
    body = max(int(duration) - 20, 10)
    doc = {
        "id": roll_id,
        "title": title,
        "scenario": f"{title}.md",
        "duration_target": int(duration),
        "scenes": [
            {"id": "s0", "kind": "title", "t": [0, 6], "vo_at": 1, "plate": title,
             "vo": "One sentence that says what this episode is about."},
            {"id": "s1", "t": [6, 6 + body], "vo_at": 0.5, "motion": "anim",
             "plate": "Step 1", "chars": [], "bg": None,
             "img": "What is in the frame: who, where, doing what, and how close the shot is.",
             "anim": "The one movement this shot makes, start to finish.",
             "vo": "What the narrator says over this scene."},
            {"id": "s2", "kind": "memo", "t": [6 + body, int(duration)], "vo_at": 1,
             "plate": title,
             "memo": {"title": title, "items": ["First point", "Second point", "Third point"]},
             "vo": "The closing line."},
        ],
    }
    return write(doc)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("read", "write", "delete"):
        sp = sub.add_parser(name)
        sp.add_argument("--id", required=True)
    sub.add_parser("list")
    sp = sub.add_parser("new")
    sp.add_argument("--id", required=True)
    sp.add_argument("--title", required=True)
    sp.add_argument("--duration", type=int, default=72)
    args = ap.parse_args()

    if args.cmd == "list":
        print(json.dumps(sorted(p.stem for p in SCENARIOS.glob("*.yaml"))))
    elif args.cmd == "read":
        print(json.dumps(read(args.id), ensure_ascii=False))
    elif args.cmd == "new":
        print(new(args.id, args.title, args.duration))
    elif args.cmd == "write":
        doc = json.load(sys.stdin)
        doc["id"] = args.id
        print(write(doc))
    elif args.cmd == "delete":
        p = path_of(args.id)
        if p.exists():
            p.unlink()
        # The compiled copy goes too, or the roll lingers in the interface.
        c = paths.COMPILED / f"{args.id}.json"
        if c.exists():
            c.unlink()
        print(p)


if __name__ == "__main__":
    main()
