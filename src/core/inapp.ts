// The default in-app rule, for frames whose SDK did not say. A reduced form of
// Sentry's built-in stack-trace rules (about 550 there): the runtime and
// framework code of each platform, matched by path, module or function.

import type { StoredFrame } from "@/shared/contract";

const PATH_MARKERS = [
  // Node, Python, Ruby, Go, PHP
  "node_modules/",
  "site-packages/",
  "dist-packages/",
  "/usr/lib/",
  "/lib/python",
  "vendor/bundle/",
  "/gems/",
  "/go/pkg/mod/",
  "/usr/local/go/",
  "/vendor/",
  "<frozen ",
  "node:internal",
  // Apple
  "/System/Library/",
  "/usr/lib/system/",
  "/Library/Developer/CoreSimulator/",
  // Dart and Flutter
  "dart:",
  "package:flutter/",
  // Rust
  "/rustc/",
  ".cargo/registry/",
];

const MODULE_PREFIXES = [
  // Java, Kotlin, Android
  "java.",
  "javax.",
  "jdk.",
  "sun.",
  "com.sun.",
  "kotlin.",
  "kotlinx.",
  "scala.",
  "android.",
  "androidx.",
  "com.android.",
  "com.google.android.",
  "dalvik.",
  "libcore.",
  "org.springframework.",
  "org.apache.",
  "org.hibernate.",
  "org.eclipse.jetty.",
  "org.jboss.",
  "org.junit.",
  "io.netty.",
  "io.undertow.",
  "reactor.",
  "com.zaxxer.",
  "com.fasterxml.",
  // .NET
  "System.",
  "Microsoft.",
  "Newtonsoft.",
  // Apple
  "libsystem_",
  "libdispatch",
  "libobjc",
  // Rust
  "std::",
  "core::",
  "alloc::",
  "tokio::",
  "backtrace::",
];

const MODULE_NAMES = new Set([
  "CoreFoundation",
  "Foundation",
  "UIKit",
  "UIKitCore",
  "SwiftUI",
  "AppKit",
]);

const FUNCTION_PATTERN = /^(?:runtime\.[a-z]|net\/http\.|testing\.|std::|core::|tokio::)/;

function listed(value: string | null, prefixes: string[]): boolean {
  return value !== null && prefixes.some((prefix) => value.startsWith(prefix));
}

/** True for platform and framework code. SDK flags are applied before this. */
export function looksLikeLibrary(
  frame: Pick<StoredFrame, "absPath" | "filename" | "module" | "function">,
): boolean {
  const path = frame.absPath ?? frame.filename ?? "";

  return (
    PATH_MARKERS.some((marker) => path.includes(marker)) ||
    listed(frame.module, MODULE_PREFIXES) ||
    (frame.module !== null && MODULE_NAMES.has(frame.module)) ||
    (frame.function !== null && FUNCTION_PATTERN.test(frame.function))
  );
}
