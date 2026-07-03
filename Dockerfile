FROM node:22-slim

WORKDIR /app

# Зависимости.
COPY package.json package-lock.json ./
RUN npm ci

# Исходники + CA-сертификат (Russian Trusted Root CA для TLS T-Invest/GigaChat).
COPY . .

# Компиляция TS → dist/ (в контейнере запускаем скомпилированный JS, без tsx).
RUN npm run build

# Node не знает Russian Trusted Root CA — подкладываем цепочку.
ENV NODE_EXTRA_CA_CERTS=/app/certs/russian-trusted-ca.pem

# Команда переопределяется в docker-compose (watchlist + accountId).
CMD ["node", "dist/cli.js", "help"]
