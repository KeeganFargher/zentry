import { defineRule } from "@oxlint/plugins";

export const zodOnlyAtBoundariesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing zod outside the files that receive outside data; everything else works on what their schemas produced.",
    },
    messages: {
      zod: "Schemas belong where data enters the system (see the `zod-only-at-boundaries` exemptions in oxlint.config.ts). Validate there and pass the typed result in, instead of re-checking it here.",
    },
  },
  createOnce(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value === "zod" || node.source.value.startsWith("zod/")) {
          context.report({ node, messageId: "zod" });
        }
      },
    };
  },
});
