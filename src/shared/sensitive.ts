// Names that usually hold a credential, as Relay's default scrubbing rules
// list them. Event scrubbing (src/core/scrub.ts) filters their values, and an
// uptime target may not carry a query parameter with one (src/shared/uptime.ts).

const SENSITIVE_KEY =
  /password|passwd|secret|api[_-]?key|access[_-]?key|auth|credentials?|mysql_pwd|private[_-]?key|token|session|cookie|csrf|bearer/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}
