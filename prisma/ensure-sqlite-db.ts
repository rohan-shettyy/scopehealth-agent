import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

if (!databaseUrl.startsWith("file:") || databaseUrl === "file::memory:") {
  process.exit(0);
}

const rawFilePath = databaseUrl.slice("file:".length).split("?")[0];
const dbPath = resolve("prisma", rawFilePath);

async function main() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, "");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
