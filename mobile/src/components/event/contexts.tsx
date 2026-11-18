// The Contexts section, ported from ui/src/pages/event-contexts.tsx: one card
// per context the SDK sent, in Sentry's order. The web lays cards out in a
// masonry grid; a phone stacks them.

import type { JSX } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "~/components/text";
import { SPACE } from "~/lib/theme";

import { fieldsOf, formattedText, TITLES } from "./context-model";
import type { Card } from "./context-model";
import { Rows } from "./json-view";
import type { Row } from "./json-view";
import { words } from "./lists";
import { EventSection } from "./parts";

const styles = StyleSheet.create({
  card: { gap: SPACE.xs, paddingTop: SPACE.sm },
});

function ContextCard({ card, eventTime }: { card: Card; eventTime: number }): JSX.Element {
  // Known contexts get readable labels; unknown ones keep the SDK's keys.
  const known = TITLES.has(card.name);

  const rows = fieldsOf(card.data).map(([key, value]): Row => [
    known ? words(key) : key,
    // Known values read as words; the rest show as their JSON.
    formattedText(key, value, eventTime) ?? value,
  ]);

  return (
    <View style={styles.card}>
      <Text weight="medium">{TITLES.get(card.name) ?? card.name}</Text>
      <Rows rows={rows} />
    </View>
  );
}

/** `cards` is never empty: the caller skips the section when it would be. */
export function ContextsSection({
  cards,
  eventTime,
}: {
  cards: Card[];
  eventTime: number;
}): JSX.Element {
  return (
    <EventSection title="Contexts">
      {cards.map((card) => (
        <ContextCard key={card.name} card={card} eventTime={eventTime} />
      ))}
    </EventSection>
  );
}
