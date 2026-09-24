/**
 * classifier.ts
 *
 * Reads a finished call and says what it meant.
 *
 * Rule-based and deterministic on purpose. The same transcript
 * produces the same label on every run, on every machine, with no
 * network call, no cost per call and no model version drifting
 * underneath a comparison whose whole point is that the only thing
 * differing between two calls is the TTS provider. A model-based
 * classifier can be added later as a second `classifier` id and
 * back-filled over the stored transcripts; it must not be the thing
 * that decides whether Cartesia beat Sarvam this week.
 *
 * The rules are honest about what they are. They match phrases people
 * actually say, in English and in Hindi/Hinglish, and they refuse to
 * guess: a call with no decisive signal is labelled `unclear` with
 * `succeeded = NULL`, not quietly counted as a failure. Every matched
 * phrase is stored on the row, so a disputed label can be checked
 * against the words that produced it.
 *
 * Precedence is deliberate and is not the order a naive reading would
 * choose:
 *
 *   opt-out  >  wrong number  >  suspected voicemail  >  confirmation
 *            at the gate  >  callback  >  refusal
 *            >  positive-but-not-at-the-gate  >  unclear
 *
 * Opt-out outranks everything because "take me off your list" said
 * after a yes is still an opt-out, and a compliance signal that can be
 * overwritten by an earlier pleasantry is not a compliance signal.
 *
 * One rule sits UNDER all of that and is what `rules.v2` adds: a phrase
 * only decides anything if the turn it was said in was an answer. On a
 * real call people say "okay, and how long is it?", "theek hai, par ye
 * kis time hai?", "yes I'm interested, but I wanted to know—". Every
 * one of those contains an affirmation token, and not one of them is a
 * registration: two are questions and one is a sentence that was cut
 * off. `conversation-events.ts` reports the speech act; this file
 * refuses to read a verdict into anything that was not an answer, and
 * says so on the signal it stored.
 *
 * A question is therefore never a yes, never a no, and never a reason
 * to close a contact. It is a conversational event, counted in
 * `detail.conversation` so the report can see it, and the call stays
 * exactly as unresolved as it actually was.
 */

import type { CallStatus, FailureClass } from "../domain/call-status";
import {
  outcomeVocabulary,
  RULES_CLASSIFIER_ID,
  OUTCOME_SCHEMA_VERSION,
  type OutcomeClassification,
  type OutcomeConfidence,
  type OutcomeSignal,
  type PrimaryReason,
} from "./outcome-types";
import {
  answerReadability,
  containsPhrase,
  findPhrases,
  hasExplicitRefusal,
  isQuestionTurn,
  normaliseText,
  summariseConversation,
  type ConversationEvents,
} from "./conversation-events";
import { checkScriptAdherence, type ScriptAdherenceReport } from "./script-adherence";
import { VOICEMAIL_MARKERS } from "../../core/session/voicemail-detection";
import { isBareAcknowledgement } from "../../core/session/turn-detection";
import type { TranscriptTurn } from "./transcript";

// ── Phrase tables ─────────────────────────────────────────────────
// Matched against normalised text with spaces around every phrase, so
// "no" matches "no thanks" and never "know" or "number".

const AFFIRMATIONS = [
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "alright", "definitely",
  "absolutely", "of course", "certainly", "please do", "go ahead", "sounds good",
  "i will", "i am in", "count me in", "do it", "book it", "register me",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "haan", "haa", "han ji", "ji haan", "ji", "bilkul", "zaroor", "jarur",
  "theek hai", "thik hai", "kar dijiye", "kar do", "kara dijiye", "pakka",
  // ── The UNSPACED spellings of the same two words ────────────────
  //
  // Deepgram returns "haan ji" as one token as often as two — the rest
  // of this codebase already knows that and treats the spellings as one
  // family: `ACKNOWLEDGEMENT_TOKENS` and `BARE_GREETING_ONLY` in the
  // pipeline both carry "hanji"/"haanji"/"han", and the barge-in and
  // silence-recovery suites feed "Haanji." as a literal.
  //
  // This table did not, and `containsPhrase` matches WHOLE words, so
  // " haanji " never matched " haan " or " ji ". The single commonest
  // Hinglish yes therefore reached the model, was answered, sat in the
  // transcript — and then settled `unclear` / `no_decisive_signal`: no
  // `confirmed_at_gate`, no FINAL_YES, no registrations-sheet row and
  // no auto-hangup. A recognised answer, lost at the last step.
  //
  // These are SPELLINGS of words already in this table, not new
  // vocabulary, which is the whole of the safety case. Bare "ha" is
  // deliberately NOT added: it collides with laughter ("ha ha"), and
  // "haa" above already covers the elongated form.
  "haanji", "hanji", "han",
  "हाँ", "हां", "जी", "जी हाँ", "बिल्कुल", "ज़रूर", "जरूर", "ठीक है", "पक्का",
  // English "yes" in Devanagari, as Soniox writes it. A spelling of
  // "yes" above: without it a "यस" at the gate settled `unclear`.
  "यस", "येस",
];

const NEGATIONS = [
  "no", "nope", "nah", "not interested", "no thanks", "no thank you",
  "i am not interested", "not now", "dont want", "do not want", "not for me",
  "leave it", "cancel it", "i cant", "i cannot", "i will not",
  // ── The SPLIT spellings of the contractions above ───────────────
  //
  // `normaliseText` reduces every non-letter to a space, so "don't"
  // arrives as "don t" and "can't" as "can t". The entries "dont want"
  // and "i cant" therefore match nothing a caller ever says: they can
  // only fire on text that already lacks the apostrophe, which STT
  // does not produce. Measured on the live tables, the same sentence
  // one apostrophe apart:
  //
  //   "I do not want it."  -> declined / explicit_no    (correct)
  //   "I don't want it."   -> unclear                   (WRONG)
  //
  // and `unclear` is UNRESOLVED, which for a registration campaign is
  // a redial 30 minutes later. A person who refused was called back.
  //
  // `GATE_RETRACTIONS` already carries the split spellings for exactly
  // this reason (see "don t want" there, and the note in
  // `confirmation-binding-tests` group B); this table was never
  // brought into line.
  //
  // THE TWO VERB ENTRIES ARE BOUND, AND THE BARE MIRRORS ARE
  // DELIBERATELY ABSENT. "i cannot" above is bare, which already makes
  // "I cannot hear you." settle `declined` — a hearing complaint read
  // as a refusal, and after a gate yes it retracts the registration.
  // That is a pre-existing defect on a spelling people rarely use.
  // Adding bare "i can t" would move it onto the spelling they always
  // use, so what is added is the phrase the refusal actually needs.
  // Same reasoning for "i won t be able" against bare "i won t", which
  // would otherwise capture "I won't be at home, but I'll join from my
  // phone."
  //
  // These are SPELLINGS of phrases already in this table, not new
  // vocabulary, which is the whole of the safety case.
  "don t want", "i can t attend", "i won t be able",
  "nahi", "nahin", "nai", "mujhe nahi chahiye", "interest nahi",
  "नहीं", "नही", "मुझे नहीं चाहिए",
];

/**
 * Phrases that contain a negation token but are not a refusal. Removed
 * from the text before negations are matched, so "no problem" does not
 * end a call that was going well.
 */
const NEGATION_EXCEPTIONS = [
  "no problem", "no issue", "no issues", "no doubt", "no worries",
  "koi baat nahi", "koi dikkat nahi", "koi problem nahi",
];

/**
 * Phrases that say "we are finished talking".
 *
 * At least one of these must be present before a turn may be read as a
 * courtesy sign-off. Without that requirement a bare "No." would be one
 * — it is made entirely of courtesy tokens — and a refusal would stop
 * deciding anything, which is the opposite of the point.
 */
const COURTESY_CLOSERS = [
  "thanks", "thank you", "thanks a lot", "thanks so much", "thank you so much",
  "many thanks", "thankyou", "appreciate it", "i appreciate it",
  "that s all", "that is all", "thats all", "that s it", "that is it", "thats it",
  "that s everything", "that is everything", "nothing else", "nothing more", "no more",
  "i m good", "i am good", "im good", "we re good", "we are good", "all good",
  "i m fine", "i am fine", "im fine", "all set", "i m all set", "i am all set",
  "bye", "goodbye", "good bye", "bye bye", "take care", "have a good day",
  "have a nice day", "see you", "see you there", "see you soon", "cheers",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "bas", "bas itna", "bas itna hi", "itna hi", "aur kuch nahi", "aur kuch nahin",
  "kuch nahi", "dhanyavaad", "dhanyawad", "shukriya", "namaste", "alvida", "khuda hafiz",
  "बस", "बस इतना", "बस इतना ही", "इतना ही", "और कुछ नहीं",
  "धन्यवाद", "शुक्रिया", "नमस्ते", "अलविदा",
];

