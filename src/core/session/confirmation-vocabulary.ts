/**
 * confirmation-vocabulary.ts
 *
 * WHICH IDENTITY CONFIRMATIONS THE PREPARED FIRST REPLY MAY ANSWER.
 *
 * The prepared first reply (see `prepareFirstReply` in the pipeline) is
 * the script's introduction and purpose, generated while the identity
 * question plays. It is the right answer to a caller who has confirmed
 * who they are and said nothing else the reply would talk past — and
 * callers confirm in many ways. 487 real confirmations (30 days to
 * 2026-09-29) came in 143 distinct forms: "Yes." (213), "Yeah", "हाँ",
 * "हाँ जी", "जी", "यस", "Yes ma'am", "हाँ बोलिए", "Right, who's this?",
 * "हाँ कौन बोल रहा है?", "Yes, tell me", "Speaking, who is this?"…
 *
 * DEFAULT-DENY. A confirmation is served only when EVERY word in it is a
 * word of confirmation, address, filler, the contact's own name, or a
 * question the reply itself answers ("who is this?", "what is it
 * about?" — the reply says who is calling and why). Any other word —
 * "driving", "call me after", "hold on", "not interested", a voicemail
 * greeting, an assistant, anything unforeseen — sends the turn to its
 * own model request, exactly as before. A miss costs about a second; a
 * wrong pass pitches at someone who just said they are driving. Measured
 * on those 487: 92.6% served, and every one of the rest is a turn the
 * pitch should not answer.
 *
 * LANGUAGE IS READ FROM THE WORDS, NOT THE SCRIPT THEY ARE WRITTEN IN.
 * Soniox and Deepgram write English in Devanagari ("यस", "राइट", "ओके",
 * "मैडम"), so a Devanagari turn is not a Hindi one. Any HINDI word →
 * the Hindi reply; English words only → the English reply.
 */

/** English words — in Latin, and as the STT providers write them in Devanagari. */
const ENGLISH_WORDS: ReadonlySet<string> = new Set(
  (
    "yes yeah yep yup ya yea yess ok okay sure right correct speaking hello hi hey hii " +
    "ma'am maam madam mam sir please tell me go ahead on i am i'm im this is it's its you are you're youre " +
    "with listening said uh um umm hmm oh and so thank thanks " +
    "who who's whos calling may know what what's happened about regarding why say it here " +
    "यस येस ओके राइट सर मैम मैडम हेलो हलो हैलो हाय आई सेड प्लीज़ प्लीज टेल मी स्पीकिंग थैंक थैंक्स"
  ).split(/\s+/u),
);

/** Hindi words, in Devanagari and romanized. */
const HINDI_WORDS: ReadonlySet<string> = new Set(
  (
    "हाँ हां हा हाँजी हांजी जी बोलिए बोलिये बोलो बोलना बोल बताइए बताइये बताएँ बताएं बताओ बता ठीक है हैं नमस्ते " +
    "कौन रहा रही रहे हूँ हूं मैं बात कर वही वो तो हम्म आगे भाई ना क्या काम सही " +
    "haan han haa haanji hanji ji jee boliye bolo bolna bol bataiye batao bata theek thik hai namaste " +
    "kaun kya kaam main baat kar raha rahi hoon hu"
  ).split(/\s+/u),
);

/** Most words a confirmation the prepared reply answers may run to. */
const MAX_WORDS = 14;

/**
 * Words of a turn, lower-cased. Splits on anything that is not a letter,
 * a combining mark or an apostrophe — `\p{M}` is what keeps Devanagari
 * words whole ("हाँ" is a letter plus a mark).
 */
export function confirmationWords(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .split(/[^\p{L}\p{M}']+/u)
    .filter((word) => word.length > 0);
}

/**
 * The prepared reply this confirmation may be answered with — `"en"` or
 * `"hinglish"` — or undefined when it must get its own request.
 *
 * `nameForms` are the contact's name as the caller might say it back:
 * the name itself and its Devanagari spoken forms.
 */
export function preparedReplyVariantFor(text: string, nameForms: readonly string[]): "en" | "hinglish" | undefined {
  const words = confirmationWords(text);
  if (words.length === 0 || words.length > MAX_WORDS) return undefined;
  const nameWords = new Set(nameForms.flatMap((form) => confirmationWords(form)).filter((word) => word.length >= 2));
  let hindi = false;
  for (const word of words) {
    if (HINDI_WORDS.has(word)) hindi = true;
    else if (!ENGLISH_WORDS.has(word) && !nameWords.has(word)) return undefined;
  }
  return hindi ? "hinglish" : "en";
}
