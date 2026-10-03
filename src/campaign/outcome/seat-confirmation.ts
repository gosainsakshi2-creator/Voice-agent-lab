/**
 * seat-confirmation.ts
 *
 * The agent telling the caller their seat IS reserved ("your free seat is
 * reserved", "आपकी free seat … reserve हो गयी है"). One definition, read by
 * the pipeline (the fixed goodbye waits for one — `seatConfirmationOwed`)
 * and by the classifier (a weak "okay" at the seat question registers only
 * once the agent has confirmed the seat on it — `WEAK_AFFIRMATIONS`).
 */
export const SEAT_CONFIRMED =
  /\breserved\b|\bregistered\b|reserve\s+(?:हो|ho)\s+(?:गयी|गई|gayi|gai)|(?:reserve|register)\s+kar\s+(?:di|diya|dee)|(?:reserve|register)\s+कर\s+(?:दी|दिया)|रिज़र्व\s+हो|\bbooked\b|seat\s+(?:is\s+)?confirmed|you'?re\s+all\s+set|(?:पक्की|pakki)\s+(?:हो|ho)/iu;

/**
 * The agent saying, in a statement, that it is NOT reserving the seat:
 * "I'll skip reserving the seat for now", "I won't reserve it", "seat
 * reserve नहीं करता". Real call 7f3df5c1 (2026-10-03): "if I get some
 * time, I will surely join… otherwise we can skip it for now" read "I
 * will" as a yes at the gate, while the agent — which heard the whole
 * thing — answered "I'll skip reserving the seat for now". The agent's
 * own statement outranks a keyword. Never matches the seat QUESTION,
 * which carries no negation.
 */
export const SEAT_NOT_RESERVED =
  /\bskip(?:ping)?\s+(?:the\s+)?(?:reserv|book)|\b(?:won'?t|will\s+not|not\s+going\s+to)\s+(?:go\s+ahead\s+and\s+)?(?:reserve|book)|\bnot\s+reserv(?:e|ing)\b|(?:reserve|book)\s+(?:नहीं|nahi|nahin)\s+(?:कर|kar)/iu;
