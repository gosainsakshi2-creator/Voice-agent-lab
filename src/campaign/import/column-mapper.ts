/**
 * column-mapper.ts
 *
 * Suggests which CSV column is the phone number, the name, and the
 * call type — and never decides. Header naming varies per source list,
 * so a wrong guess made silently would import a whole campaign against
 * the wrong column. Everything here produces a *suggestion* the user
 * confirms or overrides in the UI; `resolveMapping` is what the
 * importer actually obeys.
 */

export interface ColumnMapping {
  /** Required. */
  readonly phone: string;
  readonly name?: string;
  readonly callType?: string;
}

export interface MappingSuggestion {
  readonly headers: readonly string[];
  readonly phone: string | undefined;
  readonly name: string | undefined;
  readonly callType: string | undefined;
  /** Headers that would be preserved as metadata under the suggestion. */
  readonly metadataColumns: readonly string[];
}

/** "Mobile Number " and "mobile_number" must compare equal. */
function canonical(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Ordered by confidence: an exact "phone" beats an incidental "number".
const PHONE_CANDIDATES = [
  "phonenumber",
  "phone",
  "mobilenumber",
  "mobile",
  "contactnumber",
  "contactno",
  "phoneno",
  "mobileno",
  "msisdn",
  "cellphone",
  "cell",
  "whatsapp",
  "whatsappnumber",
  "telephone",
  "tel",
  "number",
  "contact",
];

const NAME_CANDIDATES = [
  "customername",
  "fullname",
  "name",
  "contactname",
  "firstname",
  "leadname",
  "customer",
];

const CALL_TYPE_CANDIDATES = ["calltype", "campaigntype", "type", "category"];

function firstMatch(headers: readonly string[], candidates: readonly string[]): string | undefined {
  const byCanonical = new Map(headers.map((h) => [canonical(h), h]));
  for (const candidate of candidates) {
    const hit = byCanonical.get(candidate);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function suggestMapping(headers: readonly string[]): MappingSuggestion {
  const phone = firstMatch(headers, PHONE_CANDIDATES);
  const name = firstMatch(headers, NAME_CANDIDATES);
  const callType = firstMatch(headers, CALL_TYPE_CANDIDATES);

  const claimed = new Set([phone, name, callType].filter((h): h is string => h !== undefined));
  return {
    headers,
    phone,
    name,
    callType,
    metadataColumns: headers.filter((h) => !claimed.has(h)),
  };
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

/**
 * Validates a user-supplied mapping against the file's actual headers.
 * A mapping that names a column the file does not have is an error,
 * not a silently-empty field.
 */
export function resolveMapping(
  headers: readonly string[],
  requested: Partial<ColumnMapping>,
): ColumnMapping {
  const known = new Set(headers);

  if (!requested.phone) {
    throw new MappingError("A phone column must be selected before importing.");
  }
  if (!known.has(requested.phone)) {
    throw new MappingError(`The file has no column named "${requested.phone}".`);
  }
  if (requested.name !== undefined && requested.name !== "" && !known.has(requested.name)) {
    throw new MappingError(`The file has no column named "${requested.name}".`);
  }
  if (requested.callType !== undefined && requested.callType !== "" && !known.has(requested.callType)) {
    throw new MappingError(`The file has no column named "${requested.callType}".`);
  }

  return {
    phone: requested.phone,
    ...(requested.name ? { name: requested.name } : {}),
    ...(requested.callType ? { callType: requested.callType } : {}),
  };
}

/**
 * Every column not claimed by the mapping. These are preserved into
 * `contacts.metadata` — an unexpected column is never dropped.
 */
export function metadataColumnsFor(
  headers: readonly string[],
  mapping: ColumnMapping,
): readonly string[] {
  const claimed = new Set([mapping.phone, mapping.name, mapping.callType].filter(Boolean) as string[]);
  return headers.filter((header) => !claimed.has(header));
}
