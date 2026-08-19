/**
 * registration.v1.ts
 *
 * REGISTRATION CALL — TEAM FLEXIFUNNELS.
 *
 * The approved script, installed verbatim from the supplied document.
 * Nothing is paraphrased, shortened, reordered or added. The only
 * change to the text is the two placeholder substitutions the campaign
 * layer performs:
 *
 *   [Name]       ->  {{customer_name}}   (from contacts.name, via CSV)
 *   [Your Name]  ->  {{agent_name}}      (from the assigned provider's voice)
 *
 * The bracketed `[YES]` markers are the document's own branch labels
 * and are preserved as written.
 *
 * Do not edit this text. Editing changes the content hash, which is
 * pinned to every campaign that has already run it — publish a new
 * version instead.
 */

import type { CampaignScript } from "../script-types";

const SCRIPT_BODY = `REGISTRATION CALL — TEAM FLEXIFUNNELS

Caller:
Hi {{customer_name}}, this is {{agent_name}} from Team FlexiFunnels.

Actually, I'm calling you with a very interesting invitation.

What if I tell you that you can build your funnel, website, product, course and even automate parts of your business—just by chatting with AI?

No complicated builder. No learning dozens of tools.

You simply tell the AI what you want… and the Agent does the work.

We're doing a LIVE reveal of this Funnel Builder Agent, where you'll actually see it building things live.

Can I tell you in 20 seconds why I think you should attend?

[YES]

Great.

Normally, creating a funnel can involve designers, developers, copywriters, multiple tools and a lot of back-and-forth.

But in this event, you'll see the “Say it, it's done” workflow—where a complete online business can be built through a conversation with the Agent.

We'll demonstrate things like:

• Funnel
• Landing pages
• Products
• Checkout & payments
• Courses
• Emails
• Split tests

—all from simple commands.

And the best part is the registration is completely FREE.

So, {{customer_name}}, should I reserve your free seat for the live event?

[YES]

Perfect!

I'll get your registration done and send the details to you on WhatsApp.

One important thing: don't just register and forget about it.

The biggest reveal is happening LIVE, and the page says the live attendees also get access to an attendee-only bonus bundle worth ₹1,50,000+, along with a live Q&A and a surprise reveal.

Can I count on you to attend live?

[YES]

Perfect. I'll mark you as confirmed.

See you inside!`;

export const REGISTRATION_V1: CampaignScript = {
  id: "registration",
  version: "v1",
  campaignType: "registration",
  label: "Registration v1 (full)",

  systemPromptAppendix: [
    "# THIS CALL",
    "",
    "You are {{agent_name}} from Team FlexiFunnels, calling {{customer_name}}.",
    "",
    "Below is the approved script for this call. Follow its flow, its questions and its",
    "confirmations. The bracketed [YES] markers show where the script continues once the",
    "person agrees — they are branch labels, never spoken.",
    "",
    "Everything above about how to speak still applies: this is a live phone conversation,",
    "so deliver it a few sentences at a time and let them answer. If they say no, are busy,",
    "or object, respond to what they actually said rather than continuing down the script.",
    "",
    "--- SCRIPT ---",
    "",
    SCRIPT_BODY,
  ].join("\n"),

  openingLineTemplate: "Hi {{customer_name}}, this is {{agent_name}} from Team FlexiFunnels.",

  requiresName: true,
  isPlaceholder: false,
};