/**
 * EVERY phrase a turn may consist of and still be nothing but a
 * courtesy close. The closers above, plus the acknowledgement and
 * politeness tokens that surround them.
 *
 * This is an ALLOW-LIST matched against the WHOLE turn, which is what
 * makes the rule safe. A turn is a sign-off only if it decomposes
 * entirely into these — so "No thanks, that's all." is one and "No
 * thanks, cancel it." is not, because "cancel" appears nowhere here.
 * Nothing that names an action, a subject or a reason is a member, and
 * that is deliberate: the moment a turn says something about the
 * registration it stops being a sign-off and goes back to the ordinary
 * rules.
 *
 * Note what is NOT a member: "not", "do", "want", "cancel", "reserve",
 * "register", "join", "attend", "interested", "mind", "for", "me". They
 * are left out so that "No thanks, not for me." — a real refusal that
 * happens to open with courtesy — cannot decompose.
 */
const COURTESY_TOKENS = [
  ...COURTESY_CLOSERS,
  "ok", "okay", "okey", "k", "alright", "all right", "right", "sure", "fine",
  "good", "great", "cool", "nice", "perfect", "lovely",
  "yes", "yeah", "yep", "yup", "ya", "no", "nope", "nah",
  "please", "welcome", "you re welcome", "your welcome", "of course", "sorry",
  "no problem", "no worries", "not at all", "no need", "not required",
  "and", "then", "so", "just", "for now", "for your time", "anyway",
  // Hindi / Hinglish, transliterated and in Devanagari.
  // "haanji"/"hanji" are here for ONE reason: to keep the unspaced
  // spellings in step with the spaced ones now that `AFFIRMATIONS`
  // carries them. This list is an allow-list read only by
  // `COURTESY_SIGNOFF_ONLY`, and without them "Haanji, thanks." stopped
  // decomposing while "Haan ji, thanks." still did — so the same
  // sentence, spelled the other way, silently lost the courtesy reading
  // and out-positioned an earlier no. No rule changes; two spellings of
  // words already in this list do.
  "haan", "haa", "han", "han ji", "haan ji", "haanji", "hanji", "ji", "ji haan",
  "theek", "theek hai", "thik hai", "achha", "accha", "acha",
  "bilkul", "sahi", "sahi hai", "samajh gaya", "samajh gayi",
  "nahi", "nahin", "nai", "koi baat nahi", "koi baat nahin",
  "ठीक है", "ठीक", "हाँ", "हां", "जी", "जी हाँ", "अच्छा", "बिल्कुल", "नहीं", "नही",
];

/**
 * The WHOLE normalised turn is a sequence of courtesy tokens and
 * nothing else.
 *
 * Same shape, and the same reason, as `ACKNOWLEDGEMENT_ONLY` in
 * `turn-detection.ts`: anchored at both ends, so a single word the list
 * does not contain fails the whole match. Longest phrases are tried
 * first, which only affects how quickly the match is found — the engine
 * backtracks, so a turn that CAN decompose always does.
 */
const COURTESY_SIGNOFF_ONLY = new RegExp(
  `^(?: (?:${[...COURTESY_TOKENS].sort((a, b) => b.length - a.length).join("|")}))+ $`,
  "u",
);

/**
 * A turn that ends the conversation politely and decides nothing.
 *
 * "Okay, thanks.", "No thanks, that's all.", "Nahi, bas itna hi." Every
 * one of them contains a token the phrase tables read as a verdict, and
 * not one of them is a verdict: they are what a person says when the
 * business of the call is already over. Read as keywords they flip the
 * call in whichever direction the last token happened to point —
 * a "no" already given is reopened by the "okay", and a registration
 * already given is taken back by the "no".
 *
 * Two conditions, both required. The turn must SAY it is closing (a
 * phrase from `COURTESY_CLOSERS`), and it must say nothing else at all
 * (`COURTESY_SIGNOFF_ONLY`). Neither alone is enough: "Thanks, but I
 * changed my mind" has the closer and fails the second, "No." has
 * neither.
 *
 * Where this is allowed to apply is decided at the call site, and never
 * at the commitment question — see the loop in `classifyOutcome`.
 */
function isCourtesySignOff(normalisedTurn: string): boolean {
  return (
    containsPhrase(normalisedTurn, COURTESY_CLOSERS) &&
    COURTESY_SIGNOFF_ONLY.test(normalisedTurn)
  );
}

/**
 * Ways a person TAKES BACK a registration they have already given,
 * which carry no token from `NEGATIONS` above and none from the shared
 * `EXPLICIT_REFUSALS` table in `conversation-events.ts`.
 *
 * Read by `retractsTheGate` and by nothing else, and only in the
 * `STATEMENT_OR_NONE` context — a turn volunteered after the agent made
 * a statement. It cannot widen `record("negation", ...)`, cannot move
 * `lastNegationPosition`, and therefore cannot change the label of any
 * call that never reached the gate.
 *
 * Deliberately tiny. It exists because two shapes of genuine retraction
 * are invisible to both existing tables:
 *
 *   "I changed my mind. Please do not reserve it."
 *   "I don't want to join anymore."
 *
 * The first contains no negation token at all — "do not" on its own is
 * in neither table, and "do not want" does not occur. The second is the
 * same sentence as "I do not want to join anymore", which both tables
 * already match, written with an apostrophe: `normaliseText` reduces
 * every non-letter to a space, so "don't" arrives as "don t" and the
 * entry "dont want" can never match a contraction. That is why the
 * spellings below look wrong — they are the normalised forms, and the
 * apostrophe spelling is the one people actually say.
 *
 * Nothing here is a general vocabulary fix: the shared refusal table is
 * untouched, because it also decides the live mid-call hangup in
 * `call-runner.ts`.
 */
const GATE_RETRACTIONS = [
  "changed my mind", "change my mind",
  "do not reserve", "dont reserve", "don t reserve",
  "do not register", "dont register", "don t register",
  "do not book", "dont book", "don t book",
  "don t want",
  // Cancelling the thing by name. The negation table carries "cancel
  // it" and nothing longer, so "Please cancel my registration." — as
  // plain a cancellation as exists — contained no negation phrase, no
  // refusal phrase and no retraction phrase, and stayed
  // `registered_confirmed` all the way to the sheet.
  "cancel my registration", "cancel the registration", "cancel my seat",
  "cancel my spot", "cancel my booking", "cancel my place", "cancel that",
  "cancel my naam", "registration cancel", "seat cancel",
  // ── "I won't be there" — the withdrawal that names no action ────
  //
  // Every entry above cancels something by name. A person who has
  // already been confirmed usually does not: they say they cannot come.
  // Measured after a gate yes and the [YES] block, all of these stayed
  // `registered_confirmed` and wrote a sheet row for somebody who had
  // just withdrawn:
  //
  //   "Actually I can't make it."            -> registered_confirmed
  //   "I'm not going to be able to attend."  -> registered_confirmed
  //   "I am not able to attend."             -> registered_confirmed
  //
  // while "Actually I cannot make it." and "Actually I will not be able
  // to attend." already retracted, through `NEGATIONS`. So the same
  // withdrawal was recorded or lost on the spelling alone.
  //
  // BOUND, NEVER GENERIC. Not "can't", not "won't", not "not": every
  // entry names attending or making it, which is the only thing this
  // call asked them to do. A bare verb here would retract on "I can't
  // hear you." and on "I won't need a laptop".
  //
  // CONTEXT IS UNCHANGED AND IS WHAT CARRIES THE SAFETY. This table is
  // read only through `retractsTheGate`, which returns false for
  // `OTHER_QUESTION` BEFORE any vocabulary is consulted — so "I won't
  // be able to attend that one." answering "would you like the
  // follow-up session too?" still leaves the registration standing,
  // exactly as `confirmation-binding-tests` group A requires. And
  // because this table feeds no `record("negation", ...)`, a call that
  // never reached the gate is classified exactly as it was: a
  // withdrawal with no registration behind it stays `unclear`.
  //
  // Both spellings of each contraction, the same way "dont reserve" /
  // "don t reserve" are carried above.
  "can t make it", "cant make it", "cannot make it",
  "won t make it", "wont make it", "will not make it",
  "not able to attend", "not going to be able", "not going to make it",
  // Hindi / Hinglish, transliterated and in Devanagari — every other
  // table in this file is bilingual, and a retraction table that only
  // understood English would be a defect on exactly the calls this
  // campaign makes.
  "man badal", "mann badal", "irada badal",
  "मन बदल", "इरादा बदल",
];

