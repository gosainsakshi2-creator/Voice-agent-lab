import { pronounceForSpeech } from "../src/utils/speech-pronunciation";
import { SupportedLanguage as L } from "../src/types/enums";
const CASES: ReadonlyArray<readonly [string, string]> = [
  ["1 HI  full name", "यह session Saurabh Bhatnagar लेंगे।"],
  ["1 HINGLISH", "Saurabh Bhatnagar जी host कर रहे हैं।"],
  ["2 EN  full name", "The event is hosted by Saurabh Bhatnagar, co-founder and CEO."],
  ["7 HI  Saurabh alone", "यह session Saurabh लेंगे।"],
  ["8 HI  Bhatnagar alone", "यह session Bhatnagar जी लेंगे।"],
  ["9 HI  Karthik Ramani", "यह session Karthik Ramani लेंगे।"],
  ["6 HI  other names", "यह Priya Sharma का account है, Ishita बोल रही हूँ।"],
  ["6 HI  brand", "यह FlexiFunnels का event है।"],
];
for (const [label, text] of CASES) {
  const lang = label.includes("HINGLISH") ? L.HINGLISH : label.includes(" EN ") ? L.ENGLISH : L.HINDI;
  const out = pronounceForSpeech(text, lang);
  console.log(`${label.padEnd(24)} [${lang}]`);
  console.log(`   canonical -> ${text}`);
  console.log(`   to TTS    -> ${out}`);
  console.log(`   changed   -> ${out !== text ? "YES" : "no (unchanged)"}\n`);
}
