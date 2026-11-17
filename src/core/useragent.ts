// A deliberately small User-Agent parser: enough for the browser and OS tags.

export type AgentPart = { name: string; version: string | null };

export type Agent = { browser: AgentPart | null; os: AgentPart | null };

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
const BROWSERS: [name: string, pattern: RegExp][] = [
  ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ["Opera", /OPR\/([\d.]+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
  ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
  ["Safari", /Version\/([\d.]+).*Safari\//],
];

const SYSTEMS: [name: string, pattern: RegExp][] = [
  ["iOS", /(?:iPhone|iPad|iPod).*? OS ([\d_]+)/],
  ["Android", /Android ([\d.]+)/],
  ["Windows", /Windows NT ([\d.]+)/],
  ["macOS", /Mac OS X ([\d_.]+)/],
  ["Linux", /Linux()/],
];

function firstMatch(userAgent: string, candidates: [string, RegExp][]): AgentPart | null {
  for (const [name, pattern] of candidates) {
    const version = pattern.exec(userAgent)?.[1];

    if (version !== undefined) {
      return { name, version: version === "" ? null : version.replaceAll("_", ".") };
    }
  }

  return null;
}

/** What an absent User-Agent tells us. */
export const NO_AGENT: Agent = { browser: null, os: null };

export function parseUserAgent(userAgent: string): Agent {
  return { browser: firstMatch(userAgent, BROWSERS), os: firstMatch(userAgent, SYSTEMS) };
}

export function majorVersion(version: string): string {
  return version.replace(/\..*$/s, "");
}
