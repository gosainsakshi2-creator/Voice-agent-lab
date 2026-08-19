/**
 * phase2-tests.ts
 *
 * Phase 2 test suite: `npm run test:campaign`.
 *
 * Written against Node's built-in `assert` with a small runner rather
 * than a test framework, because the project has no test dependency
 * and Phase 2's brief was to add exactly two packages. It is still
 * automated in the way that matters: it exits non-zero on the first
 * failure, so it can gate a build.
 *
 * The database section runs inside a transaction that is always rolled
 * back. NOTHING in this file contacts a telephony, TTS, STT or LLM
 * provider.
 */

import assert from "node:assert/strict";

import { config as loadEnvFile } from "dotenv";

loadEnvFile({ path: ".env.local", quiet: true });
loadEnvFile({ quiet: true });

const { parseCsvText, CsvImportError, assertUploadAcceptable } = await import("../import/csv-parser");
const { suggestMapping, resolveMapping, MappingError } = await import("../import/column-mapper");
const { normalizePhone, maskPhone } = await import("../import/phone-normalizer");
const { validateRows } = await import("../import/validator");
const { allocateCounts, assignProviders, validateAllocation, AllocationError } = await import(
  "../import/provider-allocator"
);
const { getDbPool, closeDbPool } = await import("../db/client");
const { TEXT_TO_SPEECH_PROVIDER_IDS } = await import("../../constants/providers.constants");

const CARTESIA = TEXT_TO_SPEECH_PROVIDER_IDS.CARTESIA;
const SARVAM = TEXT_TO_SPEECH_PROVIDER_IDS.SARVAM;
const SMALLEST = TEXT_TO_SPEECH_PROVIDER_IDS.SMALLEST_AI;

const EVEN_SPLIT = { [CARTESIA]: 33.34, [SARVAM]: 33.33, [SMALLEST]: 33.33 } as const;

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}\n         ${message.split("\n")[0]}`);
    console.log(`  [FAIL] ${name}`);
    console.log(`         ${message.split("\n").slice(0, 3).join("\n         ")}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

const DEFAULT_MAPPING_OPTS = (headers: readonly string[], phone: string, name?: string) => ({
  headers,
  mapping: name ? { phone, name } : { phone },
  region: "IN",
  requireName: false,
});

// ─────────────────────────────────────────────────────────────────
section("CSV PARSING");

await test("1. parses headers and rows", async () => {
  const parsed = await parseCsvText("name,phone,city\nRahul,9876543210,Delhi\n");
  assert.deepEqual(parsed.headers, ["name", "phone", "city"]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]?.city, "Delhi");
});

await test("2. quoted fields with embedded commas survive intact", async () => {
  const parsed = await parseCsvText('name,phone,address\n"Sharma, Rahul",9876543210,"12, MG Road"\n');
  assert.equal(parsed.rows[0]?.name, "Sharma, Rahul");
  assert.equal(parsed.rows[0]?.address, "12, MG Road");
});

await test("2b. quoted field containing a newline is one row", async () => {
  const parsed = await parseCsvText('name,phone\n"Line one\nLine two",9876543210\n');
  assert.equal(parsed.rows.length, 1);
  assert.ok(parsed.rows[0]?.name?.includes("Line two"));
});

await test("2c. UTF-8 and a BOM are handled", async () => {
  const parsed = await parseCsvText("﻿name,phone\nप्रिया,9876543211\n");
  assert.deepEqual(parsed.headers, ["name", "phone"]);
  assert.equal(parsed.rows[0]?.name, "प्रिया");
});

await test("3. a ragged row does not abort the import", async () => {
  const parsed = await parseCsvText("name,phone,city\nA,9876543210\nB,9876543211,Delhi,extra\n");
  assert.equal(parsed.rows.length, 2, "both rows should survive");
  assert.equal(parsed.rows[0]?.city, "", "missing cell becomes empty string");
});

await test("3b. a file with no header row is rejected", async () => {
  await assert.rejects(() => parseCsvText(""), (e: unknown) => e instanceof CsvImportError);
});

await test("3c. oversized and non-CSV uploads are rejected before parsing", () => {
  assert.throws(
    () => assertUploadAcceptable({ name: "list.csv", size: 999_999_999, type: "text/csv" }),
    (e: unknown) => e instanceof CsvImportError && e.code === "FILE_TOO_LARGE",
  );
  assert.throws(
    () => assertUploadAcceptable({ name: "payload.exe", size: 10, type: "application/x-msdownload" }),
    (e: unknown) => e instanceof CsvImportError && e.code === "UNSUPPORTED_TYPE",
  );
  // A path-traversal filename must not slip through on its extension.
  assert.throws(
    () => assertUploadAcceptable({ name: "../../etc/passwd", size: 10, type: "text/csv" }),
    (e: unknown) => e instanceof CsvImportError && e.code === "UNSUPPORTED_TYPE",
  );
});

