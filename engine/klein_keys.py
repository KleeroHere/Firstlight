#!/usr/bin/env python
"""Ключи/кадры через Flux 2 Klein 9B (distilled) на локальном ComfyUI.

Один из трёх способов получить опорный кадр (см. docs/ARCHITECTURE.md,
backends.keys): "gemini" (gemini_shots.mjs / flf_keys.mjs, платный API,
референсы через image-edit), "manual" (ingest_manual_shots.mjs, кадр
сгенерирован руками в веб-интерфейсе), и этот — "klein": локально, бесплатно,
без ограничений квоты, но модель заметно меньше и держит меньше референсов
за раз (тут — до трёх, все через ReferenceLatent, а не батчем).

    python engine/klein_keys.py --ref master.png [--ref face.png] --prompt "..." \
        --out out.png [--size 1280x720] [--seed 1] [--steps 4] [--cfg 1]

Граф повторяет шаблон ComfyUI image_flux2_klein_image_edit_9b_distilled:
UNETLoader(fp8) → CFGGuider(cfg 1) с ReferenceLatent по каждому референсу,
Flux2Scheduler 4 шага, euler, EmptyFlux2LatentImage нужного размера.
VAE: flux_vae.safetensors (32-канальный VAE Flux.2; тот же, что
full_encoder_small_decoder в шаблоне, только с полным декодером).

Требует локальный ComfyUI с моделями Flux.2 Klein 9B distilled (fp8) и
Qwen 3 8B (fp8, текстовый энкодер) уже установленными. Хост и папка входа
ComfyUI — через переменные окружения COMFY_HOST / COMFY_INPUT, значения по
умолчанию — стандартная локальная установка на 127.0.0.1:8188.
"""
import argparse, json, os, shutil, sys, time, urllib.request, uuid

HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
INPUT_DIR = os.environ.get("COMFY_INPUT", os.path.join(os.path.expanduser("~"), "ComfyUI", "input"))


def api(path, data=None):
    req = urllib.request.Request(f"http://{HOST}{path}",
                                 data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {path}: {e.read().decode('utf-8','replace')[:3000]}")


def build(refs, prompt, w, h, seed, steps, cfg, negative=""):
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux-2-klein-9b-fp8.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen_3_8b_fp8mixed.safetensors", "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "flux_vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}} if not negative else
             {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["2", 0]}},
        "10": {"class_type": "EmptyFlux2LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "11": {"class_type": "Flux2Scheduler", "inputs": {"steps": steps, "width": w, "height": h}},
        "12": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "13": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
    }
    pos, neg = ["4", 0], ["5", 0]
    for i, ref in enumerate(refs):
        n = 20 + i * 10
        g[str(n)] = {"class_type": "LoadImage", "inputs": {"image": ref}}
        g[str(n + 1)] = {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": [str(n), 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 1}}
        g[str(n + 2)] = {"class_type": "VAEEncode", "inputs": {"pixels": [str(n + 1), 0], "vae": ["3", 0]}}
        g[str(n + 3)] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": pos, "latent": [str(n + 2), 0]}}
        g[str(n + 4)] = {"class_type": "ReferenceLatent", "inputs": {"conditioning": neg, "latent": [str(n + 2), 0]}}
        pos, neg = [str(n + 3), 0], [str(n + 4), 0]
    g["50"] = {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": pos, "negative": neg, "cfg": cfg}}
    g["51"] = {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["13", 0], "guider": ["50", 0], "sampler": ["12", 0], "sigmas": ["11", 0], "latent_image": ["10", 0]}}
    g["52"] = {"class_type": "VAEDecode", "inputs": {"samples": ["51", 0], "vae": ["3", 0]}}
    g["53"] = {"class_type": "SaveImage", "inputs": {"images": ["52", 0], "filename_prefix": "klein/key"}}
    return g


def run(refs, prompt, out, size="1280x720", seed=1, steps=4, cfg=1.0, negative=""):
    w, h = (int(x) for x in size.lower().split("x"))
    names = []
    os.makedirs(INPUT_DIR, exist_ok=True)
    for r in refs:
        name = f"klein_{uuid.uuid4().hex[:8]}{os.path.splitext(r)[1]}"
        shutil.copy(r, os.path.join(INPUT_DIR, name))
        names.append(name)
    g = build(names, prompt, w, h, seed, steps, cfg, negative)
    t0 = time.time()
    pid = api("/prompt", {"prompt": g, "client_id": "klein_keys"})["prompt_id"]
    while True:
        time.sleep(2)
        h_ = api(f"/history/{pid}")
        if pid in h_:
            st = h_[pid].get("status", {})
            if st.get("status_str") == "error":
                msgs = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                raise SystemExit(f"ComfyUI error: {json.dumps(msgs, ensure_ascii=False)[:2000]}")
            imgs = h_[pid]["outputs"]["53"]["images"]
            break
    im = imgs[0]
    url = f"http://{HOST}/view?filename={urllib.request.quote(im['filename'])}&subfolder={urllib.request.quote(im.get('subfolder',''))}&type=output"
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as r, open(out, "wb") as f:
        f.write(r.read())
    for n in names:
        try: os.remove(os.path.join(INPUT_DIR, n))
        except OSError: pass
    return time.time() - t0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", action="append", required=True, help="референс (до 2–3), первый — основной")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--negative", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", default="1280x720")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--cfg", type=float, default=1.0)
    a = ap.parse_args()
    dt = run(a.ref, a.prompt, a.out, a.size, a.seed, a.steps, a.cfg, a.negative)
    print(f"{a.out}  {dt:.0f} s")
