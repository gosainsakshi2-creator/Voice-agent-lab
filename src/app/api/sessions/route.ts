import { NextResponse } from "next/server";

import { getRuntime } from "../../../server/runtime";
import type { SessionCreationRequest } from "../../../types/session.types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { manager } = getRuntime();
  const body = (await request.json()) as SessionCreationRequest;

  try {
    const snapshot = await manager.createSession(body);
    return NextResponse.json({ session: snapshot });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

export async function GET() {
  const { manager } = getRuntime();
  const sessions = await manager.listSessions();
  return NextResponse.json({ sessions });
}