// ─────────────────────────────────────────────────────────────────
section("COLUMN MAPPING");

await test("4. missing phone mapping is an error, not a silent empty column", () => {
  assert.throws(() => resolveMapping(["name", "city"], {}), (e: unknown) => e instanceof MappingError);
  assert.throws(
    () => resolveMapping(["name", "city"], { phone: "not_a_column" }),
    (e: unknown) => e instanceof MappingError,
  );
});

await test("4b. header aliases are suggested, and unclaimed columns become metadata", () => {
  for (const header of ["phone", "mobile", "mobile_number", "phone_number", "contact_number"]) {
    assert.equal(suggestMapping(["name", header, "city"]).phone, header, `should detect ${header}`);
  }
  for (const header of ["name", "customer_name", "full_name"]) {
    assert.equal(suggestMapping([header, "phone"]).name, header, `should detect ${header}`);
  }
  const suggestion = suggestMapping(["name", "phone", "city", "customer_id", "language"]);
  assert.deepEqual([...suggestion.metadataColumns].sort(), ["city", "customer_id", "language"]);
});

// ─────────────────────────────────────────────────────────────────
section("PHONE VALIDATION AND NORMALIZATION");

await test("5. empty phone is MISSING_PHONE", () => {
  for (const value of ["", "   ", null, undefined]) {
    const result = normalizePhone(value, "IN");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "MISSING_PHONE");
  }
});

await test("6. invalid numbers are rejected rather than coerced", () => {
  for (const value of ["12345", "abcdefghij", "0000000000", "99999", "1234567890123456789"]) {
    const result = normalizePhone(value, "IN");
    assert.equal(result.ok, false, `"${value}" must not be accepted`);
  }
  // Excel scientific notation is unrecoverable and must not be guessed at.
  assert.equal(normalizePhone("9.87654E+11", "IN").ok, false);
});

await test("7 + 8. valid Indian numbers normalize to E.164 in every common shape", () => {
  const expected = "+919876543210";
  for (const input of [
    "9876543210",
    "09876543210",
    "+919876543210",
    "919876543210",
    "0091 9876543210",
    "+91 98765-43210",
    "  (91) 98765 43210  ",
  ]) {
    const result = normalizePhone(input, "IN");
    assert.equal(result.ok, true, `"${input}" should be valid`);
    assert.equal(result.ok === true && result.e164, expected, `"${input}" should normalize to ${expected}`);
  }
});

await test("8b. the original value is preserved alongside the normalized one", () => {
  const result = validateRows([{ name: "A", phone: "09876543210" }], {
    ...DEFAULT_MAPPING_OPTS(["name", "phone"], "phone", "name"),
  });
  assert.equal(result.valid[0]?.originalPhone, "09876543210");
  assert.equal(result.valid[0]?.normalizedPhone, "+919876543210");
});

await test("8c. phone numbers are masked for logs and error output", () => {
  assert.equal(maskPhone("+919876543210"), "+919876******");
  assert.ok(!maskPhone("+919876543210").includes("543210"));
});

// ─────────────────────────────────────────────────────────────────
section("VALIDATION AND DUPLICATES");

await test("9. duplicates inside one file are rejected, keeping the first occurrence", () => {
  const rows = [
    { phone: "9876543210", name: "First" },
    { phone: "9876543211", name: "Other" },
    { phone: "09876543210", name: "Duplicate of row 1" },
  ];
  const result = validateRows(rows, DEFAULT_MAPPING_OPTS(["phone", "name"], "phone", "name"));
  assert.equal(result.summary.validRows, 2);
  assert.equal(result.summary.duplicateRowsInFile, 1);
  const duplicate = result.rejected.find((r) => r.reason === "DUPLICATE_IN_FILE");
  assert.equal(duplicate?.duplicateOfRow, 1, "should point at the row it collides with");
  assert.ok(!JSON.stringify(result.rejected).includes("543210"), "rejections must be masked");
});

