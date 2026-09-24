const { classifyOutcome } = await import("../src/campaign/outcome/classifier");
const { dispositionFor } = await import("../src/campaign/outcome/disposition");
const { isFinalYes } = await import("../src/campaign/integrations/final-yes-sheet");
const { definitiveAnswerIn } = await import("../src/campaign/dispatch/call-runner");

function probe(label: string, turns: Array<{ role: "user" | "assistant"; text: string }>, denied: boolean) {
  const o = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: turns as never,
    ...(denied ? { identityDenied: true } : {}),
  });
  const d = dispositionFor({ outcomeType: o.outcomeType, failureClass: "COMPLETED" }).disposition;
  const live = definitiveAnswerIn(
    turns.map((t) => ({ role: t.role, content: t.text })) as never,
    "registration",
    denied,
  );
  console.log(
    `${label} (denied=${denied})\n   outcome=${o.outcomeType} reason=${o.primaryReason} succeeded=${o.succeeded} disp=${d} finalYes=${isFinalYes(o, d)} liveVerdict=${live}`,
  );
}

const ID = "Am I speaking with Sakshi?";
const GATE = "Great — should I reserve your free seat for Sunday?";

const A = [
  { role: "assistant" as const, text: ID },
  { role: "user" as const, text: "No." },
  { role: "assistant" as const, text: GATE },
  { role: "user" as const, text: "Yes." },
];
const F = [...A,
  { role: "assistant" as const, text: "Perfect, your seat is reserved." },
  { role: "user" as const, text: "Okay." },
  { role: "assistant" as const, text: "Thank you. Have a great day. Bye!" },
];
const D = [
  { role: "assistant" as const, text: ID },
  { role: "user" as const, text: "Yes, this is Sakshi." },
  { role: "assistant" as const, text: GATE },
  { role: "user" as const, text: "Yes." },
  { role: "assistant" as const, text: "Perfect, your seat is reserved." },
];
probe("A. denial then later yes at gate", A, true);
probe("F. denial, later yes, agent confirms", F, true);
probe("D. genuine confirmation", D, false);
probe("A-unflagged (regression check: unchanged when nothing is passed)", A, false);
probe("F-unflagged (regression check)", F, false);
