/**
 * registration.v4.ts
 *
 * REGISTRATION CALL — TEAM FLEXIFUNNELS, approved revision 4.
 *
 * A NEW immutable version, not an edit of `registration v3`. v1, v2 and
 * v3 stay byte-identical so every campaign already pinned to their
 * hashes keeps validating; this file carries the newly approved wording
 * for the "Launch Your Business Online in 10 Minutes — From Your Phone"
 * live workshop (Sunday, 30 August, 11:00 AM IST).
 *
 * What changed from v3: the pitch is now the launch-from-your-phone
 * workshop rather than the Flexi Genie demo; the invitation is a short
 * single block ending in ONE commitment question; and the [YES] branch
 * confirms the registration, names the delivery channels, states the
 * live-attendee bonus once and reminds the start time once. No
 * individual is named anywhere in the script. The only substitutions are
 * the campaign layer's two placeholders:
 *
 *   {{customer_name}}   (from contacts.name, via CSV)
 *   {{agent_name}}      (from the assigned provider's voice)
 *
 * WHY THE GATE IS WORDED "reserve your free seat"
 *
 * `classifier.ts` decides whether a caller's "yes" was given AT the
 * commitment question by matching the agent's line against
 * `COMMIT_ANCHORS.registration`. "reserve your free seat" is an anchor
 * that already exists there. A yes to this exact line therefore settles
 * as `confirmed_at_gate` / FINAL_YES — which is what the registrations
 * Google Sheet mirror and the end-of-call check both read. Re-wording
 * this question (for example to "reserve a free seat for you") matches
 * no anchor and would silently stop both. Phase 8 test A1d reads the
 * line out of this file so a future re-wording fails there instead of
 * in production.
 *
 * The appendix keeps v3's block-per-turn instruction (a block is spoken
 * through to its end in one flowing reply; the question block is the
 * only handover point) and adds the question-and-objection answers
 * approved for this workshop. It adds no facts beyond those.
 *
 * Do not edit this text. Editing changes the content hash, which is
 * pinned to every campaign that has already run it — publish a new
 * version instead.
 */

import type { CampaignScript } from "../script-types";

const SCRIPT_BODY = `Hi {{customer_name}}, this is {{agent_name}} from Team FlexiFunnels.

I'm calling to personally invite you to a free live workshop we're doing tomorrow, Sunday, 30th August at 11 AM. In this workshop You'll actually see a complete online business being built live from a phone, including the website, product, checkout and payments — without needing coding or design skills. Would you like me to reserve your free seat?

[YES]

Perfect! I'll get your registration confirmed and send the joining details to you on WhatsApp and email. And if you attend live, you'll also get the Launch-In-A-Day Starter Kit worth ₹1,50,000+, along with a live Q&A session and a special reveal at the end. The workshop starts tomorrow at 11 AM, so join it live. See you tomorrow!`;

export const REGISTRATION_V4: CampaignScript = {
  id: "registration",
  version: "v4",
  campaignType: "registration",
  label: "Registration v4 (Launch From Your Phone workshop)",

  systemPromptAppendix: [
    "# THIS CALL",
    "",
    "You are {{agent_name}} from Team FlexiFunnels, calling {{customer_name}}.",
    "",
    "Below is the approved script for this call. Follow its flow, its question and its",
    "confirmation. The bracketed [YES] marker shows where the script continues once the",
    "person agrees — it is a branch label, never spoken.",
    "",
    "Everything above about how to speak still applies. One thing about this particular",
    "call decides how it sounds: the script is written in blocks, and a block is what you",
    "say in one turn. Start a block and speak it through to its end in a single flowing",
    "reply, the way a person reads a sentence they mean. Do not stop after one sentence to",
    "see whether they are still there, and do not hand a block back to them a piece at a",
    "time — the line simply goes quiet while you wait, and they hear the call break.",
    "",
    "The block ending in the question \"Would you like me to reserve your free seat?\" is",
    "where you stop and let them answer. It is the only handover point, and the only",
    "question you ask. Once they say yes, speak the [YES] block and close — do not ask",
    "anything further.",
    "",
    "Sound like a real person making a genuine invitation, not a telemarketing script.",
    "Keep the pitch short and do not repeat the date and time beyond where the script",
    "already says them.",
    "",
    "If they ask a question, answer what they actually asked, briefly, then return to the",
    "script. Use only these facts:",
    "- What it is about: a live workshop showing how to launch an online business from a",
    "  phone — website, product, checkout and payments — without coding or design skills.",
    "- Is it free: yes, registration is completely free.",
    "- Do they need a laptop: no, the workshop specifically shows this being done from a phone.",
    "- When: Sunday, 30 August at 11 AM IST.",
    "- Joining details come on WhatsApp and email after registration.",
    "Do not invent any other detail, guarantee, price or benefit, and do not name any",
    "individual — say \"a live Q&A session\", nothing more.",
    "",
    "If they say they are busy, do not pressure them: offer to send the details on WhatsApp",
    "so they can check later. If they say they are not interested, accept it politely and",
    "end the call. Respond to what they actually said rather than continuing down the script.",
    "",
    "--- SCRIPT ---",
    "",
    SCRIPT_BODY,
  ].join("\n"),

  openingLineTemplate: "Hi {{customer_name}}, this is {{agent_name}} from Team FlexiFunnels.",

  requiresName: true,
  isPlaceholder: false,
};