await test("9b. summary counts every rejection category separately", () => {
  const rows = [
    { phone: "9876543210", name: "ok" },
    { phone: "", name: "no phone" },
    { phone: "12345", name: "bad" },
    { phone: "", name: "" },
  ];
  const result = validateRows(rows, DEFAULT_MAPPING_OPTS(["phone", "name"], "phone", "name"));
  assert.equal(result.summary.totalRows, 4);
  assert.equal(result.summary.validRows, 1);
  assert.equal(result.summary.emptyPhoneRows, 1);
  assert.equal(result.summary.malformedPhoneRows, 1);
  assert.equal(result.summary.emptyRows, 1);
  assert.equal(result.summary.invalidRows, 3);
  assert.ok(result.rejected.every((r) => typeof r.message === "string" && r.message.length > 0));
});

await test("9c. unmapped columns are preserved as metadata", () => {
  const result = validateRows([{ name: "A", phone: "9876543210", city: "Delhi", customer_id: "C7" }], {
    ...DEFAULT_MAPPING_OPTS(["name", "phone", "city", "customer_id"], "phone", "name"),
  });
  assert.deepEqual(result.valid[0]?.metadata, { city: "Delhi", customer_id: "C7" });
});

await test("9d. name is required only when the script needs it", () => {
  const rows = [{ name: "", phone: "9876543210" }];
  const headers = ["name", "phone"];
  const optional = validateRows(rows, { headers, mapping: { phone: "phone", name: "name" }, region: "IN", requireName: false });
  assert.equal(optional.summary.validRows, 1);
  const required = validateRows(rows, { headers, mapping: { phone: "phone", name: "name" }, region: "IN", requireName: true });
  assert.equal(required.summary.validRows, 0);
  assert.equal(required.summary.missingNameRows, 1);
});

// ─────────────────────────────────────────────────────────────────
section("ALLOCATION");

await test("11. allocation percentages are validated", () => {
  assert.throws(() => validateAllocation({}), (e: unknown) => e instanceof AllocationError);
  assert.throws(
    () => validateAllocation({ [CARTESIA]: 50, [SARVAM]: 40 }),
    (e: unknown) => e instanceof AllocationError,
    "must reject a total below 100",
  );
  assert.throws(
    () => validateAllocation({ [CARTESIA]: 60, [SARVAM]: 60 }),
    (e: unknown) => e instanceof AllocationError,
    "must reject a total above 100",
  );
  assert.throws(
    () => validateAllocation({ [CARTESIA]: 110, [SARVAM]: -10 }),
    (e: unknown) => e instanceof AllocationError,
    "must reject a negative share",
  );
  assert.doesNotThrow(() => validateAllocation(EVEN_SPLIT));
  assert.doesNotThrow(() => validateAllocation({ [CARTESIA]: 100 }), "a single provider at 100% is valid");
});

await test("12 + 13. largest-remainder counts always sum to the total", () => {
  const cases: Array<[number, Record<string, number>]> = [
    [2000, EVEN_SPLIT],
    [2000, { [CARTESIA]: 33.3, [SARVAM]: 33.3, [SMALLEST]: 33.4 }],
    [10_000, { [CARTESIA]: 33.3, [SARVAM]: 33.3, [SMALLEST]: 33.4 }],
    [7, EVEN_SPLIT],
    [1, EVEN_SPLIT],
    [0, EVEN_SPLIT],
    [999, { [CARTESIA]: 50, [SARVAM]: 25, [SMALLEST]: 25 }],
    [1234, { [CARTESIA]: 10, [SARVAM]: 20, [SMALLEST]: 70 }],
  ];
  for (const [total, allocation] of cases) {
    const counts = allocateCounts(total, allocation);
    const sum = [...counts.values()].reduce((a, b) => a + b, 0);
    assert.equal(sum, total, `counts for ${total} must sum to ${total}, got ${sum}`);
  }
  // The specific figure from the brief.
  const twoThousand = allocateCounts(2000, { [CARTESIA]: 33.3, [SARVAM]: 33.3, [SMALLEST]: 33.4 });
  assert.deepEqual(
    [...twoThousand.entries()].sort().map(([, n]) => n).sort((a, b) => b - a),
    [668, 666, 666],
  );
});

