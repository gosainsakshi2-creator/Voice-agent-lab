/**
 * registration.v2.ts
 *
 * REGISTRATION CALL — TEAM FLEXIFUNNELS, approved revision 2.
 *
 * A NEW immutable version, not an edit of `registration v1`. v1 stays
 * exactly as it was so every campaign already pinned to its hash keeps
 * validating; this file carries the newly approved wording.
 *
 * What changed from v1: the "am I speaking with" confirmation line is
 * gone (the call now opens directly with the greeting), and the branch
 * label reads [If YES]. Installed verbatim from the supplied text; the
 * only substitutions are the campaign layer's two placeholders:
 *
 *   [Name]       ->  {{customer_name}}   (from contacts.name, via CSV)
 *   [Your Name]  ->  {{agent_name}}      (from the assigned provider's voice)
 *
 * Do not edit this text. Editing changes the content hash, which is
 * pinned to every campaign that has already run it — publish a new
 * version instead.
 */

import type { CampaignScript } from "../script-types";

const SCRIPT_BODY = `REGISTRATION CALL — TEAM FLEXIFUNNELS

Caller:
Hi {{customer_name}}, this is {{agent_name}} calling from the FlexiFunnels team.

Actually, I’m calling to invite you to a special LIVE session with Saurabh Sir happening TODAY at 7:30 PM.

In this session, Saurabh Sir is going to reveal FlexiFunnels’ new Funnel Builder Agent — an AI-powered agent that can help you build funnels, create pages, and set up different things for your online business simply by giving it commands.

Yes, you just tell the AI what you want to build, and it helps build it for you.

And the best part is, Saurabh Sir will give you a LIVE demo and show you exactly how the Funnel Builder Agent works in real-time.

It’s a FREE LIVE session, and LIVE attendees will also get ₹1.5 lakh+ worth of exclusive bonuses.

So, would you like me to register you for this special LIVE session?

[If YES]

Awesome! I’ve registered you for the session.

You’ll receive the joining link on your Email and on WhatsApp within 10 min.

Please make sure to join TODAY at 7:30 PM, preferably 5 minutes before the session, so you don’t miss the LIVE demo and the special bonuses.

Alright? Thank you so much! See you today at 7:30 PM.`;

export const REGISTRATION_V2: CampaignScript = {
  id: "registration",
  version: "v2",
  campaignType: "registration",
  label: "Registration v2 (full)",

  systemPromptAppendix: [
    "# THIS CALL",
    "",
    "You are {{agent_name}} from Team FlexiFunnels, calling {{customer_name}}.",
    "",
    "Below is the approved script for this call. Follow its flow, its questions and its",
    "confirmations. The bracketed [If YES] marker shows where the script continues once the",
    "person agrees — it is a branch label, never spoken.",
    "",
    "Everything above about how to speak still applies: this is a live phone conversation,",
    "so deliver it a few sentences at a time and let them answer. If they say no, are busy,",
    "or object, respond to what they actually said rather than continuing down the script.",
    "",
    "--- SCRIPT ---",
    "",
    SCRIPT_BODY,
  ].join("\n"),

  openingLineTemplate: "Hi {{customer_name}}, this is {{agent_name}} calling from the FlexiFunnels team.",

  requiresName: true,
  isPlaceholder: false,
};
