const HEX_32 = /^[0-9a-f]{32}$/;

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newEventId(): string {
  return randomHex(16);
}

export function newPublicKey(): string {
  return randomHex(16);
}

/** Lower-cases and strips dashes; null when the result is not 32 hex characters. */
export function normalizeEventId(raw: string): string | null {
  const id = raw.replaceAll("-", "").toLowerCase();

  return HEX_32.test(id) ? id : null;
}

export function isPublicKey(text: string): boolean {
  return HEX_32.test(text);
}

/** Parses a decimal id such as a project id; null when it is not a positive integer. */
export function parseId(text: string): number | null {
  if (!/^[0-9]{1,15}$/.test(text)) {
    return null;
  }

  const id = Number(text);

  return id > 0 ? id : null;
}
