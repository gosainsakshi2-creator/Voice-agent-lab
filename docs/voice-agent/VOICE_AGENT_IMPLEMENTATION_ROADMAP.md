# VOICE AGENT IMPLEMENTATION ROADMAP

*Campaign Calling • Conversation Reliability • Registration • Latency • Voice Quality*

**Purpose:** a living roadmap for implementing and validating the improvements identified from the Voice AI deep-dive, real call transcripts, current-code audits, and the existing Voice Agent architecture. This document is intentionally phased so changes can be made one at a time without breaking already-working call behavior.

---

## 1. Guiding Rules

- **Audit before changing:** trace the actual runtime path before implementing a fix.
- **Smallest safe change:** modify only the layer responsible for the identified problem.
- **Preserve working behavior:** call lifecycle, UI, turn detection, barge-in, interruption recovery, TTS/STT, silence recovery, backchanneling, self-echo protection, and existing regression fixes must not be broken.
- **One major change at a time:** test after every isolated change before moving forward.
- **Use real-call evidence:** transcripts, recordings, logs, and metrics should drive prioritization.
- **Regression first:** maintain a good/bad call dataset and run existing tests before live validation.
- **Do not optimize blindly:** provider/model changes must be benchmarked against the current production baseline.

---

## 2. Roadmap at a Glance

| Phase | Focus | Priority | Exit Goal |
| --- | --- | --- | --- |
| Phase 0 | Baseline, audit & test foundation | P0 | Known-good baseline + regression set |
| Phase 1 | Conversation correctness & turn-taking | P0 | Reliable natural interaction |
| Phase 2 | In-call registration & lead capture | P0/P1 | Confirmed leads captured during call |
| Phase 3 | Latency & model optimization | P1 | Lower caller-perceived response delay |
| Phase 4 | Voice quality & TTS/STT quality | P1 | More natural, accurate speech |
| Phase 5 | Response caching | P1 | Near-zero latency on fixed turns |
| Phase 6 | Observability & continuous QA | P1 | Repeatable release/monitoring process |

---

## 3. Phase 0 — Baseline, Audit & Test Foundation

**Goal:** establish a frozen baseline before making further changes.

- Document the current production call flow: Telephony → Media Stream → STT → Turn Detection → LLM → TTS → Audio.
- Keep the current system prompt and campaign prompt as the source-of-truth versions.
- Audit the existing registration/Google Sheets path and preserve the finding: current Sheets API write is post-call.
- Create a good-call and bad-call transcript dataset from real calls.
- Tag examples for: true interruption, backchannel, missed short answer, hearing check, language switch, long monologue, pronunciation issue, FAQ/edge case, and registration confirmation.
- Record a baseline for latency, outcome quality, interruption behavior, and registration conversion.

**Exit criteria:** baseline behavior is reproducible and regression cases are recorded.

---

## 4. Phase 1 — Conversation Correctness & Turn-Taking

**Goal:** make the agent reliably understand what the caller means without unnecessary interruption.

### 4.1 Backchannel vs. Real User Turn

- Treat backchanneling as a policy/classification problem, not only a keyword list.
- Use agent turn state/context: explanation vs. question vs. awaiting confirmation/value/open response.
- A short "yes/yeah/okay/haan" near the end of an agent question must remain eligible as a real answer.
- A short acknowledgement during an explanation should generally not cancel playback.
- Keep STT keyword boosting separate from the decision of whether the utterance is a backchannel.

### 4.2 Short Utterance / Hearing-Check Reliability

- Improve recognition of short high-frequency utterances such as yes, hello, okay, and haan.
- Evaluate Deepgram Nova-3 keyword boosting using only genuinely frequent terms.
- Preserve the existing hearing-check behavior for repeated greetings/"can you hear me?" cases.
- Avoid turning a single casual "hello" into an unnecessary hearing-check episode.

### 4.3 Language Lock

- Detect language from the first user utterance and establish the call language.
- Lock the language for subsequent turns where appropriate.
- Evaluate dynamic language detection for longer sales/support calls only after the simpler language-lock path is stable.

### 4.4 Long Monologues

