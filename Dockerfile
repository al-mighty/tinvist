FROM node:20-slim

WORKDIR /app

# Зависимости (включая tsx — запуск идёт через него, без сборки).
COPY package.json package-lock.json ./
RUN npm ci

# Исходники + CA-сертификат (Russian Trusted Root CA для TLS T-Invest/GigaChat).
COPY . .

# Node не знает Russian Trusted Root CA — подкладываем цепочку.
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian-trusted-ca.pem

# Команда переопределяется в docker-compose (watchlist + accountId).
CMD ["npx", "tsx", "src/cli.ts", "help"]