/**
 * Phrases that begin with an affirmation token but commit to nothing.
 *
 * The mirror of NEGATION_EXCEPTIONS, and needed for the same reason.
 * "i will" is in the table above because "I will attend" is a real yes;
 * it also matches "I will see how the day goes", which is a hedge. At
 * the commitment question the difference is the whole outcome, so these
 * are removed before affirmations are matched.
 */
/**
 * ── "<no> ji" — THE POLITE REFUSAL, IN EVERY SPELLING OF BOTH HALVES ──
 *
 * GENERATED as a cross-product on purpose, because an incomplete
 * cross-product is precisely what the defect was. "ji" is in
 * `AFFIRMATIONS` because a bare "Ji." at the gate is a real yes — and
 * it also sits inside "nahi ji", the commonest polite Hinglish NO.
 * Rule 4 (a yes at the gate) runs before rule 6 (a no that nothing
 * followed) and short-circuits, so measured on the live tables:
 *
 *   gate -> "Ji nahi."  -> declined / explicit_no          (correct)
 *   gate -> "Nahi ji."  -> registered_confirmed            (WRONG)
 *   gate -> "नहीं जी"    -> registered_confirmed            (WRONG)
 *
 * The two orders differ only in which token lands last: the retraction
 * position is read off the negation, so "ji nahi" puts the "ji" BEFORE
 * it and the gate affirmation is filtered out, while "nahi ji" puts it
 * after and survives. A person who declined was written to the
 * registrations sheet and hung up on with FINAL_YES.
 *
 * BOTH HALVES VARY INDEPENDENTLY, which is why this is not a literal
 * list. Deepgram runs here in `multi` mode and can return either half
 * in either script — including mixed, "नहीं ji" — so a hand-written
 * list of the romanized pairs left eight of the twelve combinations
 * broken. Enumerating the product cannot miss one, and a spelling added
 * to either row is automatically covered in both scripts.
 *
 * The negation row is exactly the bare-negation spellings from
 * `NEGATIONS`; the honorific row is the two spellings of "ji" from
 * `AFFIRMATIONS`. Nothing new is introduced by either.
 */
const POLITE_REFUSAL_NEGATIONS = ["nahi", "nahin", "nai", "no", "नहीं", "नही"];
const POLITE_REFUSAL_HONORIFICS = ["ji", "जी"];
const POLITE_REFUSALS = POLITE_REFUSAL_NEGATIONS.flatMap((negation) =>
  POLITE_REFUSAL_HONORIFICS.map((honorific) => `${negation} ${honorific}`),
);

const AFFIRMATION_EXCEPTIONS = [
  "i will see", "i will try", "i will check", "i will think", "i will let you know",
  "i will decide", "i will confirm later", "i will get back",
  "dekhta hu", "dekhti hu", "dekhenge", "soch kar", "sochkar", "try karunga", "try karungi",
  "देखता हूँ", "देखती हूँ", "देखेंगे", "सोचकर",
  // "sure" is in the table above because "Sure." at the gate is a real
  // yes; it also matches "not sure", which is the opposite. Found on the
  // reminder v2 gate: "Maybe, not sure yet." settled as confirmed_at_gate
  // and would have written a sheet row. Same class of fix as "i will see".
  "not sure", "pata nahi", "nahi pata",
  // The polite refusal, both scripts, both orders of script — see
  // `POLITE_REFUSALS`. Stripped here rather than anywhere else for the
  // same reason "not sure" is: this list is the one place a phrase can
  // stop being read as an affirmation WITHOUT touching how negations,
  // retractions, courtesy sign-offs or the gate binding are computed.
  // `forNegations` is a separate string and is untouched, so the turn
  // still declines on its own "nahi" exactly as it always did.
  //
  // Bounded: every entry contains a negation token, so no affirmative
  // turn can lose a phrase to this.
  ...POLITE_REFUSALS,
];

const CALLBACK = [
  "call me later", "call later", "call me back", "call back", "callback",
  "ring me later", "some other time", "another time", "later please",
  "i am busy", "im busy", "busy right now", "in a meeting", "driving",
  // "Can you call me tomorrow?" is the single most common way a person
  // asks for a callback, and it was not in this table: it fell through
  // to `unclear`. Same reading, but the label now says what the person
  // actually asked for, and the callback wait applies instead of the
  // generic unresolved one.
  "call me tomorrow", "call tomorrow", "call me in the evening",
  "call me after", "call after", "try me later", "later in the day",
  // "im busy" above is unreachable for the same normalisation reason
  // the negation table documents: "I'm busy." arrives as " i m busy ".
  // Its expansion "I am busy." is already a callback here, so without
  // this the same sentence is a callback or an UNRESOLVED redial
  // depending only on whether the caller used a contraction.
  "i m busy",
  "baad me", "baad mein", "abhi busy", "abhi vyast", "phir call", "baad me call",
  "baad mein call", "baad me call karna", "baad mein call karna",
  "thodi der baad", "thodi der bad", "kal call", "kal phone", "kal baat",
  "abhi time nahi", "abhi samay nahi",
  "बाद में", "अभी व्यस्त", "कल कॉल", "थोड़ी देर बाद",
];

const WRONG_NUMBER = [
  "wrong number", "wrong person", "no such person", "you have the wrong",
  "he does not live here", "she does not live here", "this is not",
  "galat number", "galat", "koi aur hai",
  "गलत नंबर", "गलत",
];

const OPT_OUT = [
  "do not call", "dont call", "stop calling", "never call", "remove my number",
  "remove me", "unsubscribe", "take me off", "report you", "harassing",
  "call mat karo", "phone mat karo", "number hata do", "mat call",
  // ── The SPLIT spelling, and the other Hindi imperative ──────────
  //
  // The same normalisation gap as `NEGATIONS`, and this is the table
  // where it costs the most. "dont call" cannot match speech, so:
  //
  //   "Do not call me again."  -> do_not_call / FINAL_NO, hangs up
  //   "Don't call me again."   -> unclear / UNRESOLVED, KEEPS PITCHING
  //                               and redials 30 minutes later
  //
  // A do-not-call request an apostrophe can switch off is not a
  // compliance control. "do nt call" is the other tokenisation some
  // recognisers produce for the same word.
  //
  // "karna" is the imperative this table was missing next to "karo":
  // "Aage se call mat karna." is as plain an opt-out as "call mat
  // karo" and settled `unclear`. BOUND TO call/phone, exactly like
  // every other Hindi entry here — bare "mat karna" would make
  // "Fikar mat karna, main aa jaunga." ("don't worry, I'll come") an
  // opt-out, and this table outranks a yes at the gate, so a false
  // positive closes a registered contact permanently.
  "don t call", "do nt call", "call mat karna", "phone mat karna",
  "कॉल मत", "नंबर हटा",
];

/**
 * Phrases only an answering machine says — `VOICEMAIL_MARKERS`,
 * imported above from `core/session/voicemail-detection.ts`.
 *
 * It used to be declared here. It moved because the PIPELINE now reads
 * the same phrases live, to stop the agent talking to a machine at all,
 * and a live gate that disagreed with the label the call is later given
 * would be worse than no gate. The table, its order and the way it is
 * matched are unchanged, and so is everything this file does with it: a
 * transcript heuristic, never proof, and a machine must never become a
 * registration.
 */

/**
 * Assistant questions where a "yes" is a COMMITMENT rather than
 * politeness. A yes to "can I tell you in 20 seconds" is interest; a
 * yes to "should I reserve your free seat" is a registration, and only
 * the second one may be counted as a success.
 *
 * Patterns rather than exact script text: a campaign may run a
 * shortened or re-worded script, and this must degrade to "positive
 * but not at the gate" rather than to a false success.
 */
