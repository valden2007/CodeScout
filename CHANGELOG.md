# Changelog / История изменений

## v1.1.2 — хотфикс безопасности (security fixes)

### RU
- Инлайн-комментарии в PR привязаны к коммиту, изменившему файл (issue.commitId), а не всегда к head — меньше 422-ошибок при многокоммитных PR.
- Защита от prompt injection в buildReviewPrompt: контроль-символы и bidirectional-символы вырезаются из имени файла и патча, делимитеры блока заменены на нефальсифицируемые маркеры, патч помечен как недоверенные данные.
- Убран heuristic-понижение security→performance в парсере ответов — уязвимости больше не переквалифицируются молча.
- Защита от path traversal при клике по находке в панели (префикс workspace проверяется с разделителем пути).
- line-correction проверяет реальный путь через realpathSync — симлинки нарушу репозитория больше не обходят проверку.

### EN
Security hotfix: per-file commit_id for review comments, prompt-injection sanitization in buildReviewPrompt, removed silent security→performance downgrade, path-traversal guards in panel openFile and line-correction (realpath).

## v1.1.0 — VS Code extension

### RU
- Онбординг «вставь ключ и работай»: провайдер автоопределяется по префиксу ключа (gsk_, AIza, sk-or-, ghp_).
- Живой каталог моделей: GET {baseUrl}/models, умная модель по умолчанию, ручной выбор.
- Полный аудит проекта: прогресс, отмена (AbortController), пропуск больших/нечитаемых файлов, контекст в .codescout/context.json.
- Кастомные правила проекта: .codescout/rules.md.
- Клик по находке открывает файл на нужной строке.
- Прогресс с живым счётчиком секунд, стоп-кнопка, retry при rate-limit.
- Самотест на встроенном примере, отчёты в канале Output.
- Модальный welcome-баннер аудита: оверлей блокирует кнопки панели до выбора (Escape — закрыть, tab-trap).
- Команда сброса онбординга CodeScout: сброс онбординга.

### EN
VS Code extension: onboarding with provider auto-detection, live model catalog, full project audit with context (.codescout/context.json), custom rules (.codescout/rules.md), clickable findings, live progress with cancel, rate-limit retry, self-test sample, Output reports, modal welcome banner.

## v1.0.0 — GitHub Action + CLI

### RU
- GitHub Action: авто-ревью pull request'ов, находки комментарием в PR.
- CLI: `node dist/cli.js scan` — ревью локальных diff'ов в терминале.
- OpenAI-совместимые провайдеры: groq (BYOK), ключ из переменных окружения.

### EN
GitHub Action + CLI: AI code review for pull requests and local diffs, Groq BYOK support.
