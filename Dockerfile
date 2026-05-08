FROM node:20-alpine

# Cron daemon do Alpine + bash + tini (init pra capturar SIGTERM)
RUN apk add --no-cache bash tini tzdata \
    && cp /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime \
    && echo "America/Sao_Paulo" > /etc/timezone

WORKDIR /app

# Dependências primeiro (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Código
COPY extract.mjs send.mjs daily.mjs ./
COPY deploy/cron-runner.sh /usr/local/bin/cron-runner.sh
RUN chmod +x /usr/local/bin/cron-runner.sh

# Pasta pra XLSX gerados (volume opcional)
RUN mkdir -p /app/relatorios

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/cron-runner.sh"]
