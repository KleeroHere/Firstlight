# -*- coding: utf-8 -*-
"""Приведение ключей FLF2V к рамке их мастера.

Зачем. Приёмка клипов 30.08.2026: внутри клипа камера медленно наезжала,
хотя в промпте стоит «static locked-off camera», а в негативе — «camera
zoom». Разбор показал, что Wan не виноват: Gemini при каждой правке
перерисовывает кадр чуть теснее предыдущего, и FLF2V честно интерполирует
между двумя РАЗНЫМИ кадрировками. Словами это не лечится — пробовали
(«рамка кадра в точности та же»), рамка всё равно ползёт.

Лечится геометрией. Gemini не поворачивает и не искажает кадр, он только
слегка меняет масштаб и сдвиг, поэтому достаточно найти пару (масштаб,
сдвиг) и вернуть ключ в рамку мастера.

Метод: фазовая корреляция (scipy.fft) на перебор масштаба. Для каждого
пробного масштаба ключ ужимается/растягивается, считается корреляция с
мастером, берётся масштаб с самым острым пиком. Поворота не ищем — его нет.

    python engine/align_keys.py --id fog-signal-check [--dry]

Оригинал ключа сохраняется рядом как plan<N>_key.raw.png — если правка
окажется хуже, вернуть можно без перегенерации.
"""
import io
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import fft

import paths  # noqa: E402  (engine/paths.py)
ROOT = str(paths.ROOT)
TAKES = str(paths.TAKES)
PLANS = os.path.join(ROOT, "engine")

W, H = 1280, 720          # рабочий кадр серии
SW, SH = 640, 360         # на чём ищем: вдвое меньше, быстрее и устойчивее
# Ниже этих порогов правка не стоит пересохранения файла.
MIN_SCALE_DELTA = 0.003   # 0,3 % — примерно 4 пикселя по ширине
MIN_SHIFT_PX = 3


def load_gray(path, size):
    im = Image.open(path).convert("L").resize(size, Image.LANCZOS)
    a = np.asarray(im, dtype=np.float64)
    return (a - a.mean()) / (a.std() + 1e-6)


def hann(h, w):
    return np.outer(np.hanning(h), np.hanning(w))


def patch_shift(m, k, y0, x0, ph, pw):
    """Сдвиг участка ключа относительно того же участка мастера."""
    a = m[y0:y0 + ph, x0:x0 + pw]
    b = k[y0:y0 + ph, x0:x0 + pw]
    a = (a - a.mean()) / (a.std() + 1e-6)
    b = (b - b.mean()) / (b.std() + 1e-6)
    win = hann(ph, pw)
    A = fft.fft2(a * win)
    B = fft.fft2(b * win)
    R = A * np.conj(B)
    R /= np.abs(R) + 1e-9
    r = np.real(fft.ifft2(R))
    idx = np.unravel_index(np.argmax(r), r.shape)
    dy, dx = idx
    if dy > ph // 2:
        dy -= ph
    if dx > pw // 2:
        dx -= pw
    return dx, dy, r[idx]


def estimate(master_path, key_path):
    """Оценка (масштаб, сдвиг) по сдвигам четырёх участков кадра.

    Прямой перебор масштаба здесь не годится: любое пересэмплирование чуть
    размывает картинку, корреляция от этого падает, и «масштаб 1.0» выигрывает
    всегда — метод смещён. Поэтому масштаб берём косвенно. При наезде участки
    по краям кадра разъезжаются в РАЗНЫЕ стороны, и по разнице их сдвигов
    масштаб считается без единого пересэмплирования:

        сдвиг участка ≈ (центр участка − центр кадра) · (s − 1) + общий сдвиг

    Четыре участка дают переопределённую систему, решаем её методом
    наименьших квадратов.
    """
    m = load_gray(master_path, (SW, SH))
    k = load_gray(key_path, (SW, SH))
    ph, pw = SH // 2, SW // 2
    cx, cy = SW / 2.0, SH / 2.0
    rows, rhs = [], []
    weak = 0
    for y0, x0 in ((0, 0), (0, SW - pw), (SH - ph, 0), (SH - ph, SW - pw)):
        dx, dy, peak = patch_shift(m, k, y0, x0, ph, pw)
        if peak < 0.02:
            weak += 1
            continue
        px, py = x0 + pw / 2.0 - cx, y0 + ph / 2.0 - cy
        # dx = px*(s-1) + tx ;  dy = py*(s-1) + ty
        rows.append([px, 1.0, 0.0]); rhs.append(dx)
        rows.append([py, 0.0, 1.0]); rhs.append(dy)
    if len(rows) < 4:
        return 1.0, 0.0, 0.0, 0.0
    sol, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    s = 1.0 + sol[0]
    tx, ty = sol[1], sol[2]
    return s, tx * (W / SW), ty * (H / SH), 1.0 - weak / 4.0