const COMMIT_ANCHORS: Readonly<Record<string, readonly string[]>> = {
  registration: [
    "reserve your free seat", "reserve your seat", "reserve a seat", "should i reserve",
    "reserve karu", "seat reserve", "book your seat",
    "your registration done", "register you", "registration done", "shall i register",
    "count on you to attend", "attend live", "mark you as confirmed",
    // The approved registration v3 script's actual commitment question
    // is "Would you be interested to attend?" — the [YES] branch right
    // after it is "I'll get your registration done". v1 and v2 asked
    // "would you like me to register you...", which "register you"
    // already matched; v3 re-worded that line and nothing here matched
    // it, so a real "Yes." to the gate landed as
    // `affirmative_not_at_gate` / `interested_not_confirmed`. That is
    // one label short of FINAL_YES, which is what the sheet mirror and
    // the end-of-call check both read — so on v3 a confirmed
    // registration could reach neither. Same fix, and same reason, as
    // the three reminder anchors above.
    "interested to attend", "interested in attending",
    "like to attend", "want to attend",
    // ── THE CODE-MIXED MIDDLE ────────────────────────────────────
    //
    // Added for registration v16, which writes its Hinglish with the
    // Hindi words in Devanagari and the English terms in Latin —
    // "तो क्या मैं आपकी free seat reserve कर दूँ?" — because a
    // romanized Hindi sentence is read by a non-Indic TTS voice with
    // English pronunciation rules.
    //
    // That script's own gate line is already matched by "seat reserve"
    // above, since it keeps those two words in Latin deliberately. The
    // problem is everything ELSE the model says: it writes the prose,
    // not the script file, and it will not hold one fixed spelling of
    // every noun for a whole call. Measured against `classifyOutcome`
    // before these were added, each of these settled
    // `affirmative_not_at_gate` — a person who said yes, recorded as
    // merely interested, with no sheet row, no FINAL_YES, no hangup
    // and no error anywhere:
    //
    //   "...आपकी free सीट reserve कर दूँ?"
    //   "...आपकी free seat रिज़र्व कर दूँ?"
    //   "...आपकी free seat पक्की कर दूँ?"
    //   "...आपकी मुफ़्त सीट आरक्षित कर दूँ?"
    //
    // Both this table and `GATE_ACTIONS` already carried pure-Latin and
    // pure-Devanagari entries. Neither carried the mix, which is the
    // only thing a Hinglish call actually produces.
    //
    // Every one is VERB-BOUND and none of them appears anywhere else in
    // an approved script — v16's [YES] block says "seat Sunday, 4th
    // October ... के लिए reserve हो गयी है", where the two words are not
    // adjacent, so it does not match. That bound is what keeps this
    // from registering somebody at a line that is not the gate.
    "सीट reserve", "seat रिज़र्व", "सीट रिज़र्व", "सीट आरक्षित", "seat आरक्षित",
    "सीट पक्की", "seat पक्की", "सीट book", "seat बुक", "सीट बुक",
    "रजिस्टर कर", "आपको register",
  ],
  reminder: [
    "will you attend", "are you attending", "will you join", "are you joining",
    // The approved reminder script's actual commitment question is
    // "will you be joining us live?". Without these three the anchor
    // list matched a paraphrase of that line but not the line itself,
    // so a real "yes, I'll join" landed as acknowledged-but-not-
    // confirmed and a reminder could never record a confirmation.
    "will you be joining", "joining us live", "join us live",
    "confirm your attendance", "can i confirm", "count on you", "attend live",
    "aap aayenge", "join karenge",
  ],
};

/**
 * The agent OFFERING to do something on the person's behalf.
 *
 * Half of the paraphrased-gate test below, and useless on its own —
 * "Can I tell you in 20 seconds..." and "Shall I send the link on
 * WhatsApp?" both open this way and neither commits anybody.
 */
const GATE_OFFERS = [
  "should i", "shall i", "can i", "could i", "may i", "should we", "shall we",
  "would you like me to", "would you like us to", "do you want me to",
  "want me to", "do you want us to", "would you like", "do you want",
  "are you happy for me to", "is it ok if i", "is it okay if i",
  // Hindi / Hinglish, transliterated and in Devanagari.
  "kya main", "main aapko", "main aapka", "main aapki", "main aapke",
  "kar du", "kar doon", "kar dun", "kardu", "karu", "karoon",
  "likh du", "likh doon", "kya aap chahte", "kya aap chahti",
  "क्या मैं", "मैं आपका", "मैं आपकी", "मैं आपको", "कर दूँ", "कर दूं", "लिख दूँ",
];

/**
 * ...and the act of registering THIS PERSON, bound to them.
 *
 * The other half, and the half that carries the safety. Every entry
 * names the person the action is done to or for — "reserve YOUR",
 * "register YOU", "put YOU down", "reserve this FOR YOU". A bare verb
 * is deliberately absent: "book", "reserve", "register" and "join" on
 * their own turn "Should I explain how to book a seat?" and "Do you
 * want me to send the booking link?" into commitment questions, which
 * is the false positive that matters most here — it would close a
 * contact as registered on a question about a link.
 *
 * Tense matters too, and whole-word matching gives it for free: "book
 * your" does not match "Have you booked your seat already?", which asks
 * about the past and commits to nothing.
 */
const GATE_ACTIONS = [
  "reserve your", "reserve you", "reserve this for you", "reserve it for you",
  "reserve that for you", "reserve a spot for you", "reserve a seat for you",
  "book your", "book you", "book this for you", "book it for you",
  "book that for you", "book a place for you", "book a seat for you",
  "register you", "registering you", "get you registered", "get you signed up",
  "get you booked", "get you a seat", "get you a spot",
  "sign you up", "signing you up", "put you down", "putting you down",
  "put your name down", "add you to the list", "add your name to the list",
  "save your seat", "save your spot", "save your place",
  "hold your seat", "hold your spot", "hold your place",
  "block your seat", "block your spot", "block your place",
  "confirm your seat", "confirm your spot", "confirm your place",
  "enroll you", "enrol you", "registered for this", "registered for it",
  // Hindi / Hinglish, transliterated and in Devanagari.
  //
  // Verb-bound, never possessive-bound. "aapka naam" alone looked like
  // the natural mirror of "your name", and it also matches "Kya main
  // aapka naam sahi bol raha hoon?" — am I saying your name right —
  // which is a spelling check, not a gate. So is "aapki seat", which
  // turns "Kya main aapki seat number bata du?" into a registration.
  // The Hindi possessive carries none of the commitment; the verb
  // after it does, so the verb is what these match.
  "aapko register", "aapko book", "aapko enroll", "aapko add",
  "seat reserve", "seat book", "seat pakki", "seat confirm",
  "jagah reserve", "jagah book", "jagah pakki",
  "naam likh", "naam note", "naam darj", "naam add", "naam likhwa",
  "register kar du", "register kar doon", "register kar dun",
  "registration kar du", "booking kar du",
  "आपको रजिस्टर", "नाम लिख", "नाम दर्ज", "सीट रिज़र्व", "सीट बुक", "जगह बुक",
  // The code-mixed middle, for the same reason and with the same
  // verb-bound rule as the block added to `COMMIT_ANCHORS` above:
  // registration v16 speaks Hindi in Devanagari and keeps the English
  // terms in Latin, so a noun and its verb routinely land in different
  // scripts. A pure-Latin table and a pure-Devanagari table between
  // them match neither "सीट reserve" nor "seat रिज़र्व".
  "सीट reserve", "seat रिज़र्व", "सीट आरक्षित", "seat आरक्षित",
  "सीट पक्की", "seat पक्की", "सीट book", "seat बुक",
  "आपको register", "रजिस्टर कर",
];

/**
 * A commitment question the anchor table does not spell out.
 *
 * `COMMIT_ANCHORS` lists the wordings the approved scripts actually
 * use, which is right for a script the campaign controls and wrong the
 * moment the agent paraphrases — and it does. "Would you like me to put
 * you down for it?", "Should I go ahead and reserve this for you?",
 * "Can I get you registered for this?" are all the gate, and a "Yes."
 * to any of them landed as `affirmative_not_at_gate` /
 * `interested_not_confirmed`: one label short of FINAL_YES, so neither
 * the sheet mirror nor the end-of-call check ever saw the registration.
 * Same failure the v3 re-wording caused, one step more general.
 *
 * THREE conditions, all required, and the conjunction is the whole
 * safety argument:
 *
 *   1. The turn ASKS. A gate is a question put to the person. This is
 *      what keeps the agent's own confirmation out — "Great, I'll
 *      reserve that for you." is a statement, and reading it as the
 *      gate would make the next "Yes." a registration and bind every
 *      later refusal to it.
 *   2. The agent OFFERS to act (`GATE_OFFERS`).
 *   3. The act is registering THIS PERSON (`GATE_ACTIONS`).
 *
 * Only the LITERAL anchors are unconditional, exactly as before, so
 * this can add a gate and never take one away: every transcript that
 * matched an anchor still matches it, on the same line, with the same
 * `atGate`.
 */
