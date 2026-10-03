/**
 * background-voice-tests.ts — `npm run test:background-voice`
 *
 * `BACKGROUND_VOICE_GUARD`: real calls 0ff17041 and 9673d446 (2026-10-01)
 * heard a video's "नमस्ते, मेरा नाम प्रीति है", renamed the caller or called it
 * a wrong number, and closed. The note tells the model not to act on such
 * a turn, and never to treat an answer to its own question as background.
 */

import assert from "node:assert/strict";

import { backgroundVoiceNote } from "../../core/session/system-prompt";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  [FAIL] ${name}\n         ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const labelled of [false, true]) {
  test(`A. ${labelled ? "labelled" : "general"} note forbids the four harms and is never spoken`, () => {
    const note = backgroundVoiceNote(labelled);
    assert.match(note, /^\[internal note, never speak/);
    for (const harm of ["new name", "wrong number", "switch language", "end the call"]) assert.ok(note.includes(harm), harm);
  });
  test(`B. ${labelled ? "labelled" : "general"} note keeps an answer to the agent's question as the caller's`, () => {
    const note = backgroundVoiceNote(labelled);
    assert.ok(note.includes("answers your last question"));
    assert.ok(/yes, no,\s+haan, nahi, okay, wait/.test(note));
  });
}

test("C. only the labelled note says the phone heard a different voice", () => {
  assert.ok(backgroundVoiceNote(true).includes("different voice"));
  assert.ok(!backgroundVoiceNote(false).includes("different voice"));
});

console.log(`\n${failures.length === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failures.length} failed`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(failures.length === 0 ? 0 : 1);
