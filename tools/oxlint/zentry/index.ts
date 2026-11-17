// Zentry's own lint rules. They enforce one idea: data from outside is
// validated once, by a schema, where it enters the system, and every function
// past that point takes present, typed values. See DESIGN.md §16.6.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { noJsonParseRule } from "./rules/no-json-parse.ts";
import { noNullableParametersRule } from "./rules/no-nullable-parameters.ts";
import { zodOnlyAtBoundariesRule } from "./rules/zod-only-at-boundaries.ts";

const zentryPlugin = eslintCompatPlugin({
  meta: { name: "zentry" },
  rules: {
    "no-json-parse": noJsonParseRule,
    "no-nullable-parameters": noNullableParametersRule,
    "zod-only-at-boundaries": zodOnlyAtBoundariesRule,
  },
});

export default zentryPlugin;
