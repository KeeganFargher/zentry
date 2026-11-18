// Copying text, as the web's CopyButton and copyText. The web confirms with a
// toast; here the phone ticks, and a button's label changes.

import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import type { JSX } from "react";

import { LinkButton } from "./parts";

/** No catch: a clipboard that refuses is a fault worth seeing, not hiding. */
export async function copyText(text: string): Promise<void> {
  if (!(await Clipboard.setStringAsync(text))) {
    throw new Error("The clipboard refused the text");
  }

  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    await copyText(text);
    setCopied(true);
  };

  return <LinkButton label={copied ? "Copied" : label} onPress={() => void copy()} />;
}
