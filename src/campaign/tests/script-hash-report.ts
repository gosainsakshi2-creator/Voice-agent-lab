/**
 * script-hash-report.ts — prints every registered script with the
 * content hash the campaign layer pins. Run after installing or
 * revising an approved script to record the new hash.
 */
const { listScripts, describeScript, defaultScriptFor } = await import("../script/script-registry");

for (const script of listScripts()) {
  const d = describeScript(script);
  console.log(
    `${d.id.padEnd(13)} ${d.version.padEnd(4)} hash=${d.hash} vars=[${d.variables.join(",")}] placeholder=${d.isPlaceholder}`,
  );
}
console.log("");
console.log("default(registration) =", defaultScriptFor("registration").version);
console.log("default(reminder)     =", defaultScriptFor("reminder").version);

export {};
