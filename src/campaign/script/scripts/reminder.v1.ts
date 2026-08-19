/**
 * reminder.v1.ts
 *
 * REMINDER CALL — TEAM FLEXIFUNNELS.
 *
 * Installed verbatim from the supplied document (the one that opens
 * "You had registered for our Funnel Builder Agent LIVE event, so I'm
 * just calling to make sure you don't miss it"). Both supplied files
 * were named "Registration script"; this is the reminder call by
 * content — it addresses someone who has already registered.
 *
 * Nothing is paraphrased, shortened, reordered or added. The only
 * change to the text is the two placeholder substitutions:
 *
 *   [Name]       ->  {{customer_name}}
 *   [Your Name]  ->  {{agent_name}}
 *
 * Do not edit this text. Editing changes the content hash, which is
 * pinned to every campaign that has already run it — publish a new
 * version instead.
 */

import type { CampaignScript } from "../script-types";

const SCRIPT_BODY = `Hi {{customer_name}}, {{agent_name}} from Team FlexiFunnels.

You had registered for our Funnel Builder Agent LIVE event, so I'm just calling to make sure you don't miss it.

Your session is today at 7:30 pm

And I specifically wanted to remind you because this isn't a normal webinar.

You'll actually see the Agent building a complete online business LIVE—just from commands.

Funnel, pages, product, course, checkout, emails and more.

And remember, the ₹1,50,000+ attendee bonus bundle is for live attendees, along with the live Q&A and surprise reveal.

So, {{customer_name}}, I've marked you as registered—will you be joining us live?

[YES]

Excellent.

I'll send the joining link to your WhatsApp again.

Please join 5–10 minutes early. See you inside!`;

export const REMINDER_V1: CampaignScript = {
  id: "reminder",
  version: "v1",
  campaignType: "reminder",
  label: "Reminder v1",

  systemPromptAppendix: [
    "# THIS CALL",
    "",
    "You are {{agent_name}} from Team FlexiFunnels, calling {{customer_name}}, who has",
    "already registered for the event.",
    "",
    "Below is the approved script for this call. Follow its flow, its question and its",
    "confirmation. The bracketed [YES] marker shows where the script continues once the",
    "person agrees — it is a branch label, never spoken.",
    "",
    "Everything above about how to speak still applies: this is a live phone conversation,",
    "so deliver it a few sentences at a time and let them answer. If they cannot attend, are",
    "busy, or ask something, respond to what they actually said rather than continuing down",
    "the script.",
    "",
    "--- SCRIPT ---",
    "",
    SCRIPT_BODY,
  ].join("\n"),

  openingLineTemplate: "Hi {{customer_name}}, {{agent_name}} from Team FlexiFunnels.",

  requiresName: true,
  isPlaceholder: false,
};
