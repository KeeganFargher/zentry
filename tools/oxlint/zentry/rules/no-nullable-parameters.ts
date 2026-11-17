import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type Owner = ESTree.ArrowFunctionExpression | ESTree.Function;

function isAbsent(type: ESTree.TSType): boolean {
  if (type.type === "TSNullKeyword" || type.type === "TSUndefinedKeyword") {
    return true;
  }

  if (type.type === "TSParenthesizedType") {
    return isAbsent(type.typeAnnotation);
  }

  return type.type === "TSUnionType" && type.types.some(isAbsent);
}

function annotationOf(parameter: ESTree.ParamPattern): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return annotationOf(parameter.parameter);
  }

  if (parameter.type === "AssignmentPattern") {
    return null;
  }

  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation;
  }

  return parameter.typeAnnotation;
}

function isOptional(parameter: ESTree.ParamPattern): boolean {
  return "optional" in parameter && parameter.optional === true;
}

function nameOf(parameter: ESTree.ParamPattern): string {
  if (parameter.type === "Identifier") {
    return parameter.name;
  }

  return parameter.type === "TSParameterProperty" ? nameOf(parameter.parameter) : "parameter";
}

/**
 * A callback passed straight to another function gets its parameter types
 * from that function's signature (`String.replace`, `Array.find`), so it is
 * not ours to tighten.
 */
function isInlineCallback(node: Owner): boolean {
  const { parent } = node;

  return (
    (parent.type === "CallExpression" || parent.type === "NewExpression") &&
    parent.arguments.some((argument) => argument === node)
  );
}

function functionName(node: Owner): string | null {
  if (node.type !== "ArrowFunctionExpression" && node.id !== null) {
    return node.id.name;
  }

  const { parent } = node;

  return parent.type === "VariableDeclarator" && parent.id.type === "Identifier"
    ? parent.id.name
    : null;
}

/**
 * React hooks must be called on every render, so they cannot be skipped while
 * their input is still loading; taking `T | null` is how they wait for it.
 */
function isHook(node: Owner): boolean {
  return /^use[A-Z]/.test(functionName(node) ?? "");
}

export const noNullableParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow parameters that accept null or undefined; check for absence once, upstream, and pass a present value.",
    },
    messages: {
      nullable:
        "Parameter `{{parameter}}` accepts {{absent}}. Check for absence once where the value is produced, then call this with a present value.",
    },
  },
  createOnce(context) {
    const check = (node: Owner): void => {
      if (isInlineCallback(node) || isHook(node)) {
        return;
      }

      for (const parameter of node.params) {
        const annotation = annotationOf(parameter);
        const optional = isOptional(parameter);
        const nullable =
          annotation !== null && annotation !== undefined && isAbsent(annotation.typeAnnotation);

        if (optional || nullable) {
          context.report({
            node: parameter,
            messageId: "nullable",
            data: {
              parameter: nameOf(parameter),
              absent: optional ? "undefined" : "null or undefined",
            },
          });
        }
      }
    };

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    };
  },
});