- Break long webinar/sales explanations into smaller conversational blocks.
- Use a pitch → confirmation/interest question → continue pattern.
- Do not sacrifice required script content or natural flow.

### 4.5 FAQ & Campaign Edge Cases

- Add prompt coverage for already registered users, former members, duplicate phone numbers, and similar campaign-specific cases.
- Pre-filter campaign leads against backend state before launch where required.
- Explicitly ban unwanted closing phrases such as "good question" and "got it" where appropriate.

**Exit criteria:** regression cases pass and real calls show fewer false interruptions, missed confirmations, and conversational loops.

---

## 5. Phase 2 — In-Call Registration & Lead Capture

**Goal:** close the conversion gap by allowing a confirmed registration to be captured during the live call, similar to the human-agent benchmark.

**Current-state audit:** the existing Google Sheets API request occurs after hangup, during the post-call finalize path. The mid-call FINAL_YES probe only helps decide that the call can end; it does not write to Sheets.

- First audit exactly which lead fields are already available at the moment of confirmation.
- Define the canonical registration payload: name, phone, email, campaign/context, and any required metadata.
- Decide which fields come from the imported lead record versus what must be collected/confirmed live.
- Design the in-call write so a confirmed registration can be submitted immediately after the confirmation is accepted.
- Keep the live call resilient: Google Sheets failure must never break or delay the voice conversation.
- Use idempotency to prevent duplicate registration rows.
- After implementation, verify timing from logs: user confirmation timestamp → registration trigger → Sheets HTTP request timestamp → call end timestamp.
- Compare registration conversion before and after the change.

**Important:** this phase is a product-flow change, not merely a Sheets API timing change.

**Exit criteria:** confirmed registrations are reliably captured during the call, duplicates are controlled, and Sheets failures cannot disrupt calls.

---

## 6. Phase 3 — Latency & Model Optimization

**Goal:** reduce caller-perceived dead air without reintroducing previously reverted latency changes.

### 6.1 Establish Current Baseline

- Measure STT latency, LLM TTFT, TTS TTFA, residual/detector delay, and total response latency.
- Separate first-turn latency from later turns.
- Use p50/p90/p99 plus real-call examples rather than averages alone.

### 6.2 Evaluate LLM Alternatives

- Benchmark Gemma 4 against the current GPT-5.1 baseline.
- If Gemma is unsuitable, evaluate the recommended fallback and alternatives such as Qwen as appropriate.
- Compare TTFT and output quality across relevant endpoints/providers.
- Do not swap the production model solely because it is theoretically faster.

### 6.3 STT Optimization

- Evaluate keyword boosting for confirmation/high-frequency words.
- Evaluate Soniox as a benchmark candidate if required.
- Measure both recall improvement and false-trigger impact.

**Exit criteria:** a measured improvement is demonstrated without regression in conversation correctness.

---

## 7. Phase 4 — Voice Quality, Pronunciation & TTS/STT

**Goal:** make the voice sound natural, clear, correctly paced, and appropriate for Indian-language calls.

- Fix Indian-name pronunciation using target-language/Hindi transliteration or another controlled phonetic representation.
- Evaluate pronunciation dictionaries/phonetic handling where supported by the selected ElevenLabs model.
- Normalize dates, times, phone numbers, email addresses, and other complex TTS inputs.
- Tune speaking speed/pacing without making the voice sound artificial.
- Use punctuation/pauses carefully; test changes against the selected voice/model.
- Evaluate ElevenLabs as the primary TTS benchmark and compare Cartesia/Sarvam only with measured evidence.
- Investigate subtle ambient audio only after core speech clarity and latency are stable.

**Exit criteria:** pronunciation and pacing issues identified in real calls are materially reduced.

---

## 8. Phase 5 — Response Caching

**Goal:** remove unnecessary STT → LLM → TTS work from fixed-script turns.

- Start with the intro only as the first prototype.
- Identify fixed campaign turns that are identical or have a small controlled set of variants.
- Pre-generate audio for fixed turns.
- Keep STT active so user interruptions can still be detected.
- If interrupted, stop cached playback and pass the user transcript through the normal conversation path.
- Create language-specific cached variants where required.
- Keep dynamic/FAQ/off-script turns on the normal LLM + TTS pipeline.
- Measure latency and cost savings before expanding the cache.

