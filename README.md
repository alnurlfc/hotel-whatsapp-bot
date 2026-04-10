# WhatsApp Bot (Hotel Assistant)

WhatsApp-бот для гостей отеля: отвечает по базе знаний и использует ИИ для аккуратного ответа.

## Что уже есть в проекте

- webhook для WhatsApp Cloud API (Meta)
- база знаний отеля в `data/knowledge-base.json`
- поиск релевантного ответа в FAQ
- ИИ-ответ через OpenAI на основе базы знаний
- fallback, если ИИ временно недоступен
- команда/запрос на администратора (эскалация)
- уведомление администратору в WhatsApp
- лог всех диалогов в Google Sheets (опционально)

## Запуск с нуля (пошагово)

### 1) Что нужно заранее

- аккаунт Meta (Facebook)
- номер телефона для WhatsApp Business (для теста можно использовать sandbox в Meta)
- аккаунт OpenAI и API ключ
- установленный Node.js 18+ (`node -v`)
- установленный `ngrok` (для локального теста webhook)

### 2) Подготовить проект

```bash
cd /Users/ivankraus/Desktop/whatsapp-bot
npm install
cp .env.example .env
```

Открой `.env` и заполни:

- `PORT=3000`
- `WHATSAPP_VERIFY_TOKEN` — придумай свой секрет (например `hotel_verify_2026`)
- `WHATSAPP_ACCESS_TOKEN` — токен из Meta WhatsApp API Setup
- `WHATSAPP_PHONE_NUMBER_ID` — ID номера в Meta
- `OPENAI_API_KEY` — твой ключ OpenAI
- `OPENAI_MODEL=gpt-4o-mini`
- `HOTEL_NAME` — имя отеля
- `ADMIN_PHONE_E164` — номер администратора в формате `7999...` (без `+`)
- `ENABLE_GOOGLE_SHEETS_LOGGING` — `true` или `false`
- `GOOGLE_SHEETS_ID` — ID таблицы Google Sheets
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — email сервисного аккаунта Google
- `GOOGLE_PRIVATE_KEY` — private key сервисного аккаунта (в одну строку, `\n` вместо переносов)
- `GOOGLE_SHEET_NAME=Logs` — название листа в таблице

### 3) Настроить Meta WhatsApp Cloud API

1. Зайди в [Meta for Developers](https://developers.facebook.com/).
2. Создай App -> тип `Business`.
3. Добавь продукт `WhatsApp`.
4. В разделе `API Setup` получи:
   - `Temporary access token` (для старта)
   - `Phone number ID`
5. Добавь тестового получателя (свой номер) в `Recipient phone number`.

Скопируй токен и phone number id в `.env`.

### 4) Запустить бота локально

```bash
npm run dev
```

Если порт занят, поставь другой в `.env`, например `PORT=3001`, и перезапусти.

### 5) Открыть webhook наружу через ngrok

Если `PORT=3000`:

```bash
ngrok http 3000
```

Скопируй HTTPS URL вида:
`https://abc-123-45-67-89.ngrok-free.app`

### 6) Привязать webhook в Meta

В Meta -> WhatsApp -> Configuration:

- `Callback URL`: `https://<твой-ngrok-url>/webhook`
- `Verify token`: значение `WHATSAPP_VERIFY_TOKEN` из `.env`

Подпиши webhook на событие `messages`.

### 7) Проверка

- Напиши на подключенный WhatsApp-номер вопрос, например:
  - "Во сколько завтрак?"
  - "Есть ли парковка?"
- Бот должен ответить по данным из `data/knowledge-base.json`.

## Как редактировать ответы отеля

Файл: `data/knowledge-base.json`

Каждая запись:

- `question` — типовой вопрос
- `answer` — правильный ответ отеля
- `keywords` — ключевые слова для поиска совпадений

Чем лучше заполнена база, тем точнее ответы.

## Эскалация администратору

Если гость пишет что-то вроде:

- "позовите администратора"
- "оператор"
- "человек"
- "жалоба" / "срочно" / "проблема"

бот:

1. сообщает гостю, что передает запрос сотруднику;
2. отправляет уведомление на `ADMIN_PHONE_E164`.

## Логирование в Google Sheets

### 1) Создать таблицу

Создай Google Sheet, например `Hotel Bot Logs`, и лист `Logs`.

Колонки можно оставить пустыми — бот сам добавляет строки:

- timestamp
- hotel
- guest_phone
- lang
- event_type
- question
- answer
- escalated

### 2) Создать сервисный аккаунт Google

1. Открой [Google Cloud Console](https://console.cloud.google.com/).
2. Создай проект (или используй существующий).
3. Включи Google Sheets API.
4. Создай Service Account.
5. Создай JSON key для этого аккаунта.
6. Из JSON возьми:
   - `client_email` -> в `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` -> в `GOOGLE_PRIVATE_KEY` (переносы заменить на `\n`)

### 3) Дать доступ сервисному аккаунту

Открой таблицу Google Sheets -> Share -> добавь `client_email` как Editor.

### 4) Включить логирование

В `.env`:

- `ENABLE_GOOGLE_SHEETS_LOGGING=true`
- `GOOGLE_SHEETS_ID=<id из URL таблицы>`

Перезапусти бота.

## Продакшен на Render (24/7, без ngrok)

В проекте уже есть `render.yaml`.

### 1) Залить проект в GitHub

```bash
cd /Users/ivankraus/Desktop/whatsapp-bot
git init
git add .
git commit -m "Initial hotel WhatsApp bot"
```

Создай репозиторий на GitHub и запушь код.

### 2) Создать сервис в Render

1. Зайди на [Render](https://render.com/).
2. New -> Blueprint.
3. Выбери свой репозиторий.
4. Render подхватит `render.yaml`.
5. В Environment Variables заполни секреты:
   - `WHATSAPP_VERIFY_TOKEN`
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `OPENAI_API_KEY`
   - `ADMIN_PHONE_E164`
   - (опционально) Google Sheets переменные

### 3) Подключить URL Render в Meta

После деплоя получишь URL вида:
`https://hotel-whatsapp-bot.onrender.com`

В Meta -> WhatsApp -> Configuration:

- `Callback URL`: `https://hotel-whatsapp-bot.onrender.com/webhook`
- `Verify token`: из `WHATSAPP_VERIFY_TOKEN`

Подпиши webhook на `messages`.

## Важно для продакшена

- temporary token из Meta скоро истечет; потом нужен постоянный токен
- для реального номера нужно пройти верификацию бизнеса в Meta
- лучше сразу делать деплой на Render/Railway/VPS вместо локального ngrok

## Что написать гостям для теста

- "Во сколько заезд?"
- "Есть ли парковка?"
- "Позовите администратора"
- "Срочно, в номере шумно"
