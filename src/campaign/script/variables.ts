/**
 * variables.ts
 *
 * `{{name}}` interpolation for campaign scripts.
 *
 * A plain string scan with a fixed allow-list — no `eval`, no `new
 * Function`, no template-engine dependency. Script text and contact
 * names both originate outside the codebase, so the substitution must
 * not be able to execute anything.
 *
 * A missing value is an error, never an empty string. "Hi , this is
 * Ishita" is worse than a call that never happens: it is a real call,
 * to a real person, that immediately signals a broken robot.
 */

/** Variables the campaign layer knows how to supply. Extend here and in `buildVariables`. */
export const SUPPORTED_SCRIPT_VARIABLES = ["customer_name", "agent_name"] as const;

export type ScriptVariableName = (typeof SUPPORTED_SCRIPT_VARIABLES)[number];

export type ScriptVariables = Readonly<Partial<Record<ScriptVariableName, string>>>;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export class ScriptVariableError extends Error {
  constructor(
    message: string,
    readonly missing: readonly string[] = [],
    readonly unknown: readonly string[] = [],
  ) {
    super(message);
    this.name = "ScriptVariableError";
  }
}

/** Every distinct placeholder a piece of script text asks for. */
export function extractVariables(template: string): readonly string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name) found.add(name.toLowerCase());
  }
  return [...found].sort();
}

function isSupported(name: string): name is ScriptVariableName {
  return (SUPPORTED_SCRIPT_VARIABLES as readonly string[]).includes(name);
}

/**
 * Reports any placeholder the layer cannot supply. Called at script
 * registration time, so a typo like `{{customer_nam}}` is caught when
 * the script is written rather than when a campaign runs.
 */
export function findUnsupportedVariables(template: string): readonly string[] {
  return extractVariables(template).filter((name) => !isSupported(name));
}

/**
 * Substitutes every placeholder, or throws naming exactly what was
 * missing. Never partially interpolates: a script with one unresolved
 * variable is not usable, so the caller gets an error instead of a
 * half-filled string it might pass on unnoticed.
 */
export function interpolate(template: string, variables: ScriptVariables): string {
  const required = extractVariables(template);

  const unknown = required.filter((name) => !isSupported(name));
  const missing = required.filter((name) => {
    if (!isSupported(name)) return false;
    const value = variables[name];
    return value === undefined || value.trim().length === 0;
  });

  if (unknown.length > 0 || missing.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing value(s) for ${missing.map((n) => `{{${n}}}`).join(", ")}`);
    if (unknown.length > 0) {
      parts.push(
        `unknown variable(s) ${unknown.map((n) => `{{${n}}}`).join(", ")} — supported: ${SUPPORTED_SCRIPT_VARIABLES.join(", ")}`,
      );
    }
    throw new ScriptVariableError(`Script cannot be prepared: ${parts.join("; ")}.`, missing, unknown);
  }

  return template.replace(PLACEHOLDER_PATTERN, (_match, rawName: string) => {
    const name = rawName.toLowerCase();
    // Guarded above; the fallback is unreachable and exists only so
    // the replacer has no way to emit "undefined" into spoken text.
    return isSupported(name) ? (variables[name] ?? "") : "";
  });
}
