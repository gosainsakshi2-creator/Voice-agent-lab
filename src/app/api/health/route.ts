import { NextResponse } from "next/server";

/** For the host's health check: open even when the dashboard login is on (see `src/proxy.ts`). Says nothing about the app. */
export function GET(): NextResponse {
  return NextResponse.json({ ok: true });
}