**Exit criteria:** cached turns show materially lower response latency while interruption and transcript state remain correct.

---

## 9. Phase 6 — Observability, QA & Continuous Regression

**Goal:** turn call-quality debugging into a repeatable engineering process.

- Log user speech state, agent speech state, interruption candidate, decision, playback action, transcript outcome, and recovery result.
- Correlate events using a stable call ID/turn ID/trace ID.
- Track false interruption rate and missed interruption rate separately.
- Track resume/recovery success after interruptions.
- Track silence after interruption and repeated-user-speech rate.
- Track task/registration completion after interruption.
- Review a fixed sample of production interrupted calls after each release.
- Run the good/bad transcript dataset against every prompt or policy change before live deployment.

**Exit criteria:** every major voice behavior can be explained from logs and tested before deployment.

---

## 10. Recommended Execution Order

1. Freeze baseline and regression dataset.
2. Finish conversation correctness: backchannel/confirmation, short utterances, hearing checks, language lock, monologue and FAQ behavior.
3. Implement and validate in-call registration once conversation quality is stable.
4. Benchmark Gemma 4 and other LLM/STT candidates against the current baseline.
5. Apply targeted pronunciation, language, phrase-ban, and normalization fixes.
6. Prototype response caching with the intro only.
7. Expand caching only after interruption and state recovery are proven.
8. Strengthen observability and continuously add real bad-call cases to regression tests.

---

## 11. What We Should NOT Change Casually

- Do not reintroduce the previously reverted latency patches without a new audit and explicit decision.
- Do not replace the existing turn-detection/interruption architecture just to follow a provider recommendation.
- Do not change working UI, conversation history, bubble logic, call lifecycle, recording, playback, silence recovery, self-echo protection, or barge-in behavior while implementing unrelated fixes.
- Do not change multiple providers/models/settings at once; otherwise attribution becomes impossible.
- Do not treat recommendations from external guides as proof that the same implementation is required in this codebase.

---

## 12. Living Roadmap / Change Log

Use this section to append new feedback, discoveries, test results, and decisions. If something is discovered mid-implementation, add it here and place it into the appropriate phase rather than losing it.

