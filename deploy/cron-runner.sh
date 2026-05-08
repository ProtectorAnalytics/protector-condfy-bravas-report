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

# Exporta env vars pro cron job (busybox crond não herda env do PID 1)
env | grep -E '^(CONDFY_|BRAVAS_|RESEND_|REPORT_|TZ=)' > /tmp/cron.env

# Monta o crontab apontando pro daily.mjs
mkdir -p /var/spool/cron/crontabs
cat > /var/spool/cron/crontabs/root <<EOF
$CRON_SCHEDULE cd /app && set -a && . /tmp/cron.env && set +a && /usr/local/bin/node /app/daily.mjs >> /proc/1/fd/1 2>> /proc/1/fd/2
EOF

# Roda crond em foreground (logs vão pro stdout do container)
exec crond -f -L /dev/stdout -d 8
