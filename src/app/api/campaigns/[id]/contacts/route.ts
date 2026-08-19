import { NextResponse } from "next/server";

import { countContacts, listContacts } from "@/campaign/db/repositories/contact.repo";

export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 200;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, MAX_PAGE_SIZE);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);

  try {
    const [contacts, total] = await Promise.all([listContacts(id, limit, offset), countContacts(id)]);
    return NextResponse.json({ contacts, total, limit, offset });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