await test("13b. independent rounding would have been wrong — largest-remainder is not", () => {
  // 50/25/25 of 10 is 5 / 2.5 / 2.5. Rounding each share on its own
  // gives 5 + 3 + 3 = 11 contacts out of a list of 10 — one contact
  // that does not exist, handed to a provider to dial.
  const allocation = { [CARTESIA]: 50, [SARVAM]: 25, [SMALLEST]: 25 };
  const naive = Object.values(allocation).reduce((sum, pct) => sum + Math.round((10 * pct) / 100), 0);
  assert.equal(naive, 11, "the naive approach is expected to overshoot here");

  const exact = [...allocateCounts(10, allocation).values()].reduce((a, b) => a + b, 0);
  assert.equal(exact, 10, "largest-remainder must land on the real total");

  // And the mirror case, where naive rounding loses a contact instead
  // of inventing one: 1/3 each of 100 rounds down three times to 99.
  const thirds = { [CARTESIA]: 100 / 3, [SARVAM]: 100 / 3, [SMALLEST]: 100 / 3 };
  const naiveThirds = Object.values(thirds).reduce((sum, pct) => sum + Math.floor((100 * pct) / 100), 0);
  assert.equal(naiveThirds, 99, "the naive approach is expected to undershoot here");
  assert.equal([...allocateCounts(100, thirds).values()].reduce((a, b) => a + b, 0), 100);
});

await test("14. assignment is deterministic across runs and input orderings", () => {
  const contacts = Array.from({ length: 500 }, (_, i) => ({
    normalizedPhone: `+9198765${String(10000 + i).padStart(5, "0")}`,
  }));
  const first = assignProviders(contacts, EVEN_SPLIT);
  const second = assignProviders(contacts, EVEN_SPLIT);
  const shuffled = assignProviders([...contacts].reverse(), EVEN_SPLIT);

  for (const contact of contacts) {
    const a = first.get(contact.normalizedPhone);
    assert.equal(second.get(contact.normalizedPhone), a, "repeat run must match");
    assert.equal(shuffled.get(contact.normalizedPhone), a, "input order must not matter");
  }
});

await test("15. every contact gets exactly one provider, and counts match the targets", () => {
  const contacts = Array.from({ length: 2000 }, (_, i) => ({
    normalizedPhone: `+9198765${String(10000 + i).padStart(5, "0")}`,
  }));
  const assignments = assignProviders(contacts, EVEN_SPLIT);
  assert.equal(assignments.size, contacts.length, "no contact may be missing or doubled");

  const counts = new Map<string, number>();
  for (const provider of assignments.values()) counts.set(provider, (counts.get(provider) ?? 0) + 1);
  const targets = allocateCounts(contacts.length, EVEN_SPLIT);
  for (const [provider, target] of targets) {
    assert.equal(counts.get(provider) ?? 0, target, `${provider} should have exactly ${target}`);
  }
});

await test("15b. providers are interleaved, not run in blocks", () => {
  const contacts = Array.from({ length: 300 }, (_, i) => ({
    normalizedPhone: `+9198765${String(20000 + i).padStart(5, "0")}`,
  }));
  const assignments = assignProviders(contacts, EVEN_SPLIT);

  // Walk the deterministic assignment order and measure the longest
  // run of one provider. Block allocation would produce a run of ~100.
  const sequence = [...assignments.values()];
  let longestRun = 1;
  let currentRun = 1;
  for (let i = 1; i < sequence.length; i += 1) {
    currentRun = sequence[i] === sequence[i - 1] ? currentRun + 1 : 1;
    longestRun = Math.max(longestRun, currentRun);
  }
  assert.ok(longestRun <= 3, `longest single-provider run was ${longestRun}; expected an interleaved sequence`);
});

await test("16. works for arbitrary counts, including awkward ones", () => {
  for (const n of [0, 1, 2, 3, 7, 13, 99, 101, 1001]) {
    const contacts = Array.from({ length: n }, (_, i) => ({ normalizedPhone: `+9199${String(i).padStart(8, "0")}` }));
    const assignments = assignProviders(contacts, EVEN_SPLIT);
    assert.equal(assignments.size, n, `n=${n} must assign every contact`);
  }
  // A single provider at 100% takes everything.
  const solo = assignProviders(
    Array.from({ length: 50 }, (_, i) => ({ normalizedPhone: `+9188${String(i).padStart(8, "0")}` })),
    { [SARVAM]: 100 },
  );
  assert.ok([...solo.values()].every((p) => p === SARVAM));
});

// ─────────────────────────────────────────────────────────────────
section("SCALE CHECK — sum(provider_counts) === total_contacts");

const SCALE_SIZES = [10, 50, 100, 500, 2000, 10_000];
const scaleTable: Array<{ size: number; counts: Record<string, number>; sum: number }> = [];

