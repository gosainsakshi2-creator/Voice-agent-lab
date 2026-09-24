const { classifyOutcome } = await import("../src/campaign/outcome/classifier");
const { dispositionFor } = await import("../src/campaign/outcome/disposition");
const { isFinalYes } = await import("../src/campaign/integrations/final-yes-sheet");
const { definitiveAnswerIn } = await import("../src/campaign/dispatch/call-runner");

function probe(label: string, turns: Array<{ role: "user" | "assistant"; text: string }>) {
  const o = classifyOutcome({
    campaignType: "registration",
    status: "COMPLETED",
    failureClass: "COMPLETED",
    answered: true,
    transcript: turns as never,
  });
  const d = dispositionFor({ outcomeType: o.outcomeType, failureClass: "COMPLETED" }).disposition;
  const live = definitiveAnswerIn(
    turns.map((t) => ({ role: t.role, content: t.text })) as never,
    "registration",
  );
  console.log(
    `${label}\n   outcome=${o.outcomeType} reason=${o.primaryReason} succeeded=${o.succeeded} disp=${d} finalYes=${isFinalYes(o, d)} liveVerdict=${live}`,
  );
}

const ID = "Am I speaking with Sakshi?";
const GATE = "Great — should I reserve your free seat for Sunday?";

probe("A. denial then a later generic yes at the gate", [
  { role: "assistant", text: ID },
  { role: "user", text: "No." },
  { role: "assistant", text: GATE },
  { role: "user", text: "Yes." },
]);

probe("B. Hindi denial then a later generic haan at the gate", [
  { role: "assistant", text: ID },
  { role: "user", text: "Nahi, main Sakshi nahi hoon." },
  { role: "assistant", text: GATE },
  { role: "user", text: "Haan ji." },
]);

probe("C. 'wrong number' denial then a later yes at the gate", [
  { role: "assistant", text: ID },
  { role: "user", text: "Wrong number." },
  { role: "assistant", text: GATE },
  { role: "user", text: "Yes." },
]);

probe("D. genuine confirmation then yes at the gate", [
  { role: "assistant", text: ID },
  { role: "user", text: "Yes, this is Sakshi." },
  { role: "assistant", text: GATE },
  { role: "user", text: "Yes." },
]);

probe("E. denial only, nothing after", [
  { role: "assistant", text: ID },
  { role: "user", text: "No." },
  { role: "assistant", text: "Sorry to bother you. Have a good day." },
]);

probe("F. denial, later yes at gate, agent confirms (live hangup shape)", [
  { role: "assistant", text: ID },
  { role: "user", text: "No." },
  { role: "assistant", text: GATE },
  { role: "user", text: "Yes." },
  { role: "assistant", text: "Perfect, your seat is reserved." },
  { role: "user", text: "Okay." },
  { role: "assistant", text: "Thank you. Have a great day. Bye!" },
]);
