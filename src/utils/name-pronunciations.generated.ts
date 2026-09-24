/**
 * name-pronunciations.generated.ts
 *
 * GENERATED DATA. Latin name -> the Devanagari spelling that makes a TTS
 * engine say it the way a person does.
 *
 * ── WHY THIS FILE IS DATA AND NOT AN ALGORITHM ────────────────────
 *
 * Romanized Indian names do not carry vowel length, and vowel length is
 * the part you hear. The same letter goes both ways in names that look
 * identical:
 *
 *   Rahul   -> राहुल   (long)
 *   Ramesh  -> रमेश    (short)
 *   Rakesh  -> राकेश   (long)
 *
 * No rule distinguishes those, so a transliteration algorithm gets a
 * large share of names audibly wrong — which is the same failure this
 * whole change exists to remove. So each name is resolved ONCE, ahead
 * of every call, and the answer is stored here.
 *
 * ── AND WHY THAT COSTS NO LATENCY ─────────────────────────────────
 *
 * Nothing here runs at call time except a `Map.get`. The resolution is
 * done by `npm run names:generate`, offline, against the contact list,
 * and its output is committed to this file. NO model, no network and no
 * database is touched while a call is in progress. A name that is not
 * in this map is spoken exactly as it is spelled today — a miss is
 * never an error and never delays anything.
 *
 * ── HOW TO ADD NAMES ──────────────────────────────────────────────
 *
 *   npm run names:generate               # every campaign's contacts
 *   npm run names:generate -- --campaign=<uuid>
 *
 * It only ever ADDS: a name already in this file is left exactly as it
 * is, so a spelling somebody corrected by hand is never overwritten by
 * a later run. Review the diff like any other code change — a wrong
 * row here is a wrong name said to a real person.
 *
 * Keys are lower-cased and whitespace-collapsed; `lookupSpokenName`
 * normalizes the same way, so casing in the contact list is irrelevant.
 */

/**
 * Hand-verified entries, kept at the top so they are visible and are
 * never confused with generated ones. These win over anything the
 * generator produces.
 */
export const VERIFIED_NAMES: Readonly<Record<string, string>> = {
  // FlexiFunnels co-founder and CEO, named in the registration scripts.
  // An English TTS voice reads "Saurabh" as "Sore-ab".
  "saurabh bhatnagar": "सौरभ भटनागर",
  saurabh: "सौरभ",
};

/**
 * Generated entries. Everything below this line is written by
 * `npm run names:generate` and may be re-ordered by it.
 *
 * The seed rows are the common first names the TTS evidence corpus
 * already carries, so the corpus and this table can be compared
 * directly. They were checked by hand.
 */
export const GENERATED_NAMES: Readonly<Record<string, string>> = {
  rahul: "राहुल",
  priya: "प्रिया",
  amit: "अमित",
  sunita: "सुनीता",
  rakesh: "राकेश",
  ramesh: "रमेश",
  jyoti: "ज्योति",
  ruchi: "रुचि",
  suman: "सुमन",
  sonia: "सोनिया",
  vaishnavi: "वैष्णवी",
  shubham: "शुभम",
  chhaya: "छाया",
  dhruv: "ध्रुव",
  prathamesh: "प्रथमेश",
  lakshmi: "लक्ष्मी",
  gayatri: "गायत्री",
  krishnan: "कृष्णन",
  sharma: "शर्मा",
  verma: "वर्मा",
};
