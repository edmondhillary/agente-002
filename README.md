# Agente-002 — WhatsApp + Google Calendar

Agente de IA que gestiona tu agenda personal por WhatsApp. Puedes crear, consultar y cancelar eventos en Google Calendar usando mensajes de texto, notas de voz o imágenes.

## Qué hace

- **Texto** → gestiona tu calendario en lenguaje natural
- **Audio** → transcribe tu nota de voz con Whisper y ejecuta la acción
- **Imagen** → Claude Vision analiza la imagen y responde
- **Conflictos** → avisa si hay eventos solapados antes de crear
- **Confirmación** → pide "sí/no" antes de cancelar cualquier evento

---

## Requisitos previos

- Node.js 18+
- Cuenta en [Anthropic](https://console.anthropic.com) (Claude)
- Cuenta en [Twilio](https://console.twilio.com) (WhatsApp)
- Cuenta en [Google Cloud](https://console.cloud.google.com)
- Cuenta en [OpenAI](https://platform.openai.com) (Whisper)
- Cuenta en [MongoDB Atlas](https://cloud.mongodb.com)
- [ngrok](https://ngrok.com) para desarrollo local

---

## Instalación

```bash
git clone https://github.com/edmondhillary/agente-002
cd agente-002
npm install --legacy-peer-deps
```

---

## Configuración paso a paso

### 1. Anthropic API Key
1. Entra en [console.anthropic.com](https://console.anthropic.com)
2. Settings → API Keys → Create Key

### 2. Twilio — WhatsApp Sandbox
1. Entra en [console.twilio.com](https://console.twilio.com)
2. Messaging → Try it out → Send a WhatsApp message
3. Desde tu WhatsApp, envía el mensaje `join <palabra>-<palabra>` al número que te indica
4. Guarda el **Account SID** y **Auth Token** del dashboard principal
5. Guarda el número que te asignen en el sandbox (lo necesitarás para el `.env`)

> ⚠️ **Límite del sandbox**: 50 mensajes por día. Para producción necesitas un número dedicado (~$1/mes).

### 3. Google Cloud — Service Account

> ⚠️ **Problema frecuente**: Si tu cuenta de Google es institucional o de empresa, puede tener una política que bloquea la creación de claves JSON (`iam.disableServiceAccountKeyCreation`). En ese caso usa una cuenta de Gmail personal.

1. Entra en [console.cloud.google.com](https://console.cloud.google.com) con tu **Gmail personal**
2. Crea un proyecto nuevo: `agente-002`
3. Habilita la **Google Calendar API**: APIs & Services → Library → buscar "Google Calendar API" → Enable
4. Crea una Service Account: IAM & Admin → Service Accounts → Create
   - Nombre: `agente-reservas`
   - Rol: `Editor`
5. Descarga la clave JSON: clic en la service account → Keys → Add Key → Create new key → JSON
6. Guarda el archivo como `google-credentials.json` dentro de la carpeta del proyecto

> ⚠️ **Nunca subas `google-credentials.json` a GitHub**. Ya está en el `.gitignore`.

### 4. Compartir el calendario con la Service Account
1. Abre [Google Calendar](https://calendar.google.com)
2. Clic en los tres puntos de tu calendario → Settings and sharing
3. Share with specific people → Add people
4. Pega el email de la service account (lo encuentras en el JSON, campo `client_email`)
   - Formato: `agente-reservas@agente-002-XXXXX.iam.gserviceaccount.com`
5. Permiso: **Make changes to events**
6. El **Calendar ID** lo encuentras en: Settings → Integrate calendar → Calendar ID
   - Para el calendario principal es tu Gmail

### 5. OpenAI — Whisper
1. Entra en [platform.openai.com](https://platform.openai.com)
2. API Keys → Create new secret key → **You** (no Service account)

### 6. MongoDB Atlas
1. Entra en [cloud.mongodb.com](https://cloud.mongodb.com)
2. Crea un cluster gratuito (M0)
3. Connect → Drivers → copia la URI
4. Reemplaza `<password>` con tu contraseña real

### 7. ngrok
```bash
# Instalar
brew install ngrok

# Autenticarse (una sola vez)
ngrok config add-authtoken TU_TOKEN
# El token está en: dashboard.ngrok.com → Your Authtoken
```

---

## Variables de entorno

Crea un archivo `.env` en la raíz del proyecto:

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX

# Google Calendar
GOOGLE_CALENDAR_ID=tu-email@gmail.com
GOOGLE_CREDENTIALS_PATH=./google-credentials.json

# OpenAI
OPENAI_API_KEY=sk-...

# MongoDB
MONGODB_URI=mongodb+srv://usuario:password@cluster.mongodb.net/
MONGODB_DB=agente002

# Servidor
PORT=3000
```

> ⚠️ `TWILIO_WHATSAPP_FROM` debe incluir el prefijo `whatsapp:` — sin eso Twilio rechaza los mensajes con el error "Invalid From and To pair".

---

## Ejecutar el agente

### Terminal 1 — el servidor
```bash
npm run dev
```

### Terminal 2 — el túnel
```bash
npx ngrok http 3000
```
Copia la URL que te da ngrok (ej: `https://abc123.ngrok-free.app`)

### Configurar Twilio
1. console.twilio.com → Messaging → Try it out → Send a WhatsApp message → Sandbox Settings
2. En **"When a message comes in"** pega: `https://abc123.ngrok-free.app/webhook`
3. Método: **POST**
4. Guarda

---

## Uso

Escribe al número del sandbox de Twilio desde tu WhatsApp:

```
"¿Qué tengo el martes?"
"Crea una reunión con Juan mañana a las 3 hasta las 4"
"Muéstrame mis próximas reuniones"
"Cancela el evento con ID abc123"
/olvida   → borra el historial de conversación
```

También puedes enviar **notas de voz** o **imágenes**.

---

## Tests

```bash
npm test                # ejecutar todos los tests
npm run test:coverage   # con reporte de cobertura
```

---

## Problemas frecuentes

| Error | Causa | Solución |
|-------|-------|----------|
| `Invalid From and To pair` | `TWILIO_WHATSAPP_FROM` sin prefijo `whatsapp:` | Añadir `whatsapp:` al principio |
| `Not Found` en Google Calendar | Service account sin acceso al calendario | Compartir el calendario con el email de la service account |
| `Google Calendar API has not been used` | API no habilitada en el proyecto | Habilitarla en Google Cloud Console |
| `iam.disableServiceAccountKeyCreation` | Cuenta institucional con política restrictiva | Usar Gmail personal para crear el proyecto |
| `exceeded the 50 daily messages limit` | Límite del sandbox de Twilio | Esperar al día siguiente o contratar número dedicado |
| Whisper transcribe en otro idioma | Sin configurar idioma | Ya incluido: `language: "es"` |
| El agente crea eventos sin verificar conflictos | Bug corregido | La versión actual verifica solapamientos |

---

## Arquitectura

```
index.ts                 → orquestación: webhook, audio, imagen, agente loop
calendar.service.ts      → lógica pura de Google Calendar (testeable)
calendar.service.test.ts → 35 tests unitarios (97% de cobertura)
```

```
WhatsApp → Twilio → POST /webhook → Express
                                       |
                            audio? → Whisper → texto
                           imagen? → Claude Vision → respuesta
                                       |
                            Claude Sonnet (tool use)
                                       |
                          Google Calendar API
                                       |
                            Twilio → WhatsApp
```

---

## Stack

- **Runtime**: Node.js + TypeScript
- **IA**: Claude Sonnet 4.6 (Anthropic) + Whisper (OpenAI)
- **Mensajería**: Twilio WhatsApp
- **Calendario**: Google Calendar API
- **Base de datos**: MongoDB Atlas
- **Tests**: Jest + ts-jest
- **Túnel dev**: ngrok
