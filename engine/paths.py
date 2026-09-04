"""Repository root and workspace paths, read from engine/pipeline.config.json.

Every Python script in the engine goes through here, so the workspace can be
moved by editing one config key instead of one constant per script.
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "engine" / "pipeline.config.json").read_text(encoding="utf-8"))
_P = CONFIG["paths"]

COMPILED = ROOT / _P["compiled"]
TAKES = ROOT / _P["takes"]
OUT = ROOT / _P["out"]
BUILD = ROOT / _P["build"]
PROMPTS = COMPILED.parent          # workspace/prompts
BACKGROUNDS = ROOT / "workspace" / "backgrounds"
REPORTS = ROOT / "reports"

for _d in (REPORTS,):
    os.makedirs(_d, exist_ok=True)
