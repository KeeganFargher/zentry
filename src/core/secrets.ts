// Secrets that can sit inside free text, found by shape rather than by key:
// card numbers, IBANs, PEM private keys, credentials in URLs and bearer
// tokens. A reduced form of Relay's `@creditcard`, `@iban`, `@pemkey`,
// `@urlauth` and `@bearer` rules.

export const FILTERED = "[Filtered]";

const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const CARD_PREFIX = /^(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})$/;
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi;

// A token needs a digit or punctuation, so the sentence "Bearer authentication" survives.
const BEARER = /\b(bearer\s+)(?=[\w.~+/=-]*[\d._~+/=])[\w.~+/=-]{8,}/gi;
const IBAN_LENGTH = { min: 15, max: 34 };

function passesLuhn(digits: string): boolean {
  let sum = 0;

  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index]);
    const doubled = index % 2 === 1 ? digit * 2 : digit;

    sum += doubled > 9 ? doubled - 9 : doubled;
  }

  return sum % 10 === 0;
}

function isCardNumber(candidate: string): boolean {
  const digits = candidate.replaceAll(/[ -]/g, "");

  return CARD_PREFIX.test(digits) && passesLuhn(digits);
}

/** ISO 13616: move the first four characters to the end; the number mod 97 must be 1. */
function isIban(candidate: string): boolean {
  const compact = candidate.replaceAll(" ", "");

  if (compact.length < IBAN_LENGTH.min || compact.length > IBAN_LENGTH.max) {
    return false;
  }

  let remainder = 0;

  for (const char of `${compact.slice(4)}${compact.slice(0, 4)}`) {
    const value = Number.parseInt(char, 36);

    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }

  return remainder === 1;
}

export function scrubSecrets(text: string): string {
  return text
    .replace(PEM_KEY, FILTERED)
    .replace(URL_CREDENTIALS, `$1${FILTERED}:${FILTERED}@`)
    .replace(BEARER, `$1${FILTERED}`)
    .replace(IBAN_CANDIDATE, (candidate) => (isIban(candidate) ? FILTERED : candidate))
    .replace(CARD_CANDIDATE, (candidate) => (isCardNumber(candidate) ? FILTERED : candidate));
}