| Date | New Finding / Request | Phase | Decision / Status |
| --- | --- | --- | --- |
| 2026-09-14 | Short-utterance loss is **not** an STT failure. No evidence of Deepgram dropping these words exists locally (no production log material in the repo), and Deepgram's own keyterm guidance warns against boosting "generic common words" — which is exactly what `yes`/`no`/`okay`/`hello` are. Meeting notes agree ("I would not solve it with keyword boosting alone"). The reproduced failures are all downstream, in `classifier.ts`. | 1.2 | **Keyword boosting NOT implemented.** Deferred pending real-call recall data (§D item 1). Confirms §B2 / §F.4 as the actual gap. |
| 2026-09-14 | `haanji` / `hanji` / `han` were absent from the classifier's `AFFIRMATIONS` while the pipeline's `ACKNOWLEDGEMENT_TOKENS` and `BARE_GREETING_ONLY` already carried them. Phrase matching is whole-word, so `" haanji "` matched neither `" haan "` nor `" ji "`. Gate → "Haanji." settled `unclear`: no `confirmed_at_gate`, no FINAL_YES, no sheet row, no auto-hangup. | 1.2 | **FIXED.** Spellings added to `AFFIRMATIONS` (and to `COURTESY_TOKENS`, so sign-off decomposition stays in step). Covered by `npm run test:short-utterance`. |
| 2026-09-14 | `ji` is an affirmation on its own and also sits inside `nahi ji`, the commonest polite Hinglish no. Rule 4 (yes at gate) runs before rule 6 (refusal) and short-circuits, so gate → "Nahi ji." settled `registered_confirmed` while "Ji nahi." correctly declined. A caller who refused was written to the registrations sheet and hung up on as FINAL_YES. | 1.2 | **FIXED** via `AFFIRMATION_EXCEPTIONS` (strips before affirmation matching only; negation matching untouched). |
| 2026-09-14 | **Found during adversarial audit:** the first fix was an incomplete cross-product. Hand-listing the romanized pairs left 8 of 12 `<no> × <ji>` combinations still settling `registered_confirmed` — every pair with a Devanagari honorific (`nahi जी`) and every pair with a Devanagari negation (`नहीं ji`, `नहीं जी`). Deepgram runs in `multi` mode, so both scripts and mixed script must be correct. | 1.2 | **FIXED.** The exception set is now generated as a cross-product rather than hand-listed, so a spelling added to either row is covered in both scripts. Regression test asserts all 24 combinations. |
| 2026-09-14 | §B2's other words — `achha`, `right`, `correct`, `hmm`, `samajh gaya` — are acknowledgements in the pipeline but were deliberately **not** promoted to gate affirmations. The pipeline's table answers "may the assistant keep talking?"; that is a far weaker question than "did this person agree to be registered?". Promoting "hmm" would write a sheet row on someone who consented to nothing. | 1.1 | **DEFERRED by decision.** Needs the policy/turn-state-conditioned backchannel work in §4.1, not a vocabulary merge. Boundary asserted from both sides in the regression suite. |
| 2026-09-14 | Residual gaps, all miss-direction (never a false registration): `हाँजी` (unspaced Devanagari) still settles `unclear` — not added because the pipeline does not carry it either, so adding it would break the alignment invariant in the other direction. Pre-existing and unrelated to spelling: a hedge plus a separate affirmation token still registers ("Haanji, dekhta hu.", and equally the English "Yes, I will see."). | 1.2 / later | **OPEN.** Both pinned as parity assertions so a future fix cannot fix one spelling only. Real-call validation of actual spelling distribution still outstanding (§D item 4). |
| 2026-09-14 | **Hearing-check loop, root cause.** Nothing counted the agent's own fixed hearing lines. Both `attentionAcknowledgementFor` and `hearingFollowUpFor` are questions, so the caller's answer to one is another presence check, which the same branches answer with another fixed line. Before a block: `hearingEpisodeBeforeBlock` re-acknowledged every repeated greeting, forever. After one: acknowledgement -> follow-up -> episode closed -> acknowledgement -> ... alternating, forever. Neither branch reached the model or the script, so no watchdog could see it as a stall. | 1.2 | **FIXED.** `MAX_HEARING_LINES_WITHOUT_PROGRESS = 2` plus `hearingLinesWithoutProgress`, incremented at the four sites that speak a fixed line and reset at every exit that does not. The third check takes the contextual path. Covered by `npm run test:hearing-loop` sections A/B/D. |
| 2026-09-14 | **Self-echo half of the same loop.** The fixed lines share vocabulary with `ATTENTION_PRESENCE_PHRASES`, so a fragment of our own line coming back up the inbound track is itself a presence check. "Can you hear" is three words — below `SELF_ECHO_MIN_WORDS`, which is a deliberate floor no short utterance may fall below — so the echo guard is not permitted to judge it, and the agent answered its own echo with no caller involved. | 1.2 | **FIXED by the same cap, and the echo guard was NOT touched** (§11 forbids it, and weakening it would suppress the genuine caller "Can you hear me?" instead). The bound is on the agent's contentless lines, which is the one thing both the caller-driven and echo-driven loops have in common. `test:hearing-loop` C1/C2. |
| 2026-09-14 | **Found during adversarial audit:** `haan ji` is in `BARE_GREETING_ONLY` (so `isCheck`) AND in `HEARING_CONFIRMATION_ONLY` (so `confirmsHearing`). The first design reset the counter on "the caller confirmed", which would have reset on an utterance the handler then answers with another acknowledgement — the same loop, one token longer. It also switches the call language, so the second acknowledgement is the Hindi form of the same line. | 1.2 | **AVOIDED.** The counter is reset by the BRANCH TAKEN, never by a predicate over the text, and the regression test counts all six language variants of the two lines. `test:hearing-loop` A4. |
| 2026-09-14 | Remaining in-scope gaps. (1) Past the cap a bare "Hello?" reaches the model, which is what FIX 2 exists to avoid — strictly better than pre-FIX-2 (every hello went there) and the model now sees two explicit hearing questions in the history, but it is a real tradeoff. (2) `startSpeculation` still declines to pre-open a request for a hearing check, so a capped check pays full LLM latency; latency only, and §11 requires a fresh audit. (3) The echo-vs-genuine "Can you hear me?" collision is unresolved at the lexical level and is bounded rather than decided. | 1.2 | **OPEN by decision.** (3) needs real-call echo evidence (§D item 7), not more vocabulary. |
| 2026-09-14 | **Language lock, root cause.** `detectLanguage` re-decides every turn *by design* ("the session switches languages freely turn to turn") and its result is written straight into `ConversationMemory.language` by `recordUserTurn`. That one field is read by the per-turn LLM hint, the TTS synthesis request, both fixed hearing lines, the silence-recovery prompt and the fallback greeting — so a single mis-read turn moves all six for the rest of the call. Nothing in the codebase held a call-level language. | 1.3 | **FIXED.** Write-once `ConversationMemory.lockLanguage`, taken at one site (`ConversationPipeline.commitTurnLanguage`) on the caller's first meaningful utterance. Until it is taken, behaviour is byte-identical to before. Covered by `npm run test:language-lock`. |
| 2026-09-14 | **No Deepgram request parameter changed.** The live socket already runs Nova-3 with `language: "multi"` — that IS the Nova-3 language identification the meeting notes asked for — and its observable output in this pipeline is the SCRIPT of the transcript, which `detectLanguage` already consumes at 0.85–0.9 confidence. Nova-3 also returns a per-word `language` tag in multi mode (`alternatives[].languages`, `words[].language` in the SDK types) which is currently discarded; plumbing it would mean changing `TranscriptSegment` and the turn detector, and §D item 4 lists its real-call behaviour on this account as unvalidated. | 1.3 | **NOT PLUMBED, by decision.** Smallest safe change per §1. Revisit with §D item 4 evidence. |
| 2026-09-14 | **"Meaningful" is four existing predicates, not a new one.** A turn locks only if: no attention episode is open and no script position is held (the two flags `startSpeculation` already declines on); `utteranceTakesNoFloor` is false (bare greeting / bare acknowledgement / pure presence check); it has at least `SELF_ECHO_MIN_WORDS` words; and the detection is lock-grade. The word floor is *derived from* the self-echo constant, so any utterance long enough to lock on is long enough for the echo guard to have judged it — a three-word fragment of our own reply can never fix the call's language. | 1.3 | **IMPLEMENTED.** Both sides of every clause asserted in `test:language-lock` sections D and E. |
| 2026-09-14 | **The English fall-through is not made permanent.** Audit §B5 records that ambiguous romanized Hindi can fall through to English. `isLockGradeEvidence` therefore refuses `default-english` when even ONE Hindi marker was found (below `HINGLISH_MARKER_RATIO` but not clean English), and refuses `neutral`/`empty`, which merely carry the previous language forward. A clean English fall-through over 4+ words with zero of ~150 Hindi function words IS accepted — it is the only positive evidence of English this detector can produce. | 1.3 | **IMPLEMENTED.** Refusing costs nothing: an unlocked turn behaves exactly as today and the next qualifying turn locks. `test:language-lock` A5/A6/D4. |
| 2026-09-14 | **Found during adversarial audit:** "Please speak in Hindi" is four clean English words with no Hindi marker in it, so every other rule scored it as lock-grade English — the caller asking for Hindi would have locked the call into English, permanently and unrecoverably (hint, synthesis language and every fixed line contradicting them for the rest of the call). Strictly worse than the per-turn behaviour it replaced, which recovered on the next turn. | 1.3 | **FIXED.** `LANGUAGE_NAME_WORDS` + `mentionsLanguage`: an utterance that NAMES a language is refused as lock evidence, so the request reaches the model with the call still unlocked and their next turn decides. Detection itself is untouched. `test:language-lock` A5b/D4b. |
| 2026-09-14 | **Found during adversarial audit (second defect, in the first fix):** the language-name scan split on `[^\p{L}]`, and Devanagari matras and the virama are COMBINING MARKS, not letters — so "अंग्रेज़ी" shattered into single consonants and every Devanagari language request still locked. Latin-script requests were refused correctly, which is exactly the kind of half-fix a Latin-only test would have passed. | 1.3 | **FIXED.** `[^\p{L}\p{N}\p{M}]` plus NFC normalization, the same class `normaliseForPhraseMatch` uses. The regression test asserts both scripts and both directions. |
| 2026-09-14 | **A mixed first utterance locks HINGLISH**, not one of the pure languages. Verified against the architecture before implementing rather than decided here: `SupportedLanguage.HINGLISH` is first-class, its prompt hint is "mirror their mix naturally", and `detectLanguage` already separates `mixed-script` Hindi from `mixed-script` Hinglish on `HINGLISH_LATIN_WORD_RATIO`. Collapsing a mixed opener onto Hindi or English would have been a new policy. | 1.3 | **NO NEW POLICY.** `test:language-lock` A3/C3. |
| 2026-09-14 | Remaining in-scope gaps. (1) The lock is absolute in code; a caller who later wants a different language is served only by the system prompt's existing "an explicit language request from the caller always wins", which the model applies from their words — pinned by `test:language-lock` A10, but it is a model behaviour, not a guarantee. (2) The two-flag refusal is broader than strictly necessary: a real contribution made while a hearing episode is open, or in the turn right after a stranded barge-in, defers the lock by one turn. Bounded (the declining turn clears both flags) and never produces a WRONG lock, but a caller who interrupts every block locks later than "first utterance" implies. (3) A self-echo that slips the guard after `spokenUtterances` is cleared could lock — but only to the language the agent was already speaking, so it cannot switch a call. (4) No env kill switch: the session core has no feature-flag precedent and one was not introduced. | 1.3 | **OPEN by decision.** (1) and (3) need real-call evidence (§D items 4 and 7). |
| 2026-09-14 | Dynamic mid-call language mirroring (the meeting note's "Facebook language-ID model in parallel" for long sales/support calls) remains explicitly out of scope until the simple lock is stable on real calls, per §4.3 bullet 3. | 1.3 / later | **DEFERRED as specified.** |

---

## 13. Definition of Done

- Conversation feels natural and does not unnecessarily interrupt users.
- Short confirmations and context-dependent backchannels are handled correctly.
- Language remains consistent with the call context.
- Confirmed registrations are captured reliably during the call once Phase 2 is implemented.
- Google Sheets integration is idempotent and cannot break live calling.
- Latency is benchmarked and improved based on measured evidence.
- Voice pronunciation, pacing, and normalization are stable.
- Fixed-script response caching, if deployed, preserves interruption and conversation state.
- Every significant change has regression coverage and real-call validation.

*This is a living roadmap — add new findings as they come up rather than losing them between phases.*

---
---

# CLAUDE CODE — READ-ONLY AUDIT

*Current Voice Agent Implementation Audit • 13 September 2026*

**Purpose.** This section records the findings from the read-only Claude Code audit performed against the current Voice Agent codebase. The audit was performed before making further fixes so that the reported problems could be separated into confirmed code gaps, already-addressed behavior, and items that require real-call validation.

**Audit safety.** The audit was explicitly read-only. No production code was modified, created, deleted, refactored, configured, or committed during the audit.

## A. Audit Status Summary

| Area | Status | Key Finding |
| --- | --- | --- |
| 1. Short utterances / STT | PARTIALLY ADDRESSED / VALIDATION NEEDED | Listening path is present; short-word recognition quality still needs real-call validation. While the agent is speaking, short utterances remain a known edge case. |
| 2. Backchannel vs real confirmation | CONFIRMED GAPS | Pipeline acknowledgement vocabulary and classifier affirmation vocabulary are not fully aligned. The last ~2.2–2.8s of playback is an important untested window. |
| 3. Language lock | CONFIRMED GAP | Ambiguous Latin/romanized Hindi can fall through to English; Deepgram multi-mode behavior needs real-call validation. |
| 4. FAQ / already registered / duplicates | CONFIRMED GAPS | No pre-dial suppression/cross-campaign identity handling; already-registered behavior is not comprehensively handled. Within-campaign duplicate prevention is already fixed. |
| 5. Long monologues / script flow | VALIDATION NEEDED | Current prompt supports natural block delivery, but actual block lengths and interruption behavior should be checked on real calls. |
| 6. Indian-name pronunciation | VALIDATION NEEDED | Controlled phonetic/transliteration handling is the proposed direction; pronunciation must be measured per selected voice. |
| 7. Phrase bans | CONFIRMED GAP | "got it" can still be generated/endorsed; "good question" is not fully banned. |
| 8. Hearing-check / hello loop | PARTIALLY ADDRESSED | Repeated-greeting handling exists, including buffered-turn attention handling, but there is no hearing-episode cap; caller-sustainable loops remain possible. |
| 9. Interruption / Plivo barge-in | CONFIRMED GAP | Plivo energy-only barge-in lacks the same STT-liveness corroboration used elsewhere. |
| 10. Self-echo | CONFIRMED EDGE CASE | Self-echo protection can suppress a genuine caller repetition such as "Can you hear me?" in some conditions. |
| 11. Confirmation binding | CONFIRMED HIGH-PRIORITY GAP | A later bare "No" can overwrite a prior gate YES; courtesy "Okay, thanks" after a NO can settle UNRESOLVED and trigger retry. Gate anchors are literal. |
| 12. Google Sheets registration | CONFIRMED GAP / PRODUCT FLOW PENDING | Current write is post-call; failed writes have no retry/operator surface. In-call registration is a future product-flow change. |
| 13. Latency | AUDIT ONLY | Previously reverted latency patches remain reverted. Current residual/STT behavior should be measured before any new optimization. |
| 14. Response caching | FUTURE WORK | No production cache should be introduced casually; intro-only caching is the proposed first prototype. |
| 15. TTS normalization / observability | PARTIALLY ADDRESSED | Numeric normalization exists; broader normalization and per-stage observability remain future work. |

## B. Detailed Confirmed Findings

### B1. Confirmation binding

- The classifier currently allows a later negation to influence FINAL_NO without requiring that the negation answer the registration gate.
- A concrete failure path exists where a confirmed gate YES is followed later by a bare "No", allowing the later response to overwrite the earlier result.
- A "No" followed by a courtesy "Okay, thanks" can settle as UNRESOLVED; the default unresolved retry policy can then redial the contact after 30 minutes.
- Gate anchors are matched by exact literal phrases, so an LLM paraphrase of the gate can silently lose FINAL_YES.
- Existing protections are present for immediately-preceding questions, agent-spoke-last checks, assistant-question protection, and bare acknowledgement handling; these should be preserved.

### B2. Backchannel / acknowledgement vocabulary

- The pipeline has acknowledgement handling, but the classifier's affirmation table is not fully aligned with pipeline acknowledgement vocabulary.
- Words/phrases such as "achha", "right", "correct", "hmm", and "samajh gaya" can behave as acknowledgements but are not consistently treated as affirmative gate answers.
- The 4000 ms backchannel timing rule is effectively unreachable on the production bridge because remaining speech is constrained to approximately 2800 ms, leaving the final playback window insufficiently covered by regression tests.

### B3. Already registered / duplicate contacts

- Within-campaign duplicate prevention is already implemented.
- The audit found no comprehensive pre-dial suppression for already-registered contacts and no cross-campaign/cross-phone identity model.
- Campaign-specific handling for already registered users and former members needs explicit coverage before launch.

### B4. Hearing-check and self-echo

- The repeated greeting / hearing-check behavior is already present and the buffered-turn attention path has been added.
- However, there is no explicit hearing-episode cap, so repeated caller prompts can still produce sustainable hearing-check loops.
- The self-echo guard may suppress a genuine caller utterance such as "Can you hear me?" depending on timing and acoustic conditions.

### B5. Language behavior

- The language detector can fall through to English on ambiguous Latin/romanized text.
- Deepgram multi-mode transcription may influence this behavior; the exact real-call transcription pattern must be validated before changing detection logic.
- The fallback Hindi greeting uses masculine self-reference even for female-voiced providers.

### B6. Phrase / prompt behavior

- "got it" can be produced by the speech formatter and is also endorsed by current prompt behavior.
- A complete "good question" ban is not currently enforced.
- These are narrow prompt/formatter changes and should not be mixed with turn-detection changes.

### B7. Plivo interruption handling

- Plivo's energy-based barge-in path does not currently have the same STT-liveness gate/corroboration protection.
- This is a real code gap and should be addressed independently from confirmation or language changes.

### B8. Google Sheets / registration

- The existing Google Sheets write occurs in the post-call finalize path.
- The live FINAL_YES probe helps determine whether the call can end but does not itself perform the Sheets write.
- In-call registration should therefore be treated as a product-flow change with idempotency and failure isolation, not merely as moving an existing HTTP request.

## C. Already Fixed / Protected According to the Audit

- Buffered repeated greeting attention handling and reuse of the existing barge-in path.
- heldScriptFull / heldScriptRemainder continuity for interrupted responses.
- Continue-versus-restart handling for interrupted script content.
- Interruption recovery and contextual barge-in behavior.
- Silence recovery remains in place.
- Substantive short assistant statements are no longer incorrectly excluded by the classifier length guard.
- Assistant turns containing a question mark are protected from being treated as closing answers.
- Bare acknowledgement handling is shared rather than duplicated.
- FINAL_YES live and post-call determination use the same underlying logic.
- Within-campaign phone duplicate prevention.
- Previously reverted latency patches remain reverted and should not be reintroduced casually.
- Numeric TTS normalization is already present.

## D. Requires Real-Call Validation

- Recognition rate of bare "haan" / "ji" under Deepgram multi-mode without keyword boosting.
- How often callers answer inside the final ~2.2–2.8 second playback window and whether the answer reaches the correct turn.
- Frequency of gate paraphrasing by the LLM and resulting anchor misses.
- Whether Deepgram multi-mode returns Devanagari or romanized Hindi in the affected calls.
- Current residual latency/STT lag after the reverted latency patches.
- Actual pitch-block lengths produced by the current campaign prompt.
- Speakerphone/self-echo behavior and Plivo false barge-ins.
- Indian-name pronunciation for each benchmarked TTS voice.

## E. Future Engineering Work Identified

- In-call registration with a canonical payload, idempotency, fire-and-forget Sheets write, and failure isolation.
- TTS audio caching for fixed campaign lines, starting with the intro only.
- Persistence of per-stage turn deltas and conversation events for debugging.
- Cross-campaign suppression / identity model.
- Absolute latency-budget tests and Plivo bridge parity tests.
- Retry and operator visibility for failed Sheets writes.
- Broader TTS normalization and controlled phonetic pronunciation handling.

## F. Recommended Priority from the Audit

1. Confirmation-binding classifier gaps — prevent later "No" from flipping an earlier gate YES, prevent courtesy acknowledgements from causing incorrect unresolved retries, and make gate recognition robust.
2. Already-registered / duplicate-contact suppression before dialing.
3. Validate the final ~2.2–2.8 second acknowledgement window and dead 4000 ms rule with real-call evidence before changing timing logic.
4. Align classifier affirmation vocabulary with pipeline acknowledgement vocabulary.
5. Add a hearing-check episode cap and resolve the self-echo collision without disturbing current attention behavior.
6. Validate and then address language fallthrough to English.
7. Address phrase bans, pronunciation, Sheets reliability, Plivo barge-in parity, and observability as isolated changes.

## G. Audit Decision / Change-Control Rule

**Decision:** The audit should be treated as the evidence baseline for the next implementation phase. Only one major fix should be implemented at a time. Every change must preserve the existing call lifecycle, UI, conversation history, turn detection, barge-in, interruption recovery, TTS/STT, silence recovery, backchanneling, self-echo protection, and existing regression fixes.

**Latency note:** Do not reintroduce the previously reverted latency patches solely because latency remains a known area. Any new latency work requires a fresh audit, measured evidence, and regression validation.