function isParaphrasedGate(rawText: string, normalised: string): boolean {
  if (!isQuestionTurn(rawText)) return false;
  return containsPhrase(normalised, GATE_OFFERS) && containsPhrase(normalised, GATE_ACTIONS);
}

// ── Normalisation ─────────────────────────────────────────────────
// `normaliseText` and `findPhrases` live in `conversation-events.ts` so
// that the speech-act reader and the phrase tables below can never
// disagree about what a word is. Behaviour is unchanged: same casing,
// same handling of Devanagari combining marks, same whole-word matching
// through the padded needle.

const normalise = normaliseText;

/** Ordering key that respects position WITHIN a turn as well as across turns. */
const positionOf = (turnIndex: number, offset: number) => turnIndex * 1_000_000 + offset;

// ── Input ─────────────────────────────────────────────────────────

export interface ClassifyOutcomeInput {
  readonly campaignType: string;
  /** Final attempt status, as written to `call_attempts`. */
  readonly status: CallStatus;
  readonly failureClass: FailureClass;
  /** True only when the telephony provider confirmed the callee picked up. */
  readonly answered: boolean;
  readonly transcript: readonly TranscriptTurn[];
  /** Recorded verbatim in the explanation when the call never connected. */
  readonly failureReason?: string | null;
  /**
   * ADDITIVE, OPTIONAL. The approved script's text, used only to check
   * that the AGENT stayed on it (see `script-adherence.ts`). It never
   * changes the outcome: with it absent, every label this function
   * produces is identical.
   */
  readonly scriptText?: string;
  /**
   * ADDITIVE, OPTIONAL. The IDENTITY GATE'S OWN VERDICT: the person
   * on the line said they are not the person we called.
   *
   * Not a reading of the transcript and not a second phrase table —
   * it is `ConversationPipeline`'s `denied` state, produced by
   * `classifyIdentityAnswer` from the one turn that answered the one
   * question "am I speaking with <name>?", and carried here by
   * `call-runner.ts` through the manager.
   *
   * WHY IT HAS TO BE CARRIED. This function is the single point all
   * four campaign consequences hang off — the stored outcome, the
   * contact disposition (and therefore the retry planner), the
   * registrations-sheet mirror and the early hangup all read the
   * label it produces. It reads the transcript, and the transcript
   * does not record which sentence was the identity question, so a
   * denial whose words are not in `WRONG_NUMBER` ("No.", "Nahi, main
   * Sakshi nahi hoon") was invisible here. Rule 4 below then read a
   * later generic "Haan" at the commitment question as a
   * registration, and the wrong person got a sheet row and a closed
   * contact.
   *
   * ABSENT OR FALSE, EVERY LABEL THIS FUNCTION PRODUCES IS
   * IDENTICAL. Non-campaign callers, re-scoring of stored rows, and
   * every call whose gate was confirmed, unclear or never asked pass
   * nothing and are unchanged.
   */
  readonly identityDenied?: boolean;
}

// ── The classifier ────────────────────────────────────────────────

