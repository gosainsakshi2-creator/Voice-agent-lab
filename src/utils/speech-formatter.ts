export function formatForSpeech(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\. /g, "...\n")
    .replace(/\? /g, "?\n")
    .replace(/! /g, "!\n")

    // More natural phone conversation
    .replace(/\bHow may I assist you today\b/gi, "How can I help you today")
    .replace(/\bThank you very much\b/gi, "Thanks")
    .replace(/\bCertainly\b/gi, "Sure")
    .replace(/\bI understand your concern\b/gi, "I understand")

    .trim();
}