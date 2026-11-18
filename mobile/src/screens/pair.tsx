// Signing this phone in: scan the QR code the web UI shows under Settings,
// Mobile app, or paste its link. The link carries where to call and a
// ten-minute, single-use code, which is traded for this phone's own token.
// DESIGN.md §19.

import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import { useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Panel } from "~/components/basics";
import { Button } from "~/components/button";
import { Text } from "~/components/text";
import { pair } from "~/lib/api";
import { usePalette } from "~/lib/preferences";
import { useSession } from "~/lib/session";
import { FONTS, RADIUS, SPACE } from "~/lib/theme";

type Pairing = { apiUrl: string; code: string };

const ALLOW_HTTP = Constants.expoConfig?.extra?.["allowHttp"] === true;

type ReadLink = { ok: true; pairing: Pairing } | { ok: false; error: string };

/** The parts of a `zentry://pair?url=…&code=…` link, or why it is not one. */
function readLink(link: string): ReadLink {
  const parsed = Linking.parse(link.trim());
  const url = parsed.queryParams?.["url"];
  const code = parsed.queryParams?.["code"];

  if (parsed.scheme !== "zentry" || parsed.hostname !== "pair") {
    return {
      ok: false,
      error: "That is not a Zentry sign-in code. Open Settings, Mobile app in the web UI.",
    };
  }

  if (!(url !== undefined && /^https?:\/\/\S+$/.test(String(url)) && code !== undefined)) {
    return { ok: false, error: "This sign-in code is incomplete. Show a new one in the web UI." };
  }

  // The device token would cross the network in the clear. Only a build made
  // for a local `pnpm dev` (ZENTRY_ALLOW_HTTP=1, app.config.ts) accepts that.
  if (String(url).startsWith("http:") && !ALLOW_HTTP) {
    return { ok: false, error: "This code points at a server without https. Sign-in refused." };
  }

  return { ok: true, pairing: { apiUrl: String(url).replace(/\/+$/, ""), code: String(code) } };
}

/**
 * What the web UI lists this phone as. Android reports both parts on every
 * real phone and emulator; "Android" names the rare build that reports
 * neither, since the server needs some name to list.
 */
function deviceName(): string {
  return (
    [Device.manufacturer, Device.modelName].filter((part) => part !== null).join(" ") || "Android"
  );
}

type SignIn = { signIn: (link: string) => void; busy: boolean; error: string | null };

function useSignIn(): SignIn {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = (link: string): void => {
    const read = readLink(link);

    if (busy) {
      return;
    }

    if (!read.ok) {
      setError(read.error);

      return;
    }

    const { pairing } = read;

    setBusy(true);
    setError(null);
    pair(pairing.apiUrl, pairing.code, deviceName())
      .then((paired) =>
        session.signIn({
          apiUrl: pairing.apiUrl,
          token: paired.token,
          email: paired.email,
          deviceId: paired.device.id,
        }),
      )
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Sign-in failed"),
      )
      .finally(() => setBusy(false));
  };

  return { signIn, busy, error };
}

function Scanner({ onScan }: { onScan: (link: string) => void }): JSX.Element {
  const [permission, requestPermission] = useCameraPermissions();
  // The camera reports a code many times a second; act on each code once.
  // Pasting the link tries the same code again.
  const last = useRef<string | null>(null);

  const scanned = (data: string): void => {
    if (last.current !== data) {
      last.current = data;
      onScan(data);
    }
  };

  if (permission === null) {
    return <Text tone="muted">Checking camera access…</Text>;
  }

  if (!permission.granted) {
    return (
      <View style={{ gap: SPACE.sm }}>
        <Text tone="muted">
          The camera reads the sign-in code. You can also paste its link below.
        </Text>
        <Button label="Allow camera" kind="primary" onPress={() => void requestPermission()} />
      </View>
    );
  }

  return (
    <View style={{ aspectRatio: 1, borderRadius: RADIUS.md, overflow: "hidden" }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => scanned(data)}
      />
    </View>
  );
}

function PasteLink({ signIn, busy }: Omit<SignIn, "error">): JSX.Element {
  const palette = usePalette();
  const [pasted, setPasted] = useState("");

  return (
    <Panel>
      <Text weight="medium">Or paste the sign-in link</Text>
      <TextInput
        value={pasted}
        onChangeText={setPasted}
        placeholder="zentry://pair?url=…"
        placeholderTextColor={palette.faint}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          borderColor: palette.border,
          borderWidth: 1,
          borderRadius: RADIUS.md,
          padding: SPACE.sm,
          color: palette.text,
          fontFamily: FONTS.regular,
        }}
      />
      <Button
        label={busy ? "Signing in…" : "Sign in"}
        kind="primary"
        disabled={busy}
        onPress={() => signIn(pasted)}
      />
    </Panel>
  );
}

/** A sign-in link the app was opened with, waiting for the user to accept it. */
function ConfirmLink({
  link,
  signIn,
  busy,
}: Omit<SignIn, "error"> & { link: string }): JSX.Element {
  const read = readLink(link);

  return (
    <Panel>
      {read.ok ? (
        <>
          <Text weight="medium">Sign in to {new URL(read.pairing.apiUrl).host}?</Text>
          <Text tone="muted">Only if you just showed this code in your own Zentry web UI.</Text>
          <Button label="Sign in" kind="primary" disabled={busy} onPress={() => signIn(link)} />
        </>
      ) : (
        <Text tone="danger">{read.error}</Text>
      )}
    </Panel>
  );
}

export function PairScreen(): JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { signedOutReason } = useSession();
  const { signIn, busy, error } = useSignIn();
  // Scanning the QR code with the phone's own camera app opens this screen
  // through the zentry:// link, with the code already in it.
  const params = useLocalSearchParams<{ url?: string; code?: string }>();

  // Any web page can open a zentry:// link, so a link only offers to sign in,
  // naming the server; signing in to it takes a tap.
  const offered =
    params.url !== undefined && params.code !== undefined
      ? `zentry://pair?${new URLSearchParams({ url: params.url, code: params.code }).toString()}`
      : null;

  return (
    <ScrollView
      style={{ backgroundColor: palette.surface }}
      contentContainerStyle={{
        padding: SPACE.lg,
        paddingTop: insets.top + SPACE.xl,
        gap: SPACE.lg,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: SPACE.xs }}>
        <Text size={26} weight="medium">
          Zentry
        </Text>
        <Text tone="muted">
          In the web UI, open Settings, Mobile app, and choose Show sign-in code. Then scan it here.
        </Text>
      </View>
      {signedOutReason === "revoked" && (
        <Panel>
          <Text>This phone was signed out from the web UI. Scan a new code to sign in again.</Text>
        </Panel>
      )}
      {offered !== null && <ConfirmLink link={offered} signIn={signIn} busy={busy} />}
      <Scanner onScan={signIn} />
      <PasteLink signIn={signIn} busy={busy} />
      {error !== null && <Text tone="danger">{error}</Text>}
    </ScrollView>
  );
}
