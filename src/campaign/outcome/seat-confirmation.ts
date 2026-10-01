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
