/**
 * proxy.ts — the dashboard and every API route behind one login.
 *
 * Every /api route was open: /api/sessions dialled any number, the
 * campaign routes started and stopped campaigns, and the analytics
 * export handed out callers' transcripts. With `APP_BASIC_AUTH_PASSWORD`
 * set, every request needs HTTP Basic credentials (user
 * `APP_BASIC_AUTH_USER`, default "admin"); the browser asks once and
 * sends them with every same-origin request after, fetch and EventSource
 * included. Unset, nothing changes.
 *
 * Not covered here: the carrier's answer webhooks (`/api/voice/...`,
 * guarded by `TELEPHONY_WEBHOOK_SECRET` — see `webhook-auth.ts`), the
 * media WebSockets (upgraded in `server.ts`, which Proxy never sees), and
 * `/api/health`, for the host's health check.
 */

import { NextResponse, type NextRequest } from "next/server";

import { constantTimeEqual } from "./server/webhook-auth";

const OPEN_PREFIXES = ["/api/voice/", "/api/health"];

export function proxy(request: NextRequest): NextResponse {
  const password = process.env.APP_BASIC_AUTH_PASSWORD?.trim();
  if (password === undefined || password.length === 0) return NextResponse.next();
  if (OPEN_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) return NextResponse.next();

  const user = process.env.APP_BASIC_AUTH_USER?.trim() || "admin";
  if (credentialsMatch(request.headers.get("authorization"), user, password)) return NextResponse.next();

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Voice Agent", charset="UTF-8"' },
  });
}

export function credentialsMatch(header: string | null, user: string, password: string): boolean {
  if (header === null || !header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6).trim()), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  // Both compared, always, so the time taken does not say which was wrong.
  const userOk = constantTimeEqual(decoded.slice(0, colon), user);
  const passwordOk = constantTimeEqual(decoded.slice(colon + 1), password);
  return userOk && passwordOk;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
