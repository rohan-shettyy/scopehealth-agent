# Prescription Refill Voice Agent

Local demo web app for a prescription refill voice agent with browser-simulated call mode and SMS fallback.

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

   The seed command creates several demo patients, each with their own active prescriptions, insurance policy, and copay rules, plus the CVS Pharmacy on file.

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
  Prescriptions:
  - Lisinopril 10mg, once daily, $5 copay
  - Metformin 500mg, twice daily, $10 copay
  - Atorvastatin 20mg, once daily, $15 copay
- Patient: Marcus Rivera, DOB 1978-11-02, phone `(555) 222-0102`
  Prescriptions:
  - Amlodipine 5mg, once daily, $8 copay
  - Rosuvastatin 10mg, once daily, $12 copay
- Patient: Priya Patel, DOB 1990-07-22, phone `(555) 333-0198`
  Prescriptions:
  - Levothyroxine 50mcg, every morning, $7 copay
  - Albuterol 90mcg, as needed, $20 copay
- Pharmacy: CVS Pharmacy, 1234 Main St
- Insurance policies: Aetna PPO for Sarah, BlueCross Choice for Marcus, Cigna Open Access for Priya
- New call sessions start unidentified with `nextExpectedStep` set to `identify_patient`

## Persistence Layer

`lib/refill-persistence.ts` contains the server-side persistence helpers. They load patient identity and workflow context, create and update conversation sessions, append transcript messages, switch call sessions to SMS, end call sessions, prevent duplicate refill requests for the same prescription, create refill requests after workflow completion, and fetch a full session snapshot for UI/debug panels.

## Workflow API

The local demo exposes route handlers for simulated call and SMS workflow.

Call-mode replies go through the server-owned voice provider boundary in `lib/voice`. When Gemini Live is enabled, the backend opens a Gemini Live WebSocket session enables transcription, model text, model audio, and tool-call events on call input responses as `voiceEvents`. Gemini drives the workflow proposal and response text. SMS responses use the configured Gemini text model, defaulting to `gemini-3.1-flash-lite-preview`.

For browser voice simulation, the call panel captures microphone audio and streams chunks to the backend as `audio/pcm;rate=16000`. Gemini Live audio output is expected as PCM audio and is played in the browser.

- `POST /api/workflow/call/start`
  - Body: none
  - Response: `{ session, messages, refillRequest?, voiceEvents? }`
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
- `POST /api/workflow/call/reset`
  - Body: `{ "sessionId": number }`
  - Response: `{ reset: true }`
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
