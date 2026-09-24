import { createHash } from "node:crypto";
import { buildSystemPrompt } from "../src/core/session/system-prompt";
import { SupportedLanguage } from "../src/types/enums";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
for (const language of [SupportedLanguage.ENGLISH, SupportedLanguage.HINDI, SupportedLanguage.HINGLISH]) {
  for (const gender of ["male", "female"] as const) {
    const p = buildSystemPrompt(language, gender);
    console.log(`    "${language} ${gender}": "${sha(p)}",  // chars=${p.length} lines=${p.split("\n").length}`);
  }
}
