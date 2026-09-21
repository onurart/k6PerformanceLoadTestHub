#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

config_file="${CONFIG_FILE:-config.env}"
if [[ ! -f "$config_file" ]]; then
  echo "Yapılandırma dosyası bulunamadı: $config_file" >&2
  echo "Aktif ayar dosyası varsayılan olarak config.env olmalıdır." >&2
  exit 1
fi

# config.env yalnızca sizin yönettiğiniz güvenilir bir shell ortam dosyası olmalıdır.
set -a
# shellcheck disable=SC1090
source "$config_file"
set +a

mkdir -p log
stamp="$(date +'%Y%m%d_%H%M%S')"
region="${REGION_TAG:-local}"
index="${MACHINE_INDEX:-0}"
console_file="log/k6-${region}-${index}-${stamp}.log"
if [[ -n "${COORDINATOR_URL:-}" ]]; then
  mkdir -p results
  json_file="results/raw-${region}-${index}-${stamp}.json"
  exec python3 distributed/runner.py --coordinator "$COORDINATOR_URL" --json "$json_file" --console "$console_file"
fi
echo "k6 testi başlıyor. Ekran ve log çıktısı: $console_file"
k6 run k6_test.js 2>&1 | tee "$console_file"
