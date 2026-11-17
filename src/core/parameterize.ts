// Replaces the variable parts of a message so that "user 123 not found" and
// "user 456 not found" hash the same. Reduced from Sentry's
// grouping/parameterization.py. Rules apply in order; no placeholder contains
// a digit, so a later rule cannot re-match an earlier placeholder.

const RULES: [pattern: RegExp, placeholder: string][] = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
  [/\bhttps?:\/\/[^\s'"<>]+/g, "<url>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b(?:[0-9a-f]{40}|[0-9a-f]{32})\b/gi, "<hash>"],
  [
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
    "<date>",
  ],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "<ip>"],
  [/\b\d+(?:\.\d+)?(?:ms|s)\b/g, "<duration>"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b(?=[0-9a-f]*\d)(?=\d*[a-f])[0-9a-f]{8,}\b/gi, "<hex>"],
  [/-?\b\d+\.\d+\b/g, "<float>"],
  [/-?\b\d+\b/g, "<int>"],
];

const MAX_LENGTH = 1000;

export function firstLine(text: string): string {
  const end = text.indexOf("\n");

  return (end === -1 ? text : text.slice(0, end)).trim();
}

export function parameterize(text: string): string {
  let result = firstLine(text).slice(0, MAX_LENGTH);

  for (const [pattern, placeholder] of RULES) {
    result = result.replace(pattern, placeholder);
  }

  return result;
}