await test("20. allocation is exact at 10 / 50 / 100 / 500 / 2,000 / 10,000", () => {
  for (const size of SCALE_SIZES) {
    const contacts = Array.from({ length: size }, (_, i) => ({
      normalizedPhone: `+9197${String(i).padStart(8, "0")}`,
    }));
    const assignments = assignProviders(contacts, EVEN_SPLIT);
    assert.equal(assignments.size, size, `n=${size}: every contact must be assigned`);

    const counts: Record<string, number> = {};
    for (const provider of assignments.values()) counts[provider] = (counts[provider] ?? 0) + 1;
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, size, `n=${size}: counts summed to ${sum}`);

    const targets = allocateCounts(size, EVEN_SPLIT);
    for (const [provider, target] of targets) {
      assert.equal(counts[provider] ?? 0, target, `n=${size}: ${provider} should be ${target}`);
    }
    scaleTable.push({ size, counts, sum });
  }
});

// ─────────────────────────────────────────────────────────────────
section("DATABASE GUARANTEES (transaction is rolled back)");

const client = await getDbPool().connect();
try {
  await client.query("BEGIN");

  const campaign = await client.query<{ id: string }>(
    `INSERT INTO campaigns (name, campaign_type, script_id, script_version, script_hash,
                            provider_allocation, telephony_provider, language, idempotency_key)
     VALUES ('__phase2__', 'registration', 'registration', 'v1-placeholder', 'test',
             $1::jsonb, 'vobiz', 'en', 'phase2-test-key')
     RETURNING id`,
    [JSON.stringify(EVEN_SPLIT)],
  );
  const campaignId = campaign.rows[0]?.id;
  assert.ok(campaignId);

  await test("10 + 17. re-importing the same number inserts nothing the second time", async () => {
    const insert = async () =>
      client.query(
        `INSERT INTO contacts (campaign_id, normalized_phone, original_phone, assigned_provider)
         VALUES ($1, '+919876543210', '9876543210', $2)
         ON CONFLICT (campaign_id, normalized_phone) DO NOTHING
         RETURNING id`,
        [campaignId, CARTESIA],
      );
    assert.equal((await insert()).rowCount, 1, "first import inserts");
    assert.equal((await insert()).rowCount, 0, "second import must insert nothing");
    // Even when the second import would have chosen a different provider.
    const other = await client.query(
      `INSERT INTO contacts (campaign_id, normalized_phone, original_phone, assigned_provider)
       VALUES ($1, '+919876543210', '9876543210', $2)
       ON CONFLICT (campaign_id, normalized_phone) DO NOTHING
       RETURNING id`,
      [campaignId, SARVAM],
    );
    assert.equal(other.rowCount, 0, "a re-import must never reassign the provider");
  });

  await test("18. provider immutability is still enforced by PostgreSQL", async () => {
    await client.query("SAVEPOINT immut");
    await assert.rejects(
      () =>
        client.query("UPDATE contacts SET assigned_provider = $1 WHERE campaign_id = $2", [
          SARVAM,
          campaignId,
        ]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT immut");
  });

  await test("18b. campaign idempotency key still prevents a duplicate campaign", async () => {
    await client.query("SAVEPOINT idem");
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO campaigns (name, campaign_type, script_id, script_version, script_hash,
                                  provider_allocation, telephony_provider, language, idempotency_key)
           VALUES ('__phase2_dup__', 'registration', 'registration', 'v1-placeholder', 'test',
                   '{}'::jsonb, 'vobiz', 'en', 'phase2-test-key')`,
        ),
      (error: unknown) => (error as { code?: string }).code === "23505",
    );
    await client.query("ROLLBACK TO SAVEPOINT idem");
  });

  await client.query("ROLLBACK");
} finally {
  client.release();
  await closeDbPool();
}

// ─────────────────────────────────────────────────────────────────
console.log("");
console.log("SCALE TABLE");
for (const row of scaleTable) {
  const detail = Object.entries(row.counts)
    .sort()
    .map(([provider, n]) => `${provider}=${n}`)
    .join("  ");
  const ok = row.sum === row.size ? "OK " : "BAD";
  console.log(`  ${ok} n=${String(row.size).padStart(6)}  ${detail}  sum=${row.sum}`);
}

console.log("");
console.log("=".repeat(48));
console.log(`${passed}/${passed + failures.length} checks passed`);
if (failures.length > 0) {
  console.error("");
  console.error("FAILURES:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("No provider, telephony, TTS, STT or LLM request was made.");
process.exit(0);
