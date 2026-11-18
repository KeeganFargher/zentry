// The body of a stored event for the issue screen, ported from the web's
// event page (ui/src/pages/event-sections.tsx) for a phone: one column of
// sections, each skipped when the event has nothing for it. The screen owns
// the vertical scroll, so nothing here scrolls up and down.

import type { StoredEvent } from "@contract";
import type { JSX } from "react";
import { View } from "react-native";

import { Breadcrumbs } from "./breadcrumbs";
import { cardsOf } from "./context-model";
import { ContextsSection } from "./contexts";
import { RequestSection } from "./request";
import { ExtraData, Grouping, Highlights, MessageSection, messageOf, Sdk } from "./sections";
import { StackTraceSection } from "./stack-trace";
import { TagsSection } from "./tags";

/**
 * The web opens with Highlights; here the message and stack trace come
 * first, since a phone shows one section at a time and the crash is what
 * a push notification brought the reader to see. Highlights lead the
 * details instead.
 */
export function EventBody({ event }: { event: StoredEvent }): JSX.Element {
  const message = messageOf(event);
  const cards = cardsOf(event);

  // Keyed by event so paging to another event starts its sections afresh
  // instead of carrying over open frames, filters and tabs it may not have.
  return (
    <View key={event.eventId}>
      {message !== null && <MessageSection message={message} />}
      {event.exceptions.length > 0 && <StackTraceSection event={event} />}
      {event.breadcrumbs.length > 0 && <Breadcrumbs event={event} />}
      {event.request !== null && <RequestSection request={event.request} />}
      <TagsSection event={event} />
      <Highlights event={event} />
      {cards.length > 0 && <ContextsSection cards={cards} eventTime={event.timestamp} />}
      {Object.keys(event.extra).length > 0 && <ExtraData extra={event.extra} />}
      {event.sdk !== null && <Sdk sdk={event.sdk} />}
      <Grouping event={event} />
    </View>
  );
}
