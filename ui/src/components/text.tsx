// Plain text with its web addresses turned into links.

import type { JSX } from "react";

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;

export function Linkified({ text }: { text: string }): JSX.Element {
  const parts: (string | JSX.Element)[] = [];
  let last = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    parts.push(text.slice(last, match.index));
    parts.push(
      <a key={match.index} href={match[0]} target="_blank" rel="noreferrer">
        {match[0]}
      </a>,
    );
    last = match.index + match[0].length;
  }

  parts.push(text.slice(last));

  return <>{parts}</>;
}
