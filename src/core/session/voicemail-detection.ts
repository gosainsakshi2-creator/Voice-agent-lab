/**
 * voicemail-detection.ts
 *
 * The phrases that say we reached a machine rather than a person, and
 * the matcher over them.
 *
 * ONE TABLE, TWO READERS, AND THAT IS THE POINT. The outcome
 * classifier has always read these phrases AFTER the call, to stop a
 * voicemail greeting supplying the tokens its affirmation rules read —
 * a machine must never become a registration. The pipeline now reads
 * the same phrases DURING the call, to stop the agent talking to the
 * machine in the first place. Two copies of this vocabulary would
 * drift, and a live gate that disagrees with the label the call is
 * later given is worse than no gate at all, so the table lives here
 * and both import it.
 *
 * It is a TRANSCRIPT HEURISTIC and nothing more. The platform has no
 * carrier answering-machine detection: the media stream opening looks
 * identical for a human, a machine and an IVR, and no carrier verdict
 * is received (`external-limits.ts` records this as unavailable).
 * Matching one of these phrases is evidence that we reached a machine,
 * never proof — and failing to match one is not evidence of a human.
 */

/**
 * Phrases only an answering machine, a voicemail service or a carrier
 * announcement says.
 *
 * Moved here verbatim from `campaign/outcome/classifier.ts`, in the
 * same order, matched the same way — the classifier's behaviour is
 * byte-for-byte what it was.
 */
export const VOICEMAIL_MARKERS = [
  "has been forwarded to voicemail", "forwarded to voicemail", "to voicemail",
  "leave a message after", "leave a message", "record your message",
  "after the tone", "after the beep", "at the tone", "not available right now",
  "is not answering your call", "is currently unavailable", "please try again later",
  "the person you are calling", "the number you are calling",
  "voice mail", "voicemail",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "abhi uplabdh nahi", "sandesh record", "sandesh chhod", "message chhod dijiye",
  "beep ke baad", "tone ke baad", "jis vyakti ko aap",
  "उपलब्ध नहीं", "संदेश रिकॉर्ड", "संदेश छोड़", "वॉइस मेल", "वॉइसमेल",
];

/**
 * Lowercase, punctuation to spaces, one space either end — so a phrase
 * is matched on word boundaries and "voice mail" also matches
 * "voice-mail".
 *
 * Deliberately a local copy of `outcome/conversation-events.ts`'s
 * `normaliseText`, and identical to it. `core` must not import from
 * `campaign` (the dependency runs the other way), and duplicating one
 * regex is a far smaller hazard than duplicating the phrase table
 * above — which is exactly why the table is not duplicated.
 */
function normaliseForPhraseMatch(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim()} `;
}

/**
 * The first voicemail marker present in `text`, or `undefined`.
 *
 * Returns the phrase rather than a boolean so the caller can say WHICH
 * phrase it acted on — a live gate that silences the agent has to be
 * explainable from the logs.
 */
export function voicemailPhraseIn(text: string): string | undefined {
  if (text.trim().length === 0) return undefined;
  const haystack = normaliseForPhraseMatch(text);
  for (const marker of VOICEMAIL_MARKERS) {
    if (haystack.includes(` ${normaliseForPhraseMatch(marker).trim()} `)) return marker;
  }
  return undefined;
}
