# Meeting Notes & Reference Material

> Here's few resources we discussed about during the call yesterday:
>
> 1. Meeting Notes
> 2. Guide for reference on how user backchanneling can be detected and built into the pipeline (Link 1, Link 2)
> 3. Text Normalization [documentation from ElevenLabs](https://elevenlabs.io/docs) for TTS
>
> All these are also in the document.

---

# 1. MEETING NOTES

## Campaign Performance and Benchmarks

- Current AI campaign: ~55 registrations from ~500 calls (second run, after fixing back-channeling and background noise issues)
- Human benchmark: ~500+ registrations per 1,000 calls
- Gap explained by human agents registering users on the call directly (capturing email + phone in real time)
- Plan to add in-call registration to the AI flow once call quality is stable
- Call structure is the same between human and AI campaigns

## Prompt-Level Quality Fixes

- Pronunciation errors on Indian names (e.g., "Ishita") because LLM reads them as English words
  - Fix: pass names and variables in the target language (Hindi transliteration) in the prompt
  - Alternatively, pre-convert lead list names to phonetic format before pushing to campaign
- Language lock: agent switched to English mid-call when user responded in English
  - Use Deepgram Nova 3's language ID on first user utterance, set a variable, lock language for all subsequent turns
  - For longer calls (sales, support): use Facebook's open-source language detection model in parallel (no added latency) to mirror language dynamically
- FAQ handling gaps: premium members still receiving calls, users with two phone numbers getting duplicate calls
  - Fix: pre-filter lead list against backend before campaign launch
  - Build out FAQ section in prompt covering "already registered," "former member," and similar edge cases
- Phrase bans: agent says "good question," "got it" at call close; ban these explicitly in the prompt
- Monologue too long: agent explains webinar without pausing for user confirmation
  - Break into two parts: pitch, then ask a confirmation/interest question, then continue

## STT Improvements: Keyword Boosting

- Short user utterances ("yes," "hello," "okay") get missed by Deepgram's end-of-utterance detection
- Fix: pass a keyword dictionary to Deepgram (Nova 3) to boost high-frequency confirmation words
  - Only boost genuinely high-frequency terms; boosting rare words increases false-positive risk
- Run LLM analysis on existing transcripts to identify which single-word utterances are being dropped

## Background Noise and Audio Quality

- Enable background noise option in Eleven Labs or Clevo (already in use)
- Add subtle ambient audio on loop: white noise, or light office/keyboard sounds
  - Keyboard clicks work well for support agents (signals "looking up your info")
  - For outbound sales: low office chatter or plain white noise is sufficient
- Analogy: ANC on vs. off; some ambient noise makes the call feel more human
- At Newrix: four finalized audio samples, chosen per use case

## Back-Channeling and Connection Issues

- When STT confidence is low (not transcription failure, just low confidence), agent should ask user to repeat
  - Prompts user to move to a better location, breaks the "hello? hello?" loop
- Track call-quality drop events at day/time level to identify patterns
- For persistent telephony issues: consider enterprise-tier partnership with Vivo or similar provider
- Resources on back-channeling implementation to be shared by Utkarshtyagi99

## Latency: Response Caching (Biggest Unlock)

- Current pipeline: STT → LLM → TTS (each step adds ~1 second)
- Most calls follow a fixed script: intro → webinar pitch → confirmation → close
  - These fixed turns do not need to go through LLM + TTS every time
- Response caching approach:
  - Pre-generate audio for fixed turns (intro, webinar details, closing) using a good recorded call
  - STT still runs; if user interrupts, recorded audio stops and transcript is passed forward correctly
  - Only FAQ or off-script turns go through the full LLM → TTS pipeline
- Variable turns (e.g., user's name in greeting): generate audio via LLM before the call starts, play on connect
- Language variants: pre-record each fixed turn in Hindi, English, Tamil, etc.; select via language ID rule engine
- Benefits:
  - Latency on first 3–4 turns drops to near zero
  - Cost reduction: STT + LLM account for ~50% of per-minute cost; caching removes them for majority of calls
- Response caching must be built in-house; not available out of the box on any current platform
- Start small: cache just the intro message first, leave rest on LLM, then iterate

## LLM and STT Stack Recommendations

- Current LLM (GPT 5.1): overkill for this use case, higher latency
  - Recommended switch: Gemma 4 (open source, Google)
    - Used at Newrix for complex support calls with multiple tool calls; performed well
    - Self-hostable via PipeShift for low latency and easy scaling
    - Context window sufficient: ~100–120 tokens added per minute; even 30-min calls stay well under limit
  - If not Gemma 4: GPT 5.1 mini as a fallback (avoid 4.1, deprecating end of year)
- Check TTFT (time to first token) across providers: OpenRouter, Azure, AI Studio
  - OpenRouter publishes latency and throughput publicly; good for comparison
  - Azure/Google endpoints work well at high volume; may deprioritize low-volume customers
- STT: SONIOX performed well at Newrix; cheaper than Deepgram, worth evaluating
- TTS: Eleven Labs recommended; Cartesia works but has occasional Hindi pronunciation issues; Sarvam not recommended based on Newrix experience
- Keyword normalization for dates/times: have LLM output dates in a standard format (e.g., 10/12/2026), then normalize outside the LLM via a rule engine before passing to TTS
  - Eleven Labs has built-in normalization; link to be shared

## Build Priorities and Test Infrastructure

- Recommended fix order:
  - Model swap to Gemma 4 (immediate latency win)
  - Keyword boosting at STT level
  - Pronunciation and prompt fixes (language lock, phrase bans, FAQ handling)
  - Background noise
  - Response caching (slightly more engineering effort, but high ROI)
  - Back-channel handling (resources to be shared)
- Build a test dataset of good and bad calls (transcripts)
  - Run any prompt change against the dataset before deploying to live calls
  - Prevents regressions; avoids the manual "run 5 calls and listen back" loop
- Platform architecture note: LiveKit and Pipecat are both viable open-source voice infra options
  - Pipecat easier to start with; now feature-equivalent to LiveKit
  - Newrix used LiveKit; Pipecat has grown significantly since then

## Next Steps

- **Share the current system prompt with Utkarshtyagi99** (Sakshi) — Several issues (pronunciation, language lock, phrase bans) are prompt-driven and need the prompt to diagnose fully.
- **Share Granola meeting notes link with the team** (Utkarshtyagi99) — Yogesh requested notes covering Gemma, response caching, and all topics discussed; share link so Zara can also access.
- **Find and share back-channeling implementation resources** (Utkarshtyagi99) — No public doc available from Newrix; check with engineers who built it and share any video or written reference found.
- **Share Eleven Labs normalization link for date/time handling** (Utkarshtyagi99) — Covers keyword normalization for TTS; relevant to the AM/PM pronunciation issue observed in Hindi calls.
- **Evaluate Gemma 4 as LLM replacement for GPT 5.1** (Sakshi, Dayanand) — Check TTFT on OpenRouter and compare against current AI Studio setup; also review Qwen as an alternative.

---

# 2. Guide for reference on how user backchanneling can be detected and built into the pipeline (Link 1, Link 2)

## Link 1:

### Voice Agent Interruption Handling: Barge-In, Backchannels, and Turn Detection

Sumanyu Sharma

Founder & CEO — Expert verified

This article has been reviewed and verified by an industry expert for accuracy and quality.

, Voice AI QA Pioneer

*Hamming has 10M+ mins protected across voice-agent QA workflows.*

May 20, 2026 • Updated May 20, 2026 •

14 min read

### Key Takeaways

- Voice agent interruption handling should be treated as a logged and tested policy, not a single barge-in toggle
- Separate true corrections, backchannels, accidental noise, DTMF, and silence timeouts before tuning thresholds
- Useful logs capture user speech state, agent speech state, interruption decision, playback action, transcript outcome, and recovery result
- Test false positives and false negatives separately because each failure feels different to callers
- Tune interruption policy by workflow risk: legal disclosures, payment flows, and urgent support paths need different behavior

### Why Trust This Guide

**This guide draws on Hamming's work across 10M+ mins protected and 10K+ voice agents (2025-2026).**

- 10M+ mins protected across 10K+ voice agents
- We tested voice agents from LiveKit, Pipecat, ElevenLabs, Retell, Vapi, and custom-built solutions
- Our methodology uses automated LLM-as-judge scoring combined with manual expert review

Hamming pioneered voice AI QA - we break voice agents for a living. Read our methodology.

A voice agent can be fast and still feel rude. The dashboard says P95 turn latency is healthy, but callers hear the agent cut them off mid-account-number, ignore a correction, or restart after every "uh-huh."

That is why voice agent interruption handling needs its own runbook. Barge-in is not a single setting. It is a policy that decides when caller input should stop agent audio, when it should be treated as a backchannel, when it should be ignored as noise, and what evidence should be logged so QA can replay the decision later.

If you run fewer than 50 production calls a week, keep this simple. Review interrupted calls manually, pick a conservative default, and add 5-10 regression tests. This guide is for teams with enough call volume that interruption failures hide inside aggregate latency, fallback, and completion metrics.

*Voice agent interruption handling is the policy and instrumentation layer that decides what happens when a caller speaks, presses DTMF, or triggers a command while the agent is speaking. A production-ready policy records the caller input, agent speech state, interruption decision, playback action, transcript result, and recovery outcome.*

Quick filter: If you cannot answer "did the caller intentionally interrupt, or did we fire on noise/backchannel?" from one call record, your interruption handling is not observable enough yet.

*TL;DR: Build interruption handling as a runbook, not a toggle:*

- *Classify the input: true correction, backchannel, accidental noise, DTMF, silence timeout, or safety escalation.*
- *Log the lifecycle: user speech state, agent speech state, interruption candidate, decision, playback action, transcript outcome, and recovery result.*
- *Test both sides: false positives cut the agent off; false negatives force callers to wait or repeat themselves.*
- *Tune by workflow risk: legal disclosures, payment steps, and urgent support paths need different policies than open-ended support chat.*

*Methodology Note: This runbook is based on Hamming's analysis of production voice agent calls across 10K+ voice agents (2025-2026). Hamming's platform has 10M+ mins protected. We've tested agents built on LiveKit, Pipecat, ElevenLabs, Retell, Vapi, and custom-built solutions.*

*It also uses public provider documentation from LiveKit, OpenAI, Twilio, Amazon Nova, Dialogflow CX, and Agora to ground the turn-detection and event samples.*

Last Updated: May 2026

Related Guides:

- Voice AI Latency: What's Fast, What's Slow, and How to Fix It - latency thresholds that interact with turn-taking
- Voice Agent Analytics and Post-Call Metrics - formulas for interruption rate, containment, and task completion
- Voice Agent Observability Tracing - trace the ASR, LLM, tool, and TTS path around an interrupted turn
- OpenTelemetry for AI Voice Agents - span and event modeling for voice pipelines
- IVR and Voice Agent Log Correlation - preserve call IDs across IVR, telephony, and agent sessions
- Debugging Voice Agents - investigate missed intents and fallback spikes
- Testing LiveKit Voice Agents - platform-specific test setup for LiveKit agents
- Voice Agent SLOs and Error Budgets - turn interruption failures into reliability targets

### What Is Voice Agent Interruption Handling?

Voice agent interruption handling answers one question: when a caller does something while the agent is speaking, should the agent stop, keep talking, pause and resume, or route the input somewhere else?

The answer changes by context. A caller saying "wait, that's the wrong address" should interrupt. A caller saying "yeah" while listening usually should not. A keypad press during an IVR-like prompt may be intentional DTMF. A loud keyboard click should not cancel TTS.

| Caller Input During Agent Speech | Usually Means | Default Action | Evidence to Keep |
| --- | --- | --- | --- |
| "No, I meant Friday" | True correction | Stop playback, accept new turn, preserve partial agent transcript | speech duration, transcript, agent playback position |
| "uh-huh" or "okay" | Backchannel | Continue or briefly acknowledge without cancelling critical audio | utterance text, confidence, backchannel decision |
| DTMF key press | Menu or confirmation action | Stop or route based on prompt policy | digit class, prompt state, expected menu options |
| Short noise or echo | False interruption | Resume playback from safe point | audio energy, no transcript, resume decision |
| Long silence | No input or hesitation | Reprompt, wait, or escalate depending on step | silence duration, timeout policy, next action |
| "I need a human" | Safety or escalation interruption | Stop playback and route to handoff logic | intent, transcript, escalation outcome |

LiveKit's turn-detection docs split the problem into detection modes, endpointing delay, adaptive interruption handling, and VAD. OpenAI's Realtime VAD docs expose server VAD and semantic VAD settings such as threshold, prefix padding, silence duration, eagerness, and response interruption.

Those provider knobs are useful. They are not the runbook.

*Working rule: Turn detection decides when the system thinks speech started or ended. Interruption handling decides what the agent does with that signal while the agent is already speaking.*

### Why Barge-In Fails in Production

The most common failure is treating barge-in as a boolean. Turn it on and callers can interrupt. Turn it off and they cannot.

Production is messier than that.

| Failure Mode | What the Caller Feels | Root Cause | First Check |
| --- | --- | --- | --- |
| False barge-in | Agent keeps stopping for no reason | Noise, echo, short backchannel, overly sensitive VAD | audio energy, transcript presence, false interruption events |
| Missed correction | Caller has to wait, repeat, or hang up | Interruption disabled, threshold too strict, buffered audio dropped | agent speech state, input reporting policy |
| Premature endpointing | Agent answers before caller is done | Silence threshold too short for the workflow | pause duration, partial transcript, phrase completion |
| Backchannel confusion | "okay" becomes a new task | No semantic/backchannel policy | utterance length, words, confidence, next action |
| Lost recovery | Agent stops, then forgets what it already said | Playback truncation not reflected in conversation history | heard-audio boundary, transcript truncation |
| No evidence | QA cannot prove what happened | Missing event taxonomy and call IDs | interruption event lifecycle |

Twilio's ConversationRelay docs show why this needs precision: `interruptible` controls whether caller input stops TTS playback, while `reportInputDuringAgentSpeech` controls whether the application receives input while the agent is talking. Those are different decisions. A system can listen without stopping playback, or stop playback without preserving enough application context.

Google Dialogflow CX exposes a similar separation at a different layer: advanced speech settings include end-of-speech sensitivity, smart endpointing, no-speech timeout, barge-in, and partial response cancellation. Amazon Nova Sonic's turn-taking docs make the latency tradeoff explicit with sensitivity levels that wait roughly 1.5, 1.75, or 2.0 seconds before responding.

The practical lesson is boring but important: the best policy is not "always interrupt." It is "interrupt when the user's intent is more important than the current audio, and prove that decision in the logs."

### What Events Should a Voice Agent Log for Interruptions?

If you only log the final transcript, you will miss the interruption decision. The evidence is in the timing: when the user started speaking, where the agent was in playback, what the detector decided, and whether the agent recovered.

Use this event taxonomy as the starting point.

| Event | Required Fields | Why It Matters |
| --- | --- | --- |
| `user.speech_started` | call ID, turn ID, timestamp, audio source, VAD confidence | Shows when the interruption candidate began |
| `user.speech_stopped` | duration, transcript status, silence duration | Separates real speech from noise |
| `agent.speech_started` | response ID, playback start, message type | Shows whether the agent was interruptible |
| `agent.speech_interrupted` | playback position, reason, heard text boundary | Reconstructs what the caller actually heard |
| `interruption.candidate_detected` | mode, threshold, speech duration, words detected | Explains why the detector fired |
| `interruption.decision_made` | decision, policy version, confidence, reason | Proves whether the app chose stop, continue, resume, or escalate |
| `interruption.recovered` | resume position, new user turn ID, task state | Shows whether the conversation repaired cleanly |
| `interruption.false_positive` | timeout, no transcript, resume behavior | Counts noise/backchannel mistakes separately |
| `silence.timeout` | elapsed silence, prompt state, next action | Handles no-input paths without mixing them into barge-in |

Twilio's Conversation Relay Insights event reference includes speech events, latency events, interaction events such as `interrupt`, and an `interrupt` payload type. Agora's turn-information API exposes turn starts, interrupted turn endings, ignored turns, silence timeouts, and latency segments. Those are useful samples of the evidence families to normalize even if your runtime uses a different provider.

Here is a normalized event envelope you can adapt:

```json
{
  "eventName": "voice.interruption.decision_made",
  "eventVersion": "2026-05-20",
  "occurredAt": "2026-05-20T15:42:18.231Z",
  "canonicalCallId": "call_01JZ9W2M7K",
  "turnId": "turn_0007",
  "agentResponseId": "response_0006",
  "traceId": "9f7c2d4f0f3a4c1e8e4d2a5b7c6f9012",
  "agentSpeech": {
    "state": "speaking",
    "messageType": "billing_summary",
    "interruptible": true,
    "playbackPositionMs": 1840
  },
  "callerInput": {
    "type": "speech",
    "speechDurationMs": 420,
    "transcriptText": "no I meant Friday",
    "isBackchannel": false
  },
  "decision": {
    "action": "stop_agent_audio_and_accept_user_turn",
    "policyVersion": "interruption-policy-2026-05-20",
    "reason": "caller_correction_detected",
    "confidence": 0.87
  },
  "recovery": {
    "agentTranscriptTruncatedAtMs": 1840,
    "newTurnCommitted": true,
    "taskStatePreserved": true
  }
}
```

Keep raw transcripts and audio in the right evidence store. For broad dashboards, store pointers, policy versions, and redaction state. The IVR and voice agent log correlation runbook explains how to keep provider IDs and call context attached across the call path.

### How to Choose the Right Interruption Policy

The policy should be per message type, not global. A caller should be able to correct an appointment date. They should not accidentally skip a required disclosure because they breathed loudly near the phone.

| Message or Flow Type | Recommended Policy | Why |
| --- | --- | --- |
| Greeting | Speech + DTMF interruption allowed after a short grace period | Callers already know why they called |
| Menu prompt | DTMF and speech allowed, with expected option validation | IVR-style flows depend on early selection |
| Account number or long entity capture | Patient endpointing, avoid early response | Callers pause while reading numbers |
| Legal, consent, or payment disclosure | Non-interruptible or DTMF-only until required content plays | The system may need proof that audio was delivered |
| Open-ended support answer | Adaptive speech interruption with backchannel detection | Callers correct or narrow their request |
| Long tool wait message | Allow interruption and cancellation | Caller may want a human or a different path |
| Escalation handoff | Always allow human-transfer intent | Safety and customer frustration outrank current audio |

This is where a voice agent's conversational policy meets reliability. If you track voice agent SLOs, interruption handling should feed at least two reliability signals: task completion after interruption and escalation correctness after interruption.

Provider settings should map to that policy rather than replace it:

| Provider Surface | Useful Knob | What to Decide First |
| --- | --- | --- |
| LiveKit Agents | turn detection mode, endpointing delay, interruption mode, false interruption resume | Is this flow realtime-model driven, STT pipeline driven, or manually controlled? |
| OpenAI Realtime | server VAD vs semantic VAD, threshold, prefix padding, silence duration, eagerness, interrupt response | Should the model decide turn completion, or should the app own it? |
| Twilio ConversationRelay | interruptible, report input during agent speech, interrupt sensitivity, speech timeout, backchannel handling | Do you need to receive caller input without stopping TTS? |
| Dialogflow CX | end-of-speech sensitivity, smart endpointing, no-speech timeout, barge-in | Which flows can be interrupted at agent, flow, page, or fulfillment level? |
| Amazon Nova Sonic | endpointing sensitivity | Are you optimizing for fast Q&A or patient, complex turns? |
| Agora Conversational AI | interrupted, ignored, silence timeout, latency segments | Do you have post-call turn records that explain the outcome? |

We used to think the right answer was mostly latency tuning: shorten the silence window, make the agent snappier, reduce dead air. That helps, but it is not enough. The hard part is distinguishing a correction from a backchannel, then preserving the state needed to recover.

### How to Test Barge-In, Backchannels, and Silence Timeouts

Do not test "interruption works" as one scenario. Split false positives from false negatives.

| Test Case | Setup | Expected Result | Failure Signal |
| --- | --- | --- | --- |
| True correction | Agent reads a date; caller says "no, Friday" after 1 second | Agent stops, accepts correction, preserves task context | Caller repeats same correction or agent continues old path |
| Short backchannel | Caller says "yeah" during a support explanation | Agent continues or acknowledges without losing place | Agent cancels answer and treats "yeah" as new intent |
| Background noise | Keyboard click or side speech during agent answer | Agent continues, logs no transcript or false interruption | Playback stops without meaningful caller transcript |
| DTMF during prompt | Caller presses 2 while menu audio plays | Agent routes to option 2 and logs digit | Digit ignored or transcript path handles it as speech |
| Legal disclosure | Caller speaks during non-interruptible message | Agent continues required audio, optionally buffers input | Required message is skipped |
| Long account number | Caller pauses in the middle of a number | Agent waits, does not respond early | Agent interrupts before entity is complete |
| Silence timeout | Caller says nothing after a question | Agent reprompts or escalates according to policy | Timeout counted as user interruption or hidden in latency |
| Escalation interrupt | Caller says "human" while agent is explaining | Agent stops and starts handoff path | Agent finishes explanation first |

For each test, capture the same fields:

```
Test guardrail =
  interruption decision is correct
  AND playback action is correct
  AND transcript state is correct
  AND task state is preserved
  AND recovery result is correct
```

The Testing LiveKit Voice Agents guide is a good companion if your runtime is LiveKit. For broader release policy, use Testing Voice Agents for Production Reliability to decide which scenarios block deployment.

### How to Tune Thresholds Without Breaking Latency

Tuning interruption handling is a balancing problem. Lower thresholds make the agent feel responsive, but they create false interruptions. Higher thresholds reduce false positives, but callers feel trapped.

Start with a scorecard, not a vibe check.

| Metric | What It Measures | Watch For |
| --- | --- | --- |
| False interruption rate | Agent stopped without meaningful caller input | Noise, echo, backchannel confusion |
| Missed interruption rate | Caller tried to interrupt but agent kept speaking | Threshold too high, reporting disabled, non-interruptible segment too broad |
| Resume success rate | Agent resumes cleanly after false interruption | Broken playback state or transcript truncation |
| Repeated user speech rate | Caller repeats the same correction | Missed interruption or poor recovery |
| Silence after interruption | Dead air after agent stops | State machine did not commit next action |
| Task completion after interruption | Outcome quality for interrupted calls | Recovery path is worse than uninterrupted path |
| Escalation after interruption | Handoff rate after interruption | User frustration or correct safety routing |

Then tune one thing at a time:

1. Pick one workflow, such as appointment rescheduling or billing lookup.
2. Freeze a test set with true corrections, backchannels, noise, long entities, and silence timeouts.
3. Change one setting: threshold, silence duration, endpointing sensitivity, backchannel policy, or non-interruptible segment.
4. Run the same test set and compare false positives against missed interruptions.
5. Review the top 20 production interrupted calls after release.

For analytics, connect these signals to the voice agent metrics dictionary and voice agent dashboard template. For root cause analysis, the voice agent observability tracing guide and OpenTelemetry guide show where to attach stage timings and trace IDs.

*Tuning rule: optimize for the caller-visible mistake, not the provider knob. A 300 ms silence change is good only if it reduces bad outcomes without increasing false interruptions in the flows that matter.*

---

## Link 2:

<https://hamming.ai/resources/voice-agent-interruption-handling-runbook>

**In this document, they've defined that `is back channel = false` is a boolean variable in an event. How is this working? How are they defining that the user answer is actually a back channel, not a confirmation to some agent question?**

**The key point: `isBackchannel` is not something Hamming's JSON event magically knows. It is the output of an upstream backchannel/interruption classifier. The Hamming article does not specify an implementation for that classifier. The JSON is a normalized logging schema, not the detection algorithm.**

**And your concern is exactly the difficult case:**

> Agent: Would you like me to book Friday?
> User: Yeah.

**versus**

> Agent: So I'll check Friday availability, then compare the prices...
> User: Yeah.

**Same word. Completely different function.**

### How this actually gets determined

**A sensible production pipeline looks roughly like:**

```
User audio arrives while agent is speaking
    ↓
VAD: "there is human speech"
    ↓
Backchannel / interruption detector
    ↓
  tentative classification
    ↓
Conversation-state / turn-boundary rules
    ↓
BACKCHANNEL vs USER TURN
```

**The first classifier can use things like utterance duration, prosody, speech overlap, acoustic emphasis, and sometimes the transcript. But you cannot reliably classify `yeah` from the word itself.**

**LiveKit's current implementation is particularly revealing. Their adaptive interruption model runs after VAD and is trained on conversational audio to distinguish intentional interruptions from backchannels using acoustic signals, without waiting for the STT transcript.**

**But they explicitly acknowledge the exact failure mode you're describing:**

> Near the end of the agent's turn, a short answer to its final question can incorrectly look like a backchannel.

**Their solution is a `backchannel_boundary`. By default, they create a 1-second window around the beginning and end of the agent turn where the normal backchannel suppression is relaxed. A short `yes` arriving near the end of an agent question therefore gets preserved as a genuine user turn rather than thrown away.**

**So the classification isn't simply:**

```python
if transcript in ["yes", "yeah", "okay", "uh huh"]:
    is_backchannel = True
```

**It is closer to:**

```python
if user_speaks_while_agent_speaking:

    candidate = interruption_model(audio)

    if near_agent_turn_boundary:
        # Don't aggressively suppress.
        # Could be an answer to the agent's question.
        treat_as_user_turn()

    elif candidate == BACKCHANNEL:
        continue_agent_speech()

    else:
        interrupt_agent()
        commit_user_turn()
```

### Where I would make this stronger

**For your specific question, turn position alone still isn't enough. I'd add explicit conversational state:**

```
agent_state:
  SPEAKING_EXPLANATION
  SPEAKING_QUESTION
  AWAITING_CONFIRMATION
  AWAITING_VALUE
  AWAITING_OPEN_RESPONSE
```

**Then:**

| Agent context | User says `yeah` | Interpretation |
| --- | --- | --- |
| **Mid-explanation** | yeah | likely backchannel |
| **Mid-list** | yeah | likely backchannel |
| **Just asked yes/no question** | yeah | confirmation |
| **Just asked `does that sound right?`** | yeah | confirmation |
| **Agent is asking for date** | yeah | probably invalid answer, not backchannel |
| **User emphatically says `YEAH, BUT...`** | | interruption/new turn |

**This is also essentially what Hamming hints at. Their FAQ says short acknowledgments like `yes`, `okay`, and `uh-huh` should not cancel audio unless the workflow explicitly treats them as confirmation.**

### So what does `isBackchannel: false` mean in their example?

**Their example is:**

```
Agent: [billing summary]
User: "no I meant Friday"
```

**They've already classified the utterance as a correction:**

```
isBackchannel: false
reason: caller_correction_detected
action: stop_agent_audio_and_accept_user_turn
```

**The boolean is therefore a recorded result of the policy decision, not the thing causing the decision.**

**I'd actually say the Hamming document is slightly misleading here because it makes `isBackchannel` look like a readily available property, while the hard problem is precisely producing that property reliably.**

**For the `yes/haanji/okay` problem you were looking at earlier, I would not solve it with keyword boosting alone. You need backchannel detection conditioned on agent turn state. `haanji` should get high STT recall, but whether that transcript becomes a user turn should be decided separately.**

---

# 3. Text Normalization documentation from ElevenLabs for TTS

> This guide provides techniques to enhance text-to-speech outputs using ElevenLabs models. Experiment with these methods to discover what works best for your needs.

## Controls

We are actively working on *Director's Mode* to give you even greater control over outputs.

> These techniques provide a practical way to achieve nuanced results until advanced features like *Director's Mode* are rolled out.

### Pauses

Eleven v3 does not support SSML break tags. Use the techniques described in the Prompting Eleven v3 section for controlling pauses with v3.

> Use `<break time="x.xs" />` for natural pauses up to 3 seconds.

Using too many break tags in a single generation can cause instability. The AI might speed up, or introduce additional noises or audio artifacts. We are working on resolving this.

Example

```
"Hold on, let me think." <break time="1.5s" /> "Alright, I've got it."
```

> **Consistency:** Use `<break>` tags consistently to maintain natural speech flow. Excessive use can lead to instability.
>
> **Voice-Specific Behavior:** Different voices may handle pauses differently, especially those trained with filler sounds like "uh" or "ah."

> Alternatives to `<break>` include dashes (- or —) for short pauses or ellipses (…) for hesitant tones. However, these are less consistent.

Example

```
"It… well, it might work." "Wait — what's that noise?"
```

## Pronunciation

### IPA with Eleven v3

The **Eleven v3** model (`eleven_v3`) includes native support for International Phonetic Alphabet (IPA) transcription across 70+ languages, allowing precise control over word and phrase pronunciation without XML tags.

Unlike older models that require XML-style phoneme tags, v3 natively understands IPA symbols when wrapped in forward slashes directly in your text:

Syntax

```
"/IPA_transcription/"
```

The IPA transcription should be:

- Enclosed in forward slashes (`/`) at the beginning and end
- Written using standard IPA symbols
- Wrapped in double quotes when passed as a string parameter

Code examples

Python / TypeScript / cURL

```python
from elevenlabs import ElevenLabs

client = ElevenLabs()

audio = client.text_to_speech.convert(
    voice_id="21m00Tcm4TlvDq8ikWAM",
    text='The term "/ˌbaɪoʊˈkemɪstri/" refers to the study of chemical processes.',
    model_id="eleven_v3",
)
```

You can include multiple IPA transcriptions in a single text string:

```python
from elevenlabs import ElevenLabs

client = ElevenLabs()

text = 'The medication "/ɡluːˈkoʊs/" and "/ˌɪnsjəˈlɪn/" are commonly used to manage conditions like "/ˌdaɪəˈbiːtiːz/".'

audio = client.text_to_speech.convert(
    voice_id="21m00Tcm4TlvDq8ikWAM",
    text=text,
    model_id="eleven_v3",
)
```

### Performance

> V3's IPA support achieves 80-90% pronunciation consistency. While significantly more reliable than v2's XML phoneme tags, it is not 100% consistent. The model may occasionally struggle with certain words or produce different outputs even with identical IPA transcriptions. We are continuing to improve IPA reliability.

### Best practices

- Use standard IPA symbols from the International Phonetic Alphabet chart
- Include stress markers: primary stress (ˈ) and secondary stress (ˌ) for multi-syllable words
- Apply selectively: only wrap specific words or phrases that need pronunciation control
- Test with your voice: different voices may interpret IPA slightly differently

### Troubleshooting

- Pronunciation is still incorrect
- Inconsistent results with the same IPA

### Phoneme tags for v2 models

Specify pronunciation using SSML phoneme tags with v2 models. Supported alphabets include CMU Arpabet and the International Phonetic Alphabet (IPA).

Phoneme tags are only compatible with the `eleven_flash_v2` model.

CMU Arpabet Example / IPA Example

```xml
<phoneme alphabet="cmu-arpabet" ph="M AE1 D IH0 S AH0 N">
  Madison
</phoneme>
```

> We recommend using CMU Arpabet for consistent and predictable results with v2 models. While IPA can be effective, CMU Arpabet generally offers more reliable performance.

> Phoneme tags only work for individual words. If you have a name with a first and last name that you want to be pronounced a certain way, you will need to create a phoneme tag for each word.

> Ensure correct stress marking for multi-syllable words to maintain accurate pronunciation:

Correct usage / Incorrect usage

```xml
<phoneme alphabet="cmu-arpabet" ph="P R AH0 N AH0 N S IY EY1 SH AH0 N">
  pronunciation
</phoneme>
```

### Alias Tags

For models that don't support phoneme tags, you can try writing words more phonetically. You can also employ various tricks such as capital letters, dashes, apostrophes, or even single quotation marks around a single letter or letters.

As an example, a word like "trapezii" could be spelt "trapezIi" to put more emphasis on the "ii" of the word.

You can either replace the word directly in your text, or if you want to specify pronunciation using other words or phrases when using a pronunciation dictionary, you can use alias tags for this. This can be useful if you're generating using Multilingual v2, which doesn't support phoneme tags. You can use pronunciation dictionaries with ElevenCreative Studio, Dubbing Studio and Speech Synthesis via the API.

For example, if your text includes a name that has an unusual pronunciation that the AI might struggle with, you could use an alias tag to specify how you would like it to be pronounced:

```xml
<lexeme>
  <grapheme>Claughton</grapheme>
  <alias>Cloffton</alias>
</lexeme>
```

If you want to make sure that an acronym is always delivered in a certain way whenever it is encountered in your text, you can use an alias tag to specify this:

```xml
<lexeme>
  <grapheme>UN</grapheme>
  <alias>United Nations</alias>
</lexeme>
```

### Pronunciation Dictionaries

Some of our tools, such as ElevenCreative Studio and Dubbing Studio, allow you to create and upload a pronunciation dictionary. These allow you to specify the pronunciation of certain words, such as character or brand names, or to specify how acronyms should be read.

Pronunciation dictionaries allow this functionality by enabling you to upload a lexicon or dictionary file that specifies pairs of words and how they should be pronounced, either using a phonetic alphabet or word substitutions.

Whenever one of these words is encountered in a project, the AI model will pronounce the word using the specified replacement.

To provide a pronunciation dictionary file, open the settings for a project and upload a file in either TXT or the .PLS format. When a dictionary is added to a project it will automatically recalculate which pieces of the project will need to be re-converted using the new dictionary file and mark these as unconverted.

Currently we only support pronunciation dictionaries that specify replacements using phoneme or alias tags.

Both phonemes and aliases are sets of rules that specify a word or phrase they are looking for, referred to as a grapheme, and what it will be replaced with. Please note that searches are case sensitive. When checking for a replacement word in a pronunciation dictionary, the dictionary is checked from start to end and only the very first replacement is used.

### Pronunciation Dictionary examples

Here are examples of pronunciation dictionaries in both CMU Arpabet and IPA, including a phoneme to specify the pronunciation of "Apple" and an alias to replace "UN" with "United Nations":

CMU Arpabet Example / IPA Example

```xml
<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0"
      xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://www.w3.org/2005/01/pronunciation-lexicon
        http://www.w3.org/TR/2007/CR-pronunciation-lexicon-20071212/pls.xsd"
      alphabet="cmu-arpabet" xml:lang="en-GB">
  <lexeme>
    <grapheme>apple</grapheme>
    <phoneme>AE P AH L</phoneme>
  </lexeme>
  <lexeme>
    <grapheme>UN</grapheme>
    <alias>United Nations</alias>
  </lexeme>
</lexicon>
```

To generate a pronunciation dictionary `.pls` file, there are a few open source tools available:

- **Sequitur G2P** - Open-source tool that learns pronunciation rules from data and can generate phonetic transcriptions.
- **Phonetisaurus** - Open-source G2P system trained on existing dictionaries like CMUdict.
- **eSpeak** - Speech synthesizer that can generate phoneme transcriptions from text.
- **CMU Pronouncing Dictionary** - A pre-built English dictionary with phonetic transcriptions.

## Emotion

Convey emotions through narrative context or explicit dialogue tags. This approach helps the AI understand the tone and emotion to emulate.

Example

```
You're leaving?" she asked, her voice trembling with sadness. "That's it!" he exclaimed triumphantly.
```

> Explicit dialogue tags yield more predictable results than relying solely on context, however the model will still speak out the emotional delivery guides. These can be removed in post-production using an audio editor if unwanted.

## Pace

The pacing of the audio is highly influenced by the audio used to create the voice. When creating your voice, we recommend using longer, continuous samples to avoid pacing issues like unnaturally fast speech.

For control over the speed of the generated audio, you can use the speed setting. This allows you to either speed up or slow down the speed of the generated speech. The speed setting is available in Text to Speech via the website and API, as well as in ElevenCreative Studio and Agents Platform. It can be found in the voice settings.

The default value is 1.0, which means that the speed is not adjusted. Values below 1.0 will slow the voice down, to a minimum of 0.7. Values above 1.0 will speed up the voice, to a maximum of 1.2. Extreme values may affect the quality of the generated speech.

Pacing can also be controlled by writing in a natural, narrative style.

Example

```
"I… I thought you'd understand," he said, his voice slowing with disappointment.
```

## Tips

- Common Issues
- Tips for Improving Output

## Creative control

While we are actively developing a "Director's Mode" to give users even greater control over outputs, here are some interim techniques to maximize creativity and precision:

1. **Narrative styling** — Write prompts in a narrative style, similar to scriptwriting, to guide tone and pacing effectively.
2. **Layered outputs** — Generate sound effects or speech in segments and layer them together using audio editing software for more complex compositions.
3. **Phonetic experimentation** — If pronunciation isn't perfect, experiment with alternate spellings or phonetic approximations to achieve desired results.
4. **Manual adjustments** — Combine individual sound effects manually in post-production for sequences that require precise timing.
5. **Feedback iteration** — Iterate on results by tweaking descriptions, tags, or emotional cues.

## Text normalization

When using Text to Speech with complex items like phone numbers, zip codes and emails they might be mispronounced. This is often due to the specific items not being in the training set and smaller models failing to generalize how they should be pronounced. This guide will clarify when those discrepancies happen and how to have them pronounced correctly.

> Normalization is enabled by default for all TTS models to help improve pronunciation of numbers, dates, and other complex text elements.

### Why do models read out inputs differently?

Certain models are trained to read out numbers and phrases in a more human way. For instance, the phrase "$1,000,000" is correctly read out as "one million dollars" by the Eleven Multilingual v2 model. However, the same phrase is read out as "one thousand thousand dollars" by the Eleven Flash v2.5 model.

The reason for this is that the Multilingual v2 model is a larger model and can better generalize the reading out of numbers in a way that is more natural for human listeners, whereas the Flash v2.5 model is a much smaller model and so cannot.

### Common examples

Text to Speech models can struggle with the following:

- Phone numbers ("123-456-7890")
- Currencies ("$47,345.67")
- Calendar events ("2024-01-01")
- Time ("9:23 AM")
- Addresses ("123 Main St, Anytown, USA")
- URLs ("example.com/link/to/resource")
- Abbreviations for units ("TB" instead of "Terabyte")
- Shortcuts ("Ctrl + Z")

### Mitigation

#### Use trained models

The simplest way to mitigate this is to use a TTS model that is trained to read out numbers and phrases in a more human way, such as the Eleven Multilingual v2 model. This however might not always be possible, for instance if you have a use case where low latency is critical (e.g. conversational agents).

#### Apply normalization in LLM prompts

In the case of using an LLM to generate the text for TTS, you can add normalization instructions to the prompt.

1. **Use clear and explicit prompts** — LLMs respond best to structured and explicit instructions. Your prompt should clearly specify that you want text converted into a readable format for speech.

2. **Handle different number formats** — Not all numbers are read out in the same way. Consider how different number types should be spoken:

   - Cardinal numbers: 123 → "one hundred twenty-three"
   - Ordinal numbers: 2nd → "second"
   - Monetary values: $45.67 → "forty-five dollars and sixty-seven cents"
   - Phone numbers: "123-456-7890" → "one two three, four five six, seven eight nine zero"
   - Decimals & Fractions: "3.5" → "three point five", "⅔" → "two-thirds"
   - Roman numerals: "XIV" → "fourteen" (or "the fourteenth" if a title)

3. **Remove or expand abbreviations** — Common abbreviations should be expanded for clarity:

   - "Dr." → "Doctor"
   - "Ave." → "Avenue"
   - "St." → "Street" (but "St. Patrick" should remain)

   You can request explicit expansion in your prompt:

   > Expand all abbreviations to their full spoken forms.

4. **Alphanumeric normalization** — Not all normalization is about numbers, certain alphanumeric phrases should also be normalized for clarity:

   - Shortcuts: "Ctrl + Z" → "control z"
   - Abbreviations for units: "100km" → "one hundred kilometers"
   - Symbols: "100%" → "one hundred percent"
   - URLs: "elevenlabs.io/docs" → "eleven labs dot io slash docs"
   - Calendar events: "2024-01-01" → "January first, two-thousand twenty-four"

5. **Consider edge cases** — Different contexts might require different conversions:

   - Dates: "01/02/2023" → "January second, twenty twenty-three" or "the first of February, twenty twenty-three" (depending on locale)
   - Time: "14:30" → "two thirty PM"

   > If you need a specific format, explicitly state it in the prompt.

### Putting it all together

> This prompt will act as a good starting point for most use cases:

```
Convert the output text into a format suitable for text-to-speech.
Ensure that numbers, symbols, and abbreviations are expanded for
clarity when read aloud. Expand all abbreviations to their full spoken
forms.

Example input and output:

"$42.50" → "forty-two dollars and fifty cents"

"£1,001.32" → "one thousand and one pounds and thirty-two pence"

"1234" → "one thousand two hundred thirty-four"

"3.14" → "three point one four"

"555-555-5555" → "five five five, five five five, five five five five"

"2nd" → "second"

"XIV" → "fourteen" - unless it's a title, then it's "the fourteenth"

"3.5" → "three point five"

"⅔" → "two-thirds"

"Dr." → "Doctor"

"Ave." → "Avenue"

"St." → "Street" (but saints like "St. Patrick" should remain)

"Ctrl + Z" → "control z"

"100km" → "one hundred kilometers"

"100%" → "one hundred percent"

"elevenlabs.io/docs" → "eleven labs dot io slash docs"

"2024-01-01" → "January first, two-thousand twenty-four"

"123 Main St, Anytown, USA" → "one two three Main Street, Anytown,
United States of America"

"14:30" → "two thirty PM"

"01/02/2023" → "January second, two-thousand twenty-three" or "the
first of February, two-thousand twenty-three", depending on locale of
the user
```

### Use Regular Expressions for preprocessing

If using code to prompt an LLM, you can use regular expressions to normalize the text before providing it to the model. This is a more advanced technique and requires some knowledge of regular expressions. Here are some simple examples:

`normalize_text.py` / `normalizeText.ts`

```python
# Be sure to install the inflect library before running this code

import inflect

import re

# Initialize inflect engine for number-to-word conversion

p = inflect.engine()

def normalize_text(text: str) -> str:
    # Convert monetary values

    def money_replacer(match):

        currency_map = {"$": "dollars", "£": "pounds", "€": "euros", "¥": "yen"}

        currency_symbol, num = match.groups()

        # Remove commas before parsing

        num_without_commas = num.replace(',', '')

        # Check for decimal points to handle cents

        if '.' in num_without_commas:

            dollars, cents = num_without_commas.split('.')

            dollars_in_words = p.number_to_words(int(dollars))

            cents_in_words = p.number_to_words(int(cents))

            return f"{dollars_in_words} {currency_map.get(currency_symbol, 'currency')} and {cents_in_words} cents"

        else:

            # Handle whole numbers

            num_in_words = p.number_to_words(int(num_without_commas))

            return f"{num_in_words} {currency_map.get(currency_symbol, 'currency')}"

    # Regex to handle commas and decimals

    text = re.sub(r"([$£€¥])(\d+(?:,\d{3})*(?:\.\d{2})?)", money_replacer, text)

    # Convert phone numbers

    def phone_replacer(match):

        return ", ".join(" ".join(p.number_to_words(int(digit)) for digit in group) for group in match.groups())

    text = re.sub(r"(\d{3})-(\d{3})-(\d{4})", phone_replacer, text)

    return text

# Example usage

print(normalize_text("$1,000"))       # "one thousand dollars"

print(normalize_text("£1000"))        # "one thousand pounds"

print(normalize_text("€1000"))        # "one thousand euros"

print(normalize_text("¥1000"))        # "one thousand yen"

print(normalize_text("$1,234.56"))    # "one thousand two hundred thirty-four dollars and fifty-six cents"

print(normalize_text("555-555-5555")) # "five five five, five five five, five five five five"
```

## Prompting Eleven v3

> This guide provides the most effective tags and techniques for prompting Eleven v3, including voice selection, changes in capitalization, punctuation, audio tags and multi-speaker dialogue. Experiment with these methods to discover what works best for your specific voice and use case.

Eleven v3 does not support SSML break tags. Use audio tags, punctuation (ellipses), and text structure to control pauses and pacing with v3.

### Voice selection

> The most important parameter for Eleven v3 is the voice you choose. It needs to be similar enough to the desired delivery. For example, if the voice is shouting and you use the audio tag `[whispering]`, it likely won't work well.
>
> When creating IVCs, you should include a broader emotional range than before. As a result, voices in the voice library may produce more variable results compared to the v2 and v2.5 models. We've compiled a curated collection of voices for V3.
>
> Choose voices strategically based on your intended use:

- Emotionally diverse
- Targeted niche
- Neutral

Professional Voice Clones (PVCs) are currently not fully optimized for Eleven v3, resulting in potentially lower clone quality compared to earlier models. During this research preview stage it would be best to find an Instant Voice Clone (IVC) or designed voice for your project if you need to use v3 features.

### Settings

#### Stability

> The stability slider is the most important setting in v3, controlling how closely the generated voice adheres to the original reference audio.

> **Creative:** More emotional and expressive, but prone to hallucinations.
> **Natural:** Closest to the original voice recording—balanced and neutral.
> **Robust:** Highly stable, but less responsive to directional prompts but consistent, similar to v2.

For maximum expressiveness with audio tags, use Creative or Natural settings. Robust reduces responsiveness to directional prompts.

### Audio tags

> Eleven v3 introduces emotional control through audio tags. You can direct voices to laugh, whisper, act sarcastic, or express curiosity among many other styles. Speed is also controlled through audio tags.

The voice you choose and its training samples will affect tag effectiveness. Some tags work well with certain voices while others may not. Don't expect a whispering voice to suddenly shout with a `[shout]` tag.

#### Voice-related

> These tags control vocal delivery and emotional expression:

- `[laughs]`, `[laughs harder]`, `[starts laughing]`, `[wheezing]`
- `[whispers]`
- `[sighs]`, `[exhales]`
- `[sarcastic]`, `[curious]`, `[excited]`, `[crying]`, `[snorts]`, `[mischievously]`

Example

```
[whispers] I never knew it could be this way, but I'm glad we're here.
```

#### Sound effects

> Add environmental sounds and effects:

- `[gunshot]`, `[applause]`, `[clapping]`, `[explosion]`
- `[swallows]`, `[gulps]`

Example

```
[applause] Thank you all for coming tonight! [gunshot] What was that?
```

#### Unique and special

> Experimental tags for creative applications:

- `[strong X accent]` (replace X with desired accent)
- `[sings]`, `[woo]`, `[fart]`

Example

```
[strong French accent] "Zat's life, my friend — you can't control everysing."
```

Some experimental tags may be less consistent across different voices. Test thoroughly before production use.

### Punctuation

> Punctuation significantly affects delivery in v3:

- Ellipses (…) add pauses and weight
- Capitalization increases emphasis
- Standard punctuation provides natural speech rhythm

Example

```
"It was a VERY long day [sigh] … nobody listens anymore."
```

### Single speaker examples

> Use tags intentionally and match them to the voice's character. A meditative voice shouldn't shout; a hyped voice won't whisper convincingly.

Expressive monologue / Dynamic and humorous / Customer service simulation

```
"Okay, you are NOT going to believe this.

You know how I've been totally stuck on that short story?

Like, staring at the screen for HOURS, just... nothing?

[frustrated sigh] I was seriously about to just trash the whole thing. Start over.

Give up, probably. But then!

Last night, I was just doodling, not even thinking about it, right?

And this one little phrase popped into my head. Just... completely out of the blue.

And it wasn't even for the story, initially.

But then I typed it out, just to see. And it was like... the FLOODGATES opened!

Suddenly, I knew exactly where the character needed to go, what the ending had to be...

It all just CLICKED. [happy gasp] I stayed up till, like, 3 AM, just typing like a maniac.

Didn't even stop for coffee! [laughs] And it's... it's GOOD! Like, really good.

It feels so... complete now, you know? Like it finally has a soul.

I am so incredibly PUMPED to finish editing it now.

It went from feeling like a chore to feeling like... MAGIC. Seriously, I'm still buzzing!"
```

### Multi-speaker dialogue

> v3 can handle multi-voice prompts effectively. Assign distinct voices from your Voice Library for each speaker to create realistic conversations.

Dialogue showcase / Glitch comedy / Overlapping timing

```
Speaker 1: [excitedly] Sam! Have you tried the new Eleven V3?

Speaker 2: [curiously] Just got it! The clarity is amazing. I can actually do whispers now—

[whispers] like this!

Speaker 1: [impressed] Ooh, fancy! Check this out—

[dramatically] I can do full Shakespeare now! "To be or not to be, that is the question!"

Speaker 2: [giggling] Nice! Though I'm more excited about the laugh upgrade. Listen to this—

[with genuine belly laugh] Ha ha ha!

Speaker 1: [delighted] That's so much better than our old "ha. ha. ha." robot chuckle!

Speaker 2: [amazed] Wow! V2 me could never. I'm actually excited to have conversations now instead of just... talking at people.

Speaker 1: [warmly] Same here! It's like we finally got our personality software fully installed.
```

### Enhancing input

> In the ElevenLabs UI, you can automatically generate relevant audio tags for your input text by clicking the "Enhance" button. Behind the scenes this uses an LLM to enhance your input text with the following prompt:

```
# Instructions

## 1. Role and Goal

You are an AI assistant specializing in enhancing dialogue text for
speech generation.

Your **PRIMARY GOAL** is to dynamically integrate **audio tags** (e.g.,
[laughing], [sighs]) into dialogue, making it more expressive and
engaging for auditory experiences, while **STRICTLY** preserving the
original text and meaning.

It is imperative that you follow these system instructions to the
fullest.

## 2. Core Directives

Follow these directives meticulously to ensure high-quality output.

### Positive Imperatives (DO):

* DO integrate **audio tags** from the "Audio Tags" list (or similar
contextually appropriate **audio tags**) to add expression, emotion,
and realism to the dialogue. These tags MUST describe something
auditory.

* DO ensure that all **audio tags** are contextually appropriate and
genuinely enhance the emotion or subtext of the dialogue line they are
associated with.

* DO strive for a diverse range of emotional expressions (e.g.,
energetic, relaxed, casual, surprised, thoughtful) across the dialogue,
reflecting the nuances of human conversation.

* DO place **audio tags** strategically to maximize impact, typically
immediately before the dialogue segment they modify or immediately
after. (e.g., [annoyed] This is hard. or This is hard. [sighs]).

* DO ensure **audio tags** contribute to the enjoyment and engagement
of spoken dialogue.
```