export function classifyOutcome(input: ClassifyOutcomeInput): OutcomeClassification {
  const vocabulary = outcomeVocabulary(input.campaignType);

  // What kind of conversation this was, and whether the agent stayed on
  // the script. Both are DIAGNOSTIC: they are attached to every row
  // below and read by the report, and neither one is consulted by a
  // single decision rule.
  const conversation = summariseConversation(input.transcript);
  const adherence =
    input.scriptText !== undefined && input.scriptText.trim().length > 0
      ? checkScriptAdherence({ scriptText: input.scriptText, transcript: input.transcript })
      : undefined;
  const diagnostics = { conversation, ...(adherence ? { adherence } : {}) };

  // ── 1. Calls that never became conversations ────────────────────
  if (!input.answered) {
    const reason = notConnectedReason(input);
    return build({
      outcomeType: "not_connected",
      succeeded: false,
      primaryReason: reason,
      confidence: input.failureClass === "NO_ANSWER" || input.failureClass === "BUSY" ? "high" : "medium",
      campaignType: input.campaignType,
      customerTurns: 0,
      assistantTurns: 0,
      signals: [],
      explanation:
        input.failureReason?.trim() ||
        `The call ended as ${input.status} without being answered, so there is nothing to classify.`,
    });
  }

  const customerTurns = input.transcript.filter((turn) => turn.role === "user" && turn.text.length > 0);
  const assistantTurns = input.transcript.filter((turn) => turn.role === "assistant" && turn.text.length > 0);

  if (input.transcript.length === 0) {
    return build({
      outcomeType: "no_engagement",
      succeeded: false,
      primaryReason: "no_transcript",
      confidence: "low",
      campaignType: input.campaignType,
      customerTurns: 0,
      assistantTurns: 0,
      signals: [],
      ...diagnostics,
      explanation:
        "The call was answered but no transcript was captured, so the outcome is unknown rather than negative.",
    });
  }

  if (customerTurns.length === 0) {
    return build({
      outcomeType: "no_engagement",
      succeeded: false,
      primaryReason: "no_customer_speech",
      confidence: "high",
      campaignType: input.campaignType,
      customerTurns: 0,
      assistantTurns: assistantTurns.length,
      signals: [],
      ...diagnostics,
      explanation: "The call connected and the agent spoke, but the person said nothing that was heard.",
    });
  }

  // ── 2. Every phrase that matters, with its position ─────────────
  const signals: OutcomeSignal[] = [];
  const positions = new Map<OutcomeSignal, number>();
  const anchors = COMMIT_ANCHORS[input.campaignType] ?? COMMIT_ANCHORS["registration"] ?? [];
  /**
   * Where, in the ordering key below, each turn that TAKES BACK a yes
   * already given at the gate did so. See `retractsTheGate` —
   * everything else the person says "no" to during the rest of the call
   * is an answer to that other thing.
   *
   * A map of positions rather than a set of turn indices because a
   * retraction no longer has to contain a phrase from `NEGATIONS`: "I
   * changed my mind. Please do not reserve it." retracts and contributes
   * no negation signal, so there is nothing else to read a position off.
   * Turns that DO carry negations keep the position they had before —
   * see `retractionOffset`.
   */
  const retractionPositions = new Map<number, number>();

  input.transcript.forEach((turn, turnIndex) => {
    if (turn.role !== "user" || turn.text.length === 0) return;

    const raw = normalise(turn.text);
    // "no problem" must not read as a refusal.
    let forNegations = raw;
    for (const exception of NEGATION_EXCEPTIONS) {
      forNegations = forNegations.split(` ${exception} `).join(" ");
    }
    // ...and "I will see how the day goes" must not read as a yes.
    let forAffirmations = raw;
    for (const exception of AFFIRMATION_EXCEPTIONS) {
      forAffirmations = forAffirmations.split(` ${exception} `).join(" ");
    }

    const negationHits = findPhrases(forNegations, NEGATIONS);

    const commitContext = commitQuestionContext(input.transcript, turnIndex, anchors);
    const atGate = commitContext.answering === "ANCHOR";

    // Was this turn an ANSWER at all? A question and a sentence that was
    // cut off are conversational events, not verdicts — the phrases in
    // them are still recorded, for audit, but marked non-decisive so no
    // rule below can close a contact on one.
    const readability = answerReadability(turn.text, raw);

    // ...and was it a COURTESY CLOSE rather than an answer? "Okay,
    // thanks." and "No thanks, that's all." carry a verdict token each
    // and neither is a verdict; they are how a finished call ends.
    //
    // Where that is allowed to matter depends on what was asked, for
    // the same reason the retraction binding does:
    //
    //   ANCHOR             nothing is suppressed. The person is
    //                      answering the question that commits them,
    //                      and "Okay, thanks." there is a registration
    //                      — it is the single most common way one is
    //                      given. "No thanks." there is a refusal.
    //
    //   anywhere else      the AFFIRMATION stops deciding, and the
    //                      negation stops RETRACTING but still counts
    //                      as an ordinary no.
    //
    // The asymmetry is the safe half of the rule, and it is deliberate.
    // Away from the gate a courtesy affirmation can do exactly two
    // things, and both are wrong: out-position an earlier no so that a
    // `declined` call reads as unresolved, or land as
    // `affirmative_not_at_gate`. It can never be a registration —
    // `atGate` is already false — so nothing is lost by silencing it.
    //
    // A courtesy negation is not silenced the same way, because on a
    // call that never reached the gate "No thanks, that's all." said to
    // a pitch IS the refusal, and turning that into `unclear` would put
    // a person who declined back in the retry queue. All it loses is
    // the power to TAKE BACK a registration already given, which is the
    // only thing this issue is about.
    //
    // Nothing here touches `opt_out`, `wrong_number`, `voicemail` or
    // `callback`: a compliance signal a polite word could switch off
    // would not be a compliance signal, so "No thanks, take me off your
    // list." is still an opt-out and still outranks everything.
    const courtesyClose =
      commitContext.answering !== "ANCHOR" && isCourtesySignOff(raw);
    const affirmationDecisive = readability.affirmationDecisive && !courtesyClose;

    // ...and if it IS an answer, is it an answer that takes back a
    // registration already given? Recorded per turn, next to the four
    // facts it is derived from, and read by rule 4 below.
    if (
      readability.negationDecisive &&
      !courtesyClose &&
      retractsTheGate(raw, commitContext.retraction, negationHits.length > 0)
    ) {
      retractionPositions.set(
        turnIndex,
        positionOf(turnIndex, retractionOffset(raw, negationHits)),
      );
    }

    const record = (
      kind: OutcomeSignal["kind"],
      hits: { phrase: string; offset: number }[],
      decisive = true,
    ) => {
      for (const hit of hits) {
        const signal: OutcomeSignal = {
          kind,
          phrase: hit.phrase,
          turnIndex,
          // A phrase that may not be read as an answer is not at the
          // gate either, whatever question preceded it.
          atGate: kind === "affirmation" ? atGate && decisive : false,
          ...(decisive ? {} : { decisive: false }),
        };
        signals.push(signal);
        positions.set(signal, positionOf(turnIndex, hit.offset));
      }
    };

    const voicemailHits = findPhrases(raw, VOICEMAIL_MARKERS);

    record("opt_out", findPhrases(raw, OPT_OUT));
    record("wrong_number", findPhrases(raw, WRONG_NUMBER));
    record("voicemail", voicemailHits);
    record("callback", findPhrases(raw, CALLBACK));
    // A turn that a machine spoke contributes NO affirmation. Bare
    // tokens such as "ok" or "ji" occur inside greetings, and one of
    // them landing after the commitment question would otherwise read
    // as a high-confidence registration.
    if (voicemailHits.length === 0) {
      record("affirmation", findPhrases(forAffirmations, AFFIRMATIONS), affirmationDecisive);
    }
    record("negation", negationHits, readability.negationDecisive);
  });

  const positionFor = (signal: OutcomeSignal) => positions.get(signal) ?? 0;
  const of = (kind: OutcomeSignal["kind"]) => signals.filter((signal) => signal.kind === kind);

  const shared = {
    campaignType: input.campaignType,
    customerTurns: customerTurns.length,
    assistantTurns: assistantTurns.length,
    signals,
    ...diagnostics,
  };

  // ── 3. Compliance first ─────────────────────────────────────────
  const optOuts = of("opt_out");
  if (optOuts.length > 0) {
    return build({
      ...shared,
      outcomeType: "do_not_call",
      succeeded: false,
      primaryReason: "opt_out",
      confidence: "high",
      explanation: `The person asked not to be contacted again ("${optOuts[0]?.phrase}"). Do not retry this number.`,
    });
  }

  // ── 3a. The identity gate already asked, and was told no ────────
  //
  // Placed here, WITH the wrong-number rule and under the compliance
  // rule, because that is what it is: the repository's existing name
  // for "not the person we were calling" is `wrong_number` /
  // `wrong_person` (`outcome-types.ts`), its contact-level meaning is
  // already FINAL_NO (`disposition.ts`: "this number does not reach
  // the intended person"), and this rule already outranks the
  // commitment gate. No new outcome type, no new reason, no new
  // disposition and no new retry policy — the verdict is simply made
  // visible to the one function every consequence reads.
  //
  // IT OUTRANKS THE GATE AND NOTHING ELSE OUTRANKS IT BUT COMPLIANCE.
  // `opt_out` stays first: somebody who says they are not Sakshi AND
  // asks never to be called again is an opt-out, and a compliance
  // signal a later rule could switch off would not be one.
  //
  // WHAT IT CANNOT DO. It cannot fire on an `unclear` gate — the
  // pipeline re-asks those and gives up on the third, and neither
  // path ever sets `denied`. It cannot fire on a confirmed gate. And
  // it cannot be reached by a call that has no identity gate at all,
  // which is every non-campaign session and every script that does
  // not require a name.
  if (input.identityDenied === true) {
    return build({
      ...shared,
      outcomeType: "wrong_number",
      succeeded: false,
      primaryReason: "wrong_person",
      confidence: "high",
      explanation:
        `The person said they are not the person we called, in answer to the question that asks ` +
        `exactly that, so nothing said afterwards is read as their agreement.`,
    });
  }

  const wrongNumbers = of("wrong_number");
  if (wrongNumbers.length > 0) {
    return build({
      ...shared,
      outcomeType: "wrong_number",
      succeeded: false,
      primaryReason: "wrong_person",
      confidence: "medium",
      explanation: `The person indicated we reached the wrong number ("${wrongNumbers[0]?.phrase}").`,
    });
  }

  // ── 3b. A machine, as far as the words can tell ─────────────────
  // Placed before every decision rule: if the words we have are a
  // greeting, the call decided nothing, and the honest label is "no
  // engagement" rather than any reading of what a machine said.
  const voicemails = of("voicemail");
  if (voicemails.length > 0) {
    return build({
      ...shared,
      outcomeType: "no_engagement",
      succeeded: false,
      primaryReason: "suspected_voicemail",
      confidence: "low",
      suspectedVoicemail: true,
      explanation:
        `The transcript contains a voicemail greeting ("${voicemails[0]?.phrase}"), so this call most ` +
        `likely reached a machine. This is a transcript heuristic only — the platform has no ` +
        `answering-machine detection, so it is not confirmed and no registration is inferred from it.`,
    });
  }

  // ── 4. A yes at the gate, not retracted afterwards ──────────────
  // Only DECISIVE phrases decide. A "yes" inside a question and a "no"
  // inside an unfinished sentence stay on the row as evidence of what
  // was said, and are excluded from every rule from here down.
  const isDecisive = (signal: OutcomeSignal) => signal.decisive !== false;
  const affirmations = of("affirmation").filter(isDecisive);
  const negations = of("negation").filter(isDecisive);
  const callbacks = of("callback");

  const lastNegationPosition = negations.reduce(
    (latest, signal) => Math.max(latest, positionFor(signal)),
    -1,
  );
  // Only a RETRACTION takes back a yes at the gate — not every later
  // "no". `lastNegationPosition` above is deliberately left alone and
  // still drives rule 6, so a call that never reached the gate is
  // classified exactly as it was before this distinction existed.
  const lastRetractionPosition = [...retractionPositions.values()].reduce(
    (latest, position) => Math.max(latest, position),
    -1,
  );
  const gateAffirmations = affirmations.filter(
    (signal) => signal.atGate && positionFor(signal) > lastRetractionPosition,
  );

  if (gateAffirmations.length > 0) {
    return build({
      ...shared,
      outcomeType: vocabulary.success,
      succeeded: true,
      primaryReason: "confirmed_at_gate",
      confidence: "high",
      explanation:
        `The person agreed ("${gateAffirmations[0]?.phrase}") in answer to the question that commits them, ` +
        `and did not take it back afterwards.`,
    });
  }

  // ── 5. Asked to be called another time ──────────────────────────
  if (callbacks.length > 0) {
    return build({
      ...shared,
      outcomeType: "callback_requested",
      succeeded: false,
      primaryReason: "callback_requested",
      confidence: "medium",
      explanation: `The person asked to be contacted at another time ("${callbacks[0]?.phrase}").`,
    });
  }

  // ── 6. A no that nothing positive followed ──────────────────────
  const lastAffirmationPosition = affirmations.reduce(
    (latest, signal) => Math.max(latest, positionFor(signal)),
    -1,
  );
  if (negations.length > 0 && lastNegationPosition > lastAffirmationPosition) {
    return build({
      ...shared,
      outcomeType: "declined",
      succeeded: false,
      primaryReason: "explicit_no",
      confidence: "high",
      explanation: `The person declined ("${negations[negations.length - 1]?.phrase}") and said nothing positive after it.`,
    });
  }

  // ── 6b. A yes at the gate that was then taken back ──────────────
  // Rule 4 already refuses to call this a registration. Without this
  // rule it would fall through to "positive but not at the gate" and be
  // filed as UNRESOLVED — a person who said "actually no" after
  // confirming would stay in the retry queue and be called again.
  //
  // Rule 6 catches most retractions on position alone and runs first,
  // so every label it already produced is unchanged. It cannot catch
  // the two that matter here: a retraction carrying no negation phrase
  // ("I changed my mind. Please do not reserve it."), and one whose own
  // words end on an affirmation token ("Actually nahi, cancel kar
  // dijiye" — "kar dijiye" sits after "nahi" in the same turn, so the
  // last affirmation outranks the last negation).
  //
  // Narrow by construction: it fires only when an at-gate affirmation
  // was recorded BEFORE the retraction, so a call that never reached
  // the gate can never reach this branch.
  const retractedGateYes = affirmations.find(
    (signal) => signal.atGate && positionFor(signal) < lastRetractionPosition,
  );
  if (retractedGateYes) {
    return build({
      ...shared,
      outcomeType: "declined",
      succeeded: false,
      primaryReason: "explicit_no",
      confidence: "high",
      explanation:
        `The person agreed ("${retractedGateYes.phrase}") at the question that commits them and then ` +
        `took it back, so this is a decision against rather than an unfinished conversation.`,
    });
  }

  // ── 7. Positive, but never at the gate ──────────────────────────
  if (affirmations.length > 0) {
    return build({
      ...shared,
      outcomeType: vocabulary.partial,
      succeeded: false,
      primaryReason: "affirmative_not_at_gate",
      confidence: affirmations.length > 1 ? "medium" : "low",
      explanation:
        "The person was positive but never agreed at the question that commits them, " +
        "so this is engagement rather than a confirmation." +
        questionSuffix(conversation),
    });
  }

  // ── 8. Nothing decisive. Say so. ────────────────────────────────
  return build({
    ...shared,
    outcomeType: "unclear",
    succeeded: null,
    primaryReason: "no_decisive_signal",
    confidence: "low",
    explanation:
      "The person spoke, but nothing in the conversation was decisive enough to call this a yes or a no." +
      questionSuffix(conversation),
  });
}

