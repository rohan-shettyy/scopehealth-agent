import { NextResponse } from "next/server";

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

export function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer`);
  }

  return value;
}

export function jsonError(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Unexpected error";

  return NextResponse.json({ error: message }, { status });
}
