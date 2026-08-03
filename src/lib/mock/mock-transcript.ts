/**
 * mock-transcript.ts
 *
 * Mock transcript entries using the existing `ConversationTurn`
 * type (types/provider.types.ts) directly, rather than inventing a
 * dashboard-specific shape. `role: "system"` doubles as the
 * session/state log line, matching how a VoiceSessionManager
 * would interleave state events with conversational turns.
 */

import type { ConversationTurn } from "@/types/provider.types";

const baseTime = Date.now() - 1000 * 42;

function at(offsetMs: number): Date {
  return new Date(baseTime + offsetMs);
}

export const MOCK_TRANSCRIPT: readonly ConversationTurn[] = [
  { role: "system", content: "Session sess_9f21c4e0 warmed up. All providers healthy.", timestamp: at(0) },
  { role: "system", content: "Call connected via Plivo to +91 98765 43210.", timestamp: at(1200) },
  { role: "assistant", content: "Namaste! Main aapki AI banking assistant hoon. Aapki kis tarah madad kar sakti hoon?", timestamp: at(3400) },
  { role: "user", content: "Mujhe apne last month ka transaction statement chahiye tha.", timestamp: at(8100) },
  { role: "assistant", content: "Zaroor. Kya aap apna registered mobile number confirm kar sakte hain verification ke liye?", timestamp: at(12600) },
  { role: "user", content: "Haan, ending 4321.", timestamp: at(17800) },
  { role: "assistant", content: "Thank you. Main aapka statement generate kar rahi hoon, ek moment.", timestamp: at(21300) },
  { role: "system", content: "Language model returned function-call intent: fetch_statement(account_suffix=4321)", timestamp: at(21900) },
  { role: "user", content: "Okay, no rush.", timestamp: at(24500) },
  { role: "assistant", content: "Aapka July statement WhatsApp aur email dono pe bhej diya gaya hai. Kuch aur chahiye?", timestamp: at(29700) },
  { role: "user", content: "Nahi, that's all. Thank you!", timestamp: at(34200) },
  { role: "assistant", content: "Aapka din shubh ho. Dhanyavaad, Voice Agent Lab ki taraf se!", timestamp: at(37600) },
];