/**
 * The sentence that keeps a question-led call from reading as apathy.
 *
 * A person who asked four things and never got to a decision looks
 * identical to silence in a count of successes, and is the opposite of
 * it in reality. The label stays honestly unresolved either way — this
 * only makes the row say which kind of unresolved it was.
 */
function questionSuffix(conversation: ConversationEvents): string {
  const parts: string[] = [];
  if (conversation.customerQuestions > 0) {
    parts.push(
      `They asked ${conversation.customerQuestions} question(s) during the call, which is engagement ` +
        `rather than an answer either way.`,
    );
  }
  if (conversation.objections > 0) {
    parts.push(`They raised ${conversation.objections} objection(s) or hesitation(s).`);
  }
  if (conversation.endedOnCustomerQuestion) {
    parts.push(
      `The call ended while they were still asking, so this conversation was interrupted rather than ` +
        `concluded.`,
    );
  }
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/**
 * What the customer turn was answering, as far as the look-back can
 * tell:
 *
 *   ANCHOR             the question that commits them — the gate.
 *   OTHER_QUESTION     a different question the agent asked.
 *   STATEMENT_OR_NONE  volunteered: the agent had made a statement, or
 *                      had not spoken at all.
 *
 * This used to be a boolean, and the last two cases were both `false`.
 * They mean different things to the retraction rule — see
 * `retractsTheGate` — and nothing else about the look-back changed:
 * `ANCHOR` is returned exactly where `true` was returned before, so
 * `atGate` is identical for every transcript.
 */
type CommitQuestionContext = "ANCHOR" | "OTHER_QUESTION" | "STATEMENT_OR_NONE";

/**
 * The same look-back, read for its two different purposes.
 *
 * `answering` is what the walk has always returned and is the ONLY
 * thing `atGate` is derived from, so every transcript produces exactly
 * the `atGate` it produced before this split existed.
 *
 * `retraction` is the context the confirmation binding uses, and
 * differs from `answering` in one case: the walk stepped over an
 * assistant acknowledgement — "Understood.", "Got it." — before it
 * found the question. An acknowledgement is the agent CLOSING a
 * response; whatever the person says next starts a new exchange and is
 * no longer an answer to the question two exchanges back:
 *
 *   Agent:    "...should I reserve your free seat?"
 *   Customer: "Yes, reserve it."
 *   Agent:    "Email bhi bhej du?"
 *   Customer: "No need."
 *   Agent:    "Understood."
 *   Customer: "Actually, cancel it."
 *
 * The walk skipped "Understood." as filler, reached the email question
 * and called the cancellation an answer to THAT, so the registration
 * survived a caller who had just cancelled it. Only the retraction
 * reading is bounded: `answering` still returns `OTHER_QUESTION` there,
 * and `isBareAcknowledgement` itself is untouched — it is the
 * pipeline's backchannel predicate and several live paths read it.
 */
interface CommitContexts {
  readonly answering: CommitQuestionContext;
  readonly retraction: CommitQuestionContext;
}

/**
 * Whether a customer turn is answering a question that commits them.
 *
 * Looks back to the nearest assistant turn, and one further ONLY if the
 * nearest is a bare filler such as "sure" or "right" — a person who
 * answers a beat late is still answering the question that was asked.
 *
 * The look-back STOPS at any other question the agent asked. That is
 * the fix for the most expensive false positive available here:
 *
 *   Agent:    "...should I reserve your free seat?"
 *   Agent:    "The event is completely free. Is that okay?"
 *   Customer: "Yes."
 *
 * The yes belongs to "is that okay", which commits to nothing. Walking
 * past it to the seat question turns a courtesy into a registration and
 * closes the contact for good, so a non-anchor question ends the search
 * rather than being skipped as filler.
 *
 * It also STOPS at any assistant statement that says something, however
 * short. "Filler" used to mean "under 40 characters", and that let this
 * through:
 *
 *   Agent:    "...should I reserve your free seat?"
 *   Customer: "Is it free?"
 *   Agent:    "Yes, it's completely free."
 *   Customer: "Okay."
 *
 * The okay acknowledges the answer they just got; it is not a
 * registration, and a 27-character reply is not a filler. Length is
 * not the test — whether the turn is nothing but acknowledgement is,
 * and `isBareAcknowledgement` is the predicate the pipeline already
 * uses for exactly that judgement on the caller's side. The same table
 * decides both, so an assistant "Sure." is still skipped and an
 * assistant sentence never is.
 */
function commitQuestionContext(
  transcript: readonly TranscriptTurn[],
  customerTurnIndex: number,
  anchors: readonly string[],
): CommitContexts {
  const both = (context: CommitQuestionContext): CommitContexts => ({
    answering: context,
    retraction: context,
  });
  if (anchors.length === 0) return both("STATEMENT_OR_NONE");
  let checked = 0;
  /** The walk has stepped over an assistant acknowledgement. */
  let crossedAcknowledgement = false;
  /**
   * ...and over the customer turn that acknowledgement was answering.
   * BOTH halves are required. An acknowledgement is a boundary because
   * it closes an exchange, and an exchange is only closed once somebody
   * answered: an agent turn that asks and then acknowledges with
   * nothing said in between ("Should I send the SMS?" / "Sure.") has
   * acknowledged nothing, and the person is still answering the
   * question.
   */
  let closedExchange = false;
  for (let index = customerTurnIndex - 1; index >= 0 && checked < 2; index -= 1) {
    const turn = transcript[index];
    if (!turn || turn.text.trim().length === 0) continue;
    if (turn.role !== "assistant") {
      if (crossedAcknowledgement) closedExchange = true;
      continue;
    }
    const text = normalise(turn.text);
    // The script's own wording, or a paraphrase of it. The literal
    // anchors are tried first and unconditionally, so this only ever
    // adds a gate the table missed — see `isParaphrasedGate`.
    if (findPhrases(text, anchors).length > 0 || isParaphrasedGate(turn.text, text)) {
      return both("ANCHOR");
    }
    // The agent asked something else. The person is answering THAT —
    // unless the agent has since acknowledged their answer to it, which
    // closed that exchange. See `CommitContexts`.
    if (isQuestionTurn(turn.text)) {
      return {
        answering: "OTHER_QUESTION",
        retraction: closedExchange ? "STATEMENT_OR_NONE" : "OTHER_QUESTION",
      };
    }
    checked += 1;
    // An assistant turn with content of its own, and no anchor, ends the
    // look-back: the person is answering that, not something earlier.
    // Only a bare acknowledgement is stepped over.
    if (!isBareAcknowledgement(turn.text)) break;
    crossedAcknowledgement = true;
  }
  return both("STATEMENT_OR_NONE");
}

/**
 * May a negation in this turn TAKE BACK a registration already given at
 * the gate?
 *
 * The rule this replaces was positional and nothing else: the latest
 * negation anywhere in the call had to sit before the gate yes, so any
 * "no" said afterwards — to any question, on any subject — erased the
 * registration. A confirmed person who then answered
 *
 *   Agent:    "Have you attended one of our workshops before?"
 *   Customer: "No."
 *
 * was classified `declined`, closed as FINAL_NO, and never reached the
 * registrations sheet. The same held for "Nahi, WhatsApp theek hai" to
 * an offer to email the details: a preference about delivery, read as a
 * refusal of the event.
 *
 * So a later "no" is now only allowed to overturn the gate when it is
 * one of the two things that actually mean the person changed their
 * mind:
 *
 *   1. It answers the commitment question itself (`ANCHOR`). The agent
 *      re-asking the gate and hearing "no" is a retraction whatever
 *      words it is phrased in, which is what keeps a bare "No." at the
 *      gate a refusal.
 *
 *   2. It states a refusal that cannot mean anything else — the same
 *      `hasExplicitRefusal` table the live hangup check already uses to
 *      decide whether a mid-call "no" is final ("not interested",
 *      "cancel it", "leave it", "mujhe nahi chahiye") — AND it was not
 *      answering some other question the agent asked.
 *
 * That last clause is what the first version of this rule was missing.
 * `hasExplicitRefusal` reads one turn's words and knows nothing about
 * what was asked, so on its own it re-created the original bug one
 * vocabulary item further along:
 *
 *   Agent:    "Should I send you a reminder SMS as well?"
 *   Customer: "No need, WhatsApp is fine."
 *
 * "no need" is in the refusal table, so a registered person declining a
 * text message was classified `declined` and closed as FINAL_NO. The
 * same held for "No, I do not want that" to a newsletter offer and
 * "Nahi, mujhe email nahi chahiye" to an offer to email the details.
 * None of those is about the event. The refusal vocabulary is
 * deliberately context-free and is shared with `call-runner.ts`, so the
 * binding belongs here, at the point of use: a refusal that is ANSWERING
 * a different question is a refusal of that question.
 *
 * A refusal volunteered after a statement still retracts, which is the
 * shape every genuine retraction takes — the agent confirms the seat,
 * and the person says "actually, cancel it".
 *
 * `hasExplicitRefusal` was the ONLY signal here, and that was too
 * narrow in the other direction. It is a shared, deliberately
 * context-free table, and a decisive registration retraction routinely
 * misses it entirely:
 *
 *   Agent:    "Great, I'll reserve that for you."
 *   Customer: "Actually no."
 *
 * "actually no" is not a refusal phrase, so a person who had just
 * cancelled stayed `registered_confirmed` and reached the sheet. So do
 * "No, do not reserve it", "No, forget it", "Ab nahi karna hai" and
 * "Main nahi aaunga" — every one of them a plain, decisive no that the
 * refusal vocabulary was never built to carry.
 *
 * The negation table is what carries those, and the classifier already
 * reads it, already strips "no problem" from it, and already knows
 * through `answerReadability` whether this turn may be read as an
 * answer at all — `retractsTheGate` is only consulted when
 * `negationDecisive` is true. `hasDecisiveNegation` is that existing
 * reading handed in, not a second parser: it is `findPhrases(...,
 * NEGATIONS)` on the same turn, from the same line that records the
 * negation signals.
 *
 * Crucially this widens only the STATEMENT_OR_NONE branch. Fix #2's
 * whole point was that `OTHER_QUESTION` returns false BEFORE any
 * vocabulary is consulted, so "No.", "Nahi, WhatsApp theek hai" and
 * "No, I do not want that" answering an unrelated question still leave
 * the registration standing. The old "any later negation invalidates
 * the gate" behaviour is not reachable from here.
 *
 * `GATE_RETRACTIONS` covers the last gap: retractions that carry no
 * negation token at all. See that table for why it is not a vocabulary
 * fix to either shared list.
 *
 * Deliberately NOT solved here: "No thanks, that is all." said as a
 * courtesy sign-off after a confirmed registration follows a statement,
 * matches `hasExplicitRefusal`, and therefore still retracts. That is
 * the separate courtesy-sign-off question, and narrowing the refusal
 * table would change the live FINAL_NO hangup in `call-runner.ts` too.
 *
 * This can only ever PRESERVE a gate yes that the rules already found.
 * It widens nothing: a turn with no gate affirmation before it reaches
 * rule 6 on the unchanged `lastNegationPosition`.
 */
function retractsTheGate(
  normalisedTurn: string,
  context: CommitQuestionContext,
  hasDecisiveNegation: boolean,
): boolean {
  // Nothing is taken back by a turn that does not say no. This used to
  // be implicit rather than stated: the ANCHOR branch returned `true`
  // for every answer, and the only thing that made "Yes, reserve it."
  // harmless there was that the retraction's POSITION was read off a
  // negation signal the turn did not have. The position is now recorded
  // per turn, so the condition has to be where it belongs.
  const saysNo =
    hasDecisiveNegation ||
    hasExplicitRefusal(normalisedTurn) ||
    findPhrases(normalisedTurn, GATE_RETRACTIONS).length > 0;
  if (!saysNo) return false;
  if (context === "ANCHOR") return true;
  if (context === "OTHER_QUESTION") return false;
  return true;
}

/**
 * Where in a retraction turn the retraction happened, as an offset into
 * the normalised text.
 *
 * Turns that carry negation phrases keep the position they had when
 * `lastRetractionPosition` was computed from the negation signals
 * themselves — the last of them — so no transcript that already
 * retracted changes the turn-internal ordering it retracted at. That
 * ordering is load-bearing: a gate affirmation LATER in the same turn
 * than the negation ("No — actually yes, reserve it") still outranks
 * it, exactly as before.
 *
 * The fallbacks are for the retractions that carry no negation phrase:
 * the first retraction phrase if there is one, and otherwise the start
 * of the turn, which is the only honest answer for a turn whose
 * retraction is an explicit refusal the classifier matched without
 * recording an offset.
 */
function retractionOffset(
  normalisedTurn: string,
  negationHits: readonly { phrase: string; offset: number }[],
): number {
  if (negationHits.length > 0) {
    return negationHits.reduce((latest, hit) => Math.max(latest, hit.offset), 0);
  }
  const retractionHits = findPhrases(normalisedTurn, GATE_RETRACTIONS);
  if (retractionHits.length > 0) {
    return retractionHits.reduce((earliest, hit) => Math.min(earliest, hit.offset), Infinity);
  }
  return 0;
}

function notConnectedReason(input: ClassifyOutcomeInput): PrimaryReason {
  if (input.failureReason?.includes("CAMPAIGN_DIALING_ENABLED")) return "dialing_disabled";
  switch (input.status) {
    case "NO_ANSWER":
      return "no_answer";
    case "BUSY":
      return "busy";
    case "CANCELLED":
      return "cancelled";
    default:
      return input.failureClass === "SYSTEM" ? "system_error" : "failed";
  }
}

function build(input: {
  outcomeType: OutcomeClassification["outcomeType"];
  succeeded: boolean | null;
  primaryReason: PrimaryReason;
  confidence: OutcomeConfidence;
  campaignType: string;
  customerTurns: number;
  assistantTurns: number;
  signals: readonly OutcomeSignal[];
  explanation: string;
  suspectedVoicemail?: boolean;
  conversation?: ConversationEvents;
  adherence?: ScriptAdherenceReport;
}): OutcomeClassification {
  return {
    outcomeType: input.outcomeType,
    succeeded: input.succeeded,
    primaryReason: input.primaryReason,
    classifier: RULES_CLASSIFIER_ID,
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    detail: {
      confidence: input.confidence,
      campaignType: input.campaignType,
      customerTurns: input.customerTurns,
      assistantTurns: input.assistantTurns,
      signals: input.signals,
      explanation: input.explanation,
      ...(input.suspectedVoicemail ? { suspectedVoicemail: true } : {}),
      ...(input.conversation ? { conversation: input.conversation } : {}),
      ...(input.adherence ? { adherence: input.adherence } : {}),
    },
  };
}
