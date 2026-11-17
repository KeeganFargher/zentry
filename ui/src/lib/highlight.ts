// A small, forgiving syntax colourer for source context lines. It knows
// comments, strings, numbers and common keywords across languages, which is
// most of what makes a few lines of code readable at a glance.

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";

export type Token = [kind: TokenKind, text: string];

const KEYWORDS = [
  "abstract",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "del",
  "do",
  "elif",
  "else",
  "end",
  "enum",
  "except",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "fn",
  "for",
  "from",
  "func",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "is",
  "lambda",
  "let",
  "module",
  "namespace",
  "new",
  "nil",
  "None",
  "not",
  "null",
  "or",
  "and",
  "package",
  "pass",
  "private",
  "protected",
  "public",
  "raise",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "throws",
  "true",
  "True",
  "False",
  "try",
  "type",
  "typeof",
  "undefined",
  "using",
  "var",
  "void",
  "while",
  "with",
  "yield",
];

const HASH_COMMENTS = new Set(["py", "rb", "sh", "pl", "r", "yml", "yaml", "ex", "exs"]);

const STRINGS = String.raw`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\`(?:[^\`\\]|\\.)*\`?`;
const NUMBERS = String.raw`\b\d+(?:\.\d+)?\b`;
const WORDS = String.raw`\b(?:${KEYWORDS.join("|")})\b`;

function patternFor(filename: string | null): RegExp {
  const extension = filename?.split(".").at(-1)?.toLowerCase() ?? "";
  const comment = HASH_COMMENTS.has(extension) ? "#.*$" : String.raw`//.*$|/\*.*?(?:\*/|$)`;

  return new RegExp(`(${comment})|(${STRINGS})|(${NUMBERS})|(${WORDS})`, "g");
}

function kindOf(match: RegExpExecArray): TokenKind {
  if (match[1] !== undefined) {
    return "comment";
  }

  if (match[2] !== undefined) {
    return "string";
  }

  return match[3] === undefined ? "keyword" : "number";
}

/** Splits one line into coloured runs. */
export function highlight(line: string, filename: string | null): Token[] {
  const tokens: Token[] = [];
  let last = 0;

  for (const match of line.matchAll(patternFor(filename))) {
    if (match.index > last) {
      tokens.push(["plain", line.slice(last, match.index)]);
    }

    tokens.push([kindOf(match), match[0]]);
    last = match.index + match[0].length;
  }

  if (last < line.length) {
    tokens.push(["plain", line.slice(last)]);
  }

  return tokens;
}
