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

## Project Structure

```text
.
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── lib/
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
