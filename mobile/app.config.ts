/// <reference types="node" />

// The parts of the app's config that depend on the machine building it. The
// rest is static, in app.json.

import { existsSync } from "node:fs";

import type { ConfigContext, ExpoConfig } from "expo/config";

// FCM, and so push, needs the Firebase project's google-services.json
// (mobile/README.md, Push). It holds that project's ids, so it is not
// committed; a build without it still works, and Settings then says push
// cannot register.
const GOOGLE_SERVICES = "./google-services.json";

// ZENTRY_ALLOW_HTTP=1 lets a build reach a local `pnpm dev` over plain http,
// such as http://10.0.2.2:8787 from the emulator. Builds for real use leave it
// off, so the device token never travels unencrypted.
const allowHttp = process.env["ZENTRY_ALLOW_HTTP"] === "1";

// The release workflow (.github/workflows/mobile-release.yml) sets this to its
// run number: Android installs an APK over the previous one only when its
// versionCode is higher. Local builds keep app.json's.
const versionCode = process.env["ZENTRY_VERSION_CODE"];

export default ({ config }: ConfigContext): ExpoConfig => {
  const android = { ...config.android };

  if (existsSync(GOOGLE_SERVICES)) {
    android.googleServicesFile = GOOGLE_SERVICES;
  }

  if (versionCode !== undefined) {
    const code = Number(versionCode);

    if (!Number.isInteger(code) || code < 1) {
      throw new Error(`ZENTRY_VERSION_CODE must be a positive integer, not "${versionCode}"`);
    }

    android.versionCode = code;
  }

  return {
    ...config,
    // Read by the app at runtime, so it refuses an http sign-in link when the
    // build would not allow the traffic anyway (src/screens/pair.tsx).
    extra: { ...config.extra, allowHttp },
    name: "Zentry",
    slug: "zentry",
    android,
    plugins: [
      ...(config.plugins ?? []),
      ["expo-build-properties", { android: { usesCleartextTraffic: allowHttp } }],
    ],
  };
};
