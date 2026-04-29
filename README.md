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

## Seeded Demo Data

Running `npm run seed` creates or updates:

- Patient: Sarah Chen, DOB 1985-03-15, phone `(555) 867-5309`
- Prescriptions:
  - Lisinopril 10mg, once daily, $5 copay
  - Metformin 500mg, twice daily, $10 copay
  - Atorvastatin 20mg, once daily, $15 copay
- Pharmacy: CVS Pharmacy, 1234 Main St
- Insurance policy: Aetna PPO, Member ID `ANT-88912`
- Refill request: draft state with `nextExpectedStep` set to `verify_identity`

## Persistence Layer

The server-side persistence helpers live in `lib/refill-persistence.ts`. They load the demo patient context, create and update conversation sessions, append transcript messages, switch call sessions to SMS, end call sessions, create refill requests after workflow completion, and fetch a full session snapshot for future UI/debug panels.

## Workflow API

The local demo exposes JSON-only route handlers for simulated call and SMS flows. These endpoints do not connect to real speech, telephony, or SMS providers.

- `POST /api/workflow/call/start`
  - Body: none
  - Response: `{ session, messages, refillRequest? }`
- `POST /api/workflow/call/input`
  - Body: `{ "sessionId": number, "text": string }`
  - Response: `{ session, agentReply, isComplete, refillRequest? }`
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
