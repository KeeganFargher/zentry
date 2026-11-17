import { defineConfig } from "oxlint";

// Domain boundaries. See DESIGN.md §16.3 before changing any of this.
const DOMAINS = ["shared", "core", "db", "blobs", "ingest", "consumer", "api", "cron"];

type Pattern = { group: string[]; message: string };

const forbid = (...domains: string[]): ["error", { patterns: Pattern[] }] => [
  "error",
  {
    patterns: [
      { group: ["../*", "../**/*"], message: "Use the @/ alias for imports outside this folder." },
      ...domains.map((domain) => ({
        group: [`@/${domain}`, `@/${domain}/**`],
        message: `This folder may not import from ${domain}/. See DESIGN.md §16.3.`,
      })),
    ],
  },
];

const except = (...allowed: string[]): ["error", { patterns: Pattern[] }] =>
  forbid(...DOMAINS.filter((domain) => !allowed.includes(domain)));

export default defineConfig({
  plugins: ["typescript", "import", "unicorn", "oxc", "promise", "vitest", "react"],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  options: { typeAware: true },
  categories: { correctness: "error", suspicious: "error", perf: "error" },
  ignorePatterns: [
    "ui/dist/**",
    "tools/oxlint/anti-slop/**",
    ".wrangler/**",
    ".claude/**",
    "worker-configuration.d.ts",
  ],
  rules: {
    // ── Boundaries ──────────────────────────────────────────────
    "import/no-cycle": "error",
    "import/no-default-export": "error",
    "no-restricted-imports": forbid(),

    // ── Types ───────────────────────────────────────────────────
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/explicit-module-boundary-types": "error",

    // ── Size and shape ──────────────────────────────────────────
    "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
    "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
    "max-depth": ["error", 3],
    "max-params": ["error", 3],
    complexity: ["error", 10],

    // ── Hygiene ─────────────────────────────────────────────────
    eqeqeq: "error",
    "no-console": "error",
    "no-param-reassign": "error",
    "oxc/no-accumulating-spread": "error",
    // Sequential awaits are deliberate here: bounded R2 concurrency, chunked
    // deletes, and time-boxed retention loops.
    "no-await-in-loop": "off",
    // The UI uses the automatic JSX runtime, which needs no React import.
    "react/react-in-jsx-scope": "off",

    // ── anti-slop: every generic rule ───────────────────────────
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    { files: ["src/shared/**"], rules: { "no-restricted-imports": except() } },
    { files: ["src/core/**"], rules: { "no-restricted-imports": except("shared") } },
    { files: ["src/db/**"], rules: { "no-restricted-imports": except("shared") } },
    { files: ["src/blobs/**"], rules: { "no-restricted-imports": except("shared") } },
    {
      files: ["src/ingest/**"],
      rules: { "no-restricted-imports": except("shared", "core", "db") },
    },
    {
      files: ["src/consumer/**"],
      rules: { "no-restricted-imports": except("shared", "core", "db", "blobs") },
    },
    { files: ["src/api/**"], rules: { "no-restricted-imports": except("shared", "db", "blobs") } },
    { files: ["src/cron/**"], rules: { "no-restricted-imports": except("shared", "db", "blobs") } },
    { files: ["ui/**"], rules: { "no-restricted-imports": except() } },

    // Named exemptions. Each is one file or one folder, with the reason.
    {
      // The single place untrusted JSON is narrowed into typed values.
      files: ["src/shared/json.ts"],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
    {
      // The UI's JSON viewer has to tell strings, numbers, lists and objects apart.
      files: ["ui/src/lib/json.ts"],
      rules: { "anti-slop/no-runtime-typeof": "off" },
    },
    {
      // The UI's API client and the e2e helpers assert that responses match the shared contract.
      files: ["ui/src/lib/api.ts", "e2e/support.ts"],
      rules: { "typescript/no-unsafe-type-assertion": "off" },
    },
    {
      // The logger is the one module allowed to write to the console.
      files: ["src/shared/log.ts"],
      rules: { "no-console": "off" },
    },
    {
      // SQL is long; statements are kept whole rather than split to fit a line count.
      files: ["src/db/**"],
      rules: { "max-lines-per-function": "off" },
    },
    {
      // Workers, Vite, Vitest, Playwright and oxlint require a default export in these files.
      files: [
        "src/worker.ts",
        "ui/vite.config.ts",
        "vitest.config.ts",
        "oxlint.config.ts",
        "e2e/playwright.config.ts",
      ],
      rules: { "import/no-default-export": "off" },
    },
    {
      // Test suites are long by nature, and small helpers read best next to their test.
      files: ["test/**", "e2e/**"],
      rules: {
        "max-lines-per-function": "off",
        "max-lines": "off",
        "unicorn/consistent-function-scoping": "off",
      },
    },
  ],
});
