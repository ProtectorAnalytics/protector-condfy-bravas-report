#!/bin/bash
# Cron sidecar para o pipeline diário Condfy + Bravas.
# Mantém o processo principal vivo e dispara `daily.mjs` no horário
# configurado em CRON_SCHEDULE (default 7h BRT = "0 7 * * *").
set -e

CRON_SCHEDULE="${CRON_SCHEDULE:-0 7 * * *}"
TZ="${TZ:-America/Sao_Paulo}"

cd /app

echo "[cron] iniciando — schedule=\"$CRON_SCHEDULE\" TZ=$TZ"
echo "[cron] data atual: $(date)"

# Exporta env vars pro cron job (busybox crond não herda env do PID 1).
# Cada linha vira `export VAR='value'` com aspas single escapadas — assim
# valores com aspas duplas (ex: BRAVAS_CONTROLLERS JSON) não quebram o sourcing.
env | grep -E '^(CONDFY_|BRAVAS_|RESEND_|REPORT_|TZ=)' | while IFS='=' read -r k v; do
  v_escaped=$(printf '%s' "$v" | sed "s/'/'\\\\''/g")
  printf "export %s='%s'\n" "$k" "$v_escaped"
done > /tmp/cron.env
chmod 600 /tmp/cron.env

# Monta o crontab apontando pro daily.mjs
mkdir -p /var/spool/cron/crontabs
cat > /var/spool/cron/crontabs/root <<EOF
$CRON_SCHEDULE cd /app && . /tmp/cron.env && /usr/local/bin/node /app/daily.mjs >> /proc/1/fd/1 2>> /proc/1/fd/2
EOF

# Roda crond em foreground (logs vão pro stdout do container)
exec crond -f -L /dev/stdout -d 8
