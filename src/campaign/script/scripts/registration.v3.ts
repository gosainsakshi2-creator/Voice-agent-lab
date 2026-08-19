/**
 * registration.v3.ts
 *
 * REGISTRATION CALL — TEAM FLEXIFUNNELS, approved revision 3.
 *
 * A NEW immutable version, not an edit of `registration v2`. v1 and v2
 * stay byte-identical so every campaign already pinned to their hashes
 * keeps validating; this file carries the newly approved wording.
 *
 * What changed from v2: the pitch is now Flexi Genie (build and
 * automate an online business by chatting with AI) rather than a
 * session hosted by a named speaker, the branch label reads [YES], and
 * the bonus is stated as an attendee-only bundle. Installed verbatim
 * from the supplied text; the only substitutions are the campaign
 * layer's two placeholders:
 *
 *   [Name]       ->  {{customer_name}}   (from contacts.name, via CSV)
 *   [Your Name]  ->  {{agent_name}}      (from the assigned provider's voice)
 *
 * HOW THE APPENDIX DIFFERS FROM v2, AND WHY
 *
 * v2's appendix told the model to "deliver it a few sentences at a time
 * and let them answer". On a live call that instruction is read exactly
 * as written: the model emitted one or two sentences and ENDED ITS
 * TURN, and `ConversationPipeline` then waits for the caller before
 * anything further is spoken. Delivering this pitch therefore took five
 * or six separate turns, and between them the caller heard a full
 * round trip of dead air (turn-detection window, then generation, then
 * synthesis) in the middle of what should be one continuous sentence
 * or paragraph. Measured on gpt-5.1 against the v2 prompt stack:
 * 213-286 character replies, two sentences each.
 *
 * The appendix below asks for the opposite: the script's own paragraph
 * blocks are the unit of one turn, spoken through to the end. It adds
 * no words, changes no wording and moves no step — it only stops the
 * approved text from being chopped into micro-turns.
 *
 * Do not edit this text. Editing changes the content hash, which is
 * pinned to every campaign that has already run it — publish a new
 * version instead.
 */

import type { CampaignScript } from "../script-types";

const SCRIPT_BODY = `Hi {{customer_name}}, this is {{agent_name}} from Team FlexiFunnels.

Actually, I'm calling you with a very interesting invitation.

We have created Flexi Genie, which helps you build and automate your online business just by chatting with AI.

You can build your website, funnel, product, course, payment collection, lead generation and even automate your business—just by chatting with AI.

No need to learn any tool any more.

You simply tell the AI what you want… and the Agent does the work.

We're doing a LIVE demo of this Funnel Builder Agent today at 7:30 pm, where you'll actually see it building things live.

Would you be interested to attend?

The registration is completely FREE.

[YES]

Perfect!

I'll get your registration done and send the details to you on WhatsApp and email within 10 mins.

One important thing: All the live attendees will also get access to an attendee-only bonus bundle worth ₹1,50,000+, along with a live Q&A and a surprise reveal.

See you today!`;

export const REGISTRATION_V3: CampaignScript = {
  id: "registration",
  version: "v3",
  campaignType: "registration",
  label: "Registration v3 (Flexi Genie)",

  systemPromptAppendix: [
    "# THIS CALL",
    "",
    "You are {{agent_name}} from Team FlexiFunnels, calling {{customer_name}}.",
    "",
    "Below is the approved script for this call. Follow its flow, its questions and its",
    "confirmations. The bracketed [YES] marker shows where the script continues once the",
    "person agrees — it is a branch label, never spoken.",
    "",
    "Everything above about how to speak still applies. One thing about this particular",
    "call decides how it sounds: the script is written in blocks, and a block is what you",
    "say in one turn. Start a block and speak it through to its end in a single flowing",
    "reply, the way a person reads a sentence they mean. Do not stop after one sentence to",
    "see whether they are still there, and do not hand a block back to them a piece at a",
    "time — the line simply goes quiet while you wait, and they hear the call break.",
    "",
    "The block ending in a question is where you stop and let them answer. Those are the",
    "genuine handover points, and they are the only ones.",
    "",
    "If they say no, are busy, or object, respond to what they actually said rather than",
    "continuing down the script.",
    "",
    "--- SCRIPT ---",
    "",
    SCRIPT_BODY,
  ].join("\n"),

  openingLineTemplate: "Hi {{customer_name}}, this is {{agent_name}} from Team FlexiFunnels.",

  requiresName: true,
  isPlaceholder: false,
};
