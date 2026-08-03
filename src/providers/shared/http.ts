/**
 * http.ts (providers/shared)
 *
 * Minimal fetch wrapper for the vendors in this Provider Layer that
 * do not publish an official Node.js SDK (Sarvam AI, Smallest AI),
 * per the task's fallback rule: "If no official SDK exists, use the
 * provider's official REST API." Centralizes error normalization so
 * every REST-based adapter reports failures consistently.
 */

export class ProviderHttpError extends Error {
  constructor(
    readonly providerId: string,
    readonly status: number,
    readonly statusText: string,
    bodyText: string,
  ) {
    super(`${providerId} REST call failed: ${status} ${statusText} — ${bodyText.slice(0, 500)}`);
    this.name = "ProviderHttpError";
  }
}

/**
 * POST a JSON body and return the parsed JSON response.
 */
export async function postJson<TResponse>(
  providerId: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<TResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw new ProviderHttpError(providerId, response.status, response.statusText, bodyText);
  }

  return (await response.json()) as TResponse;
}

/**
 * POST a JSON body and return the raw binary response (used by
 * vendors that respond with audio bytes directly rather than a
 * base64-encoded JSON envelope).
 */
export async function postJsonForBinary(
  providerId: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw new ProviderHttpError(providerId, response.status, response.statusText, bodyText);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * GET a URL and discard the body — used purely for `checkHealth`
 * probes against REST-only vendors.
 */
export async function getOk(providerId: string, url: string, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw new ProviderHttpError(providerId, response.status, response.statusText, bodyText);
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}