def apply_fix(key_path, scale, dx, dy, out_path):
    im = Image.open(key_path).convert("RGB").resize((W, H), Image.LANCZOS)
    nw, nh = max(2, int(round(W * scale))), max(2, int(round(H * scale)))
    im2 = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H))
    # центрируем и добавляем найденный сдвиг
    x0 = (W - nw) // 2 + int(round(dx))
    y0 = (H - nh) // 2 + int(round(dy))
    canvas.paste(im2, (x0, y0))
    a = np.asarray(canvas).copy()
    # края, оставшиеся пустыми после ужатия, заполняем крайними пикселями:
    # это несколько пикселей по периметру, в кадре они не читаются
    if x0 > 0:
        a[:, :x0] = a[:, x0:x0 + 1]
    if y0 > 0:
        a[:y0, :] = a[y0:y0 + 1, :]
    if x0 + nw < W:
        a[:, x0 + nw:] = a[:, x0 + nw - 1:x0 + nw]
    if y0 + nh < H:
        a[y0 + nh:, :] = a[y0 + nh - 1:y0 + nh, :]
    Image.fromarray(a).save(out_path)


def main():
    dry = "--dry" in sys.argv
    vid = sys.argv[sys.argv.index("--id") + 1]
    spec = json.load(io.open(os.path.join(PLANS, "flf_plans_%s.json" % vid), encoding="utf-8"))
    takes = os.path.join(TAKES, vid)

    print("%-6s %-26s %8s %8s %8s   %s" % ("план", "мастер", "масштаб", "dx", "dy", "вердикт"))
    for p in spec["plans"]:
        key = os.path.join(takes, "keys", "plan%d_key.png" % p["plan"])
        master = os.path.join(takes, p["master"])
        if not (os.path.exists(key) and os.path.exists(master)):
            print("%-6d %-26s   нет файла" % (p["plan"], p["master"]))
            continue
        s, dx, dy, peak = estimate(master, key)
        need = abs(s - 1.0) > MIN_SCALE_DELTA or abs(dx) > MIN_SHIFT_PX or abs(dy) > MIN_SHIFT_PX
        verdict = "правим" if need else "в рамке"
        print("%-6d %-26s %8.4f %8.1f %8.1f   %s" % (p["plan"], p["master"], s, dx, dy, verdict))
        if need and not dry:
            raw = key.replace("_key.png", "_key.raw.png")
            # Оригинал протухает: если ключ пересдали, он новее сохранённого
            # оригинала — и правка от старого оригинала молча вернёт старую
            # картинку. Так 31.08 свежий ключ 5 «Ежедневников» откатился к
            # вчерашнему, с рукописью на обложках. Новее ключ — он и есть
            # новый оригинал.
            if os.path.exists(raw) and os.path.getmtime(key) > os.path.getmtime(raw):
                os.remove(raw)
            if not os.path.exists(raw):
                os.rename(key, raw)
            else:
                os.remove(key)
            apply_fix(raw, s, dx, dy, key)
            # Оценка сдвига честна не всегда: на крупных планах со скудным
            # фоном (три ежедневника на пустом столе) она цепляется за
            # движущуюся руку и «правит» кадр в другую сторону. Проверяем
            # результат тем же измерителем и откатываемся, если стало хуже.
            s2, dx2, dy2, _ = estimate(master, key)
            worse = (abs(s2 - 1.0) > abs(s - 1.0)
                     or abs(dx2) + abs(dy2) > abs(dx) + abs(dy))
            if worse:
                os.remove(key)
                os.rename(raw, key)
                print("%-6s %-26s   правка ухудшила рамку (%.4f -> %.4f) — откат"
                      % ("", "", s, s2))


if __name__ == "__main__":
    main()
