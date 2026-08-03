import { NextResponse } from "next/server";

import { getRuntime } from "../../../server/runtime";
import { ProviderCategory } from "../../../types/enums";

export const dynamic = "force-dynamic";

export async function GET() {
  const { registry } = getRuntime();

  const byCategory = {
    telephony: registry.listByCategory(ProviderCategory.TELEPHONY),
    speechToText: registry.listByCategory(ProviderCategory.SPEECH_TO_TEXT),
    languageModel: registry.listByCategory(ProviderCategory.LANGUAGE_MODEL),
    textToSpeech: registry.listByCategory(ProviderCategory.TEXT_TO_SPEECH),
  };

  const HEALTH_CHECK_TIMEOUT_MS = 6000;
  let health: Awaited<ReturnType<typeof registry.checkAllHealth>> = [];
  try {
    health = await Promise.race([
      registry.checkAllHealth(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Health check timed out")), HEALTH_CHECK_TIMEOUT_MS),
      ),
    ]);
  } catch {
    // A slow or unreachable provider must never prevent the (fast, local)
    // provider catalog below from being returned to the Dashboard.
    health = [];
  }

  return NextResponse.json({ providers: byCategory, health });
}