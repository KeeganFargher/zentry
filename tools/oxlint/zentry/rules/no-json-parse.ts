import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

function isJsonParse(callee: ESTree.Expression): boolean {
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "JSON" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "parse"
  );
}

export const noJsonParseRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow JSON.parse; parse JSON text with `jsonText(schema)` so it is validated where it is read.",
    },
    messages: {
      jsonParse:
        "`JSON.parse` yields an unvalidated value. Use `jsonText(Schema).parse(text)` from @/shared/json, so the text is checked against a schema where it is read.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (isJsonParse(node.callee)) {
          context.report({ node, messageId: "jsonParse" });
        }
      },
    };
  },
});
