# INCIDENTS

Журнал нетривиальных инцидентов и их разбора (новые сверху).

## Формат
```
## YYYY-MM-DD — Краткое название
**Симптом:** что наблюдалось
**Корень:** реальная причина
**Фикс:** что изменили
**Файлы:** path:line
```

<!-- Записи ниже -->

## 2026-07-03 — Контейнер крешил: не найден src/audit/log.js
**Симптом:** при первом деплое контейнер в crash-loop (`ERR_MODULE_NOT_FOUND`, затем при переходе на сборку — `TS2307: Cannot find module '../audit/log.js'`). Локально `npm run build` проходил.
**Корень:** `rsync --exclude='audit'` (и строка `audit` в `.dockerignore`) матчат имя на ЛЮБОМ уровне → вырезали не только рантайм-папку `audit/`, но и `src/audit/`. На VPS/в образе не было `src/audit/log.ts`.
**Фикс:** заякорить паттерны к корню: `--exclude='/audit'` / `--exclude='/data'` в rsync и CI; `/audit` `/data` в `.dockerignore`. Плюс перевели контейнер на сборку TS→dist + `node dist/cli.js` (Node 22) вместо `tsx` в рантайме.
**Файлы:** `.dockerignore`, `.github/workflows/deploy.yml`, `Dockerfile`, `docker-compose.yml`
