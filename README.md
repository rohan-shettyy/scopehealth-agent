# Prescription Refill Voice Agent

Local demo web app scaffold for a future prescription refill voice agent.

This repository currently contains the project foundation only. It does not include telephony, SMS, or refill workflow logic yet.

## Tech Stack

- Next.js
- TypeScript
- Prisma
- SQLite

## Prerequisites

- Node.js 20 or newer
- npm

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

3. Generate the Prisma client:

   ```bash
   npm run db:generate
   ```

4. Create or update the local SQLite database:

   ```bash
   npm run db:push
   ```

5. Seed the database:

   ```bash
   npm run seed
   ```

   The seed command creates the demo patient Sarah Chen, three active prescriptions, the CVS Pharmacy on file, an Aetna PPO insurance policy, copay rules for each medication, and a draft refill request for later workflow development.

6. Start the local development server:

   ```bash
   npm run dev
   ```

7. Open the app:

   [http://localhost:3000](http://localhost:3000)

## Available Scripts

- `npm run dev` - start the Next.js development server
- `npm run build` - build the production app
- `npm run start` - start the production server after a build
- `npm run db:generate` - generate the Prisma client
- `npm run db:push` - apply the Prisma schema to the local SQLite database
- `npm run seed` - seed the local database

## Environment

- `DATABASE_URL` - local SQLite database path
- `GEMINI_API_KEY` - server-only Google Gemini API key for simulated call mode
- `GEMINI_LIVE_MODEL` - Gemini Live model ID, defaults to `gemini-3.1-flash-live-preview`
- `GEMINI_TEXT_MODEL` - Gemini text model for SMS and structured fallback orchestration, defaults to `gemini-3.1-flash-lite-preview`
- `ENABLE_GEMINI_LIVE` - set to `true` to use the Gemini Live WebSocket provider

## Seeded Demo Data

Running `npm run seed` creates or updates:

- Patient: Sarah Chen, DOB 1985-03-15, phone `(555) 867-5309`
- Prescriptions:
  - Lisinopril 10mg, once daily, $5 copay
  - Metformin 500mg, twice daily, $10 copay
  - Atorvastatin 20mg, once daily, $15 copay
- Pharmacy: CVS Pharmacy, 1234 Main St
- Insurance policy: Aetna PPO, Member ID `ANT-88912`
- Refill request workflow starts with `nextExpectedStep` set to `verify_dob`

## Persistence Layer

The server-side persistence helpers live in `lib/refill-persistence.ts`. They load the demo patient context, create and update conversation sessions, append transcript messages, switch call sessions to SMS, end call sessions, create refill requests after workflow completion, and fetch a full session snapshot for future UI/debug panels.

## Workflow API

The local demo exposes JSON-only route handlers for simulated call and SMS flows. These endpoints do not connect to real speech, telephony, or SMS providers.

Call-mode replies go through the server-owned voice provider boundary in `lib/voice`. When Gemini Live is enabled, the backend opens a Gemini Live WebSocket session and can surface transcription, model text, model audio, and tool-call events on call input responses as `voiceEvents`. Gemini drives the workflow proposal and response text. SMS responses use the configured Gemini text model, defaulting to `gemini-3.1-flash-lite-preview`.

For browser voice simulation, the call panel captures microphone audio, converts it to raw little-endian PCM16 mono at 16kHz, and streams chunks to the backend as `audio/pcm;rate=16000`. Gemini Live audio output is expected as PCM audio and is played in the browser at the MIME type's declared sample rate, usually 24kHz.

- `POST /api/workflow/call/start`
  - Body: none
  - Response: `{ session, messages, refillRequest? }`
- `POST /api/workflow/call/input`
  - Body: `{ "sessionId": number, "text": string }`
  - Response: `{ session, agentReply, isComplete, refillRequest?, voiceEvents? }`
- `POST /api/workflow/call/audio`
  - Body: `{ "sessionId": number, "audioBase64": string, "mimeType": "audio/pcm;rate=16000" }`
  - Response: `{ voiceEvents }`
- `POST /api/workflow/call/audio/end`
  - Body: `{ "sessionId": number }`
  - Response: `{ session, agentReply, isComplete, refillRequest?, voiceEvents? }`
- `GET /api/workflow/call/events/:sessionId`
  - Response: `{ voiceEvents }`
- `POST /api/workflow/call/hangup`
  - Body: `{ "sessionId": number }`
  - Response: `{ session, messages, refillRequest? }`
- `POST /api/workflow/sms/fallback`
  - Body: `{ "sessionId": number }`
  - Response: `{ session, messages, refillRequest? }`
- `POST /api/workflow/sms/reply`
  - Body: `{ "sessionId": number, "text": string }`
  - Response: `{ session, agentReply, isComplete, refillRequest? }`
- `GET /api/workflow/sessions/:sessionId`
  - Response: `{ session, messages, refillRequest? }`

## Project Structure

```text
.
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── refill-persistence.ts
│   ├── refill-session-service.ts
│   ├── route-errors.ts
│   ├── voice/
│   │   ├── config.ts
│   │   ├── gemini-live-client.ts
│   │   ├── local-voice-provider.ts
│   │   ├── provider.ts
│   │   └── types.ts
│   └── prisma.ts
├── prisma/
│   ├── ensure-sqlite-db.ts
│   ├── schema.prisma
│   └── seed.ts
├── .env.example
├── .gitignore
├── next.config.ts
├── package.json
├── prisma.config.ts
└── tsconfig.json
```
