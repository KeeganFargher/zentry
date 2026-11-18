// What a frame shows when opened: its source lines around the crash, its
// full path, and its local variables.

import type { StoredFrame } from "@contract";
import type { JSX } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { TextStyle } from "react-native";

import { Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import type { Palette } from "~/lib/theme";
import { RADIUS, SPACE } from "~/lib/theme";

import { fullPath, sourceLines, varsOf } from "./frame-model";
import { highlight } from "./highlight";
import type { TokenKind } from "./highlight";
import { KeyValueTable } from "./json-view";
import { numbered } from "./lists";

const styles = StyleSheet.create({
  // Inset from the frame box's border, as the board's frame rows are.
  body: { gap: SPACE.sm, padding: SPACE.sm },
  path: { paddingHorizontal: SPACE.xs },
  scroller: { borderRadius: RADIUS.md },
  // At least as wide as the screen, so the context line's highlight spans it.
  lines: { flexGrow: 1, paddingVertical: SPACE.xs },
  column: { flexGrow: 1 },
  line: { flexDirection: "row", paddingHorizontal: SPACE.sm },
  lineno: { width: 44 },
  code: { fontSize: 12, lineHeight: 22 },
});

function tokenStyle(palette: Palette, kind: TokenKind): TextStyle {
  switch (kind) {
    case "comment": {
      return { color: palette.muted, fontStyle: "italic" };
    }

    case "string": {
      return { color: palette.ok };
    }

    case "number": {
      return { color: palette.literal };
    }

    case "keyword": {
      return { color: palette.danger };
    }

    default: {
      return { color: palette.text };
    }
  }
}

type LineProps = { lineno: number | null; line: string; filename: string; current: boolean };

function SourceLine({ lineno, line, filename, current }: LineProps): JSX.Element {
  const palette = usePalette();

  return (
    <View style={[styles.line, current ? { backgroundColor: palette.raised } : undefined]}>
      <Text mono tone="faint" style={[styles.code, styles.lineno]}>
        {lineno === null ? " " : String(lineno)}
      </Text>
      <Text mono selectable style={styles.code}>
        {/* A blank line still needs a character, or Android gives it no height. */}
        {numbered(highlight(line === "" ? " " : line, filename)).map(([index, [kind, text]]) => (
          <Text key={index} mono style={[styles.code, tokenStyle(palette, kind)]}>
            {text}
          </Text>
        ))}
      </Text>
    </View>
  );
}

/**
 * One sideways scroller for the whole block rather than one per line, so the
 * lines move together and stay aligned with their numbers.
 */
function Source({ frame, contextLine }: { frame: StoredFrame; contextLine: string }): JSX.Element {
  const palette = usePalette();

  return (
    <ScrollView
      horizontal
      style={[styles.scroller, { backgroundColor: palette.surface }]}
      contentContainerStyle={styles.lines}
    >
      <View style={styles.column}>
        {numbered(sourceLines(frame, contextLine)).map(([index, [lineno, line]]) => (
          <SourceLine
            key={index}
            lineno={lineno}
            line={line}
            filename={frame.filename ?? ""}
            current={index === frame.preContext.length}
          />
        ))}
      </View>
    </ScrollView>
  );
}

export function FrameBody({ frame }: { frame: StoredFrame }): JSX.Element {
  const path = fullPath(frame);
  const vars = varsOf(frame);

  return (
    <View style={styles.body}>
      {path !== null && (
        <Text size={12} tone="muted" mono selectable style={styles.path}>
          {path}
        </Text>
      )}
      {frame.contextLine !== null && <Source frame={frame} contextLine={frame.contextLine} />}
      {vars !== null && <KeyValueTable data={vars} />}
    </View>
  );
}
