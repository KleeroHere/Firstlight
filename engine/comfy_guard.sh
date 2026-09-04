#!/bin/bash
# Сторож ComfyUI: раз в 3 минуты проверяет живость и поднимает при падении.
# Вывод и логи ComfyUI держим на диске контейнера — сетевой том упирается в квоту.
HOST="${COMFY_HOST:?set COMFY_HOST to https://<pod>-8188.proxy.runpod.net}"
CMD="cd /ComfyUI && nohup python3 main.py --listen --enable-cors-header '*' --use-sage-attention --extra-model-paths-config /ComfyUI/extra_model_paths.yaml > /tmp/comfy.log 2>&1 &"
while true; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$HOST/system_stats")
  if [ "$code" != "200" ]; then
    echo "$(date +%H:%M) сторож: ComfyUI не отвечает ($code), поднимаю" >> reports/night-24-08.md
    node engine/pod_exec.mjs "$CMD" 120 > /dev/null 2>&1
    sleep 60
  fi
  sleep 180
done
