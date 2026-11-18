// A small path router: the URL is the only navigation state.

import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "issues"; org: string }
  | { name: "issue"; org: string; issueId: string; eventId: string | null }
  | { name: "events"; org: string; issueId: string }
  | { name: "projects"; org: string }
  | { name: "settings"; org: string; project: string }
  | { name: "organizationSettings"; org: string }
  | { name: "notificationSettings"; org: string }
  | { name: "missing" };

const NAVIGATE = "zentry:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE, onChange);

  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE, onChange);
  };
}

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

/** The current path and query string; re-renders on navigation. */
export function useUrl(): URL {
  return new URL(useSyncExternalStore(subscribe, currentUrl), window.location.origin);
}

export function navigate(to: string): void {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

/** Changes the query string without adding a history entry. */
export function replaceQuery(params: URLSearchParams): void {
  const query = params.toString();

  window.history.replaceState(
    null,
    "",
    window.location.pathname + (query === "" ? "" : `?${query}`),
  );
  window.dispatchEvent(new Event(NAVIGATE));
}

function issueRoute(org: string, rest: string[]): Route {
  const [issueId, events, eventId] = rest;

  if (issueId === undefined) {
    return { name: "issues", org };
  }

  if (events === "events" && eventId === undefined) {
    return { name: "events", org, issueId };
  }

  return { name: "issue", org, issueId, eventId: eventId ?? null };
}

export function matchRoute(pathname: string): Route {
  const [org, section, ...rest] = pathname.split("/").filter((part) => part !== "");

  if (org === undefined) {
    return { name: "home" };
  }

  if (section === "issues") {
    return issueRoute(org, rest);
  }

  if (section === "projects" && rest.length === 0) {
    return { name: "projects", org };
  }

  return section === "settings" ? settingsRoute(org, rest) : { name: "missing" };
}

function settingsRoute(org: string, rest: string[]): Route {
  const [kind, project] = rest;

  if (kind === undefined) {
    return { name: "organizationSettings", org };
  }

  if (kind === "notifications" && project === undefined) {
    return { name: "notificationSettings", org };
  }

  return kind === "projects" && project !== undefined
    ? { name: "settings", org, project }
    : { name: "missing" };
}
