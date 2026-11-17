// The Tags section: the event's own tags plus the ones Zentry derives and
// indexes (browser, os, user…), in a tree of dotted keys, with filter tabs
// and a menu on each value.

import type { Pair, StoredEvent } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Icon } from "~/components/icons";
import { Menu } from "~/components/overlays";
import { Section, Segmented } from "~/components/section";
import { getText } from "~/lib/json";
import { navigate } from "~/lib/router";
import { copyText } from "~/lib/toast";

function context(event: StoredEvent, name: string, field: string): string | null {
  const value = event.contexts[name];

  return value === undefined ? null : getText(value, field);
}

function nameAndVersion(event: StoredEvent, name: string): string | null {
  const label = context(event, name, "name");
  const version = context(event, name, "version");

  return label === null ? null : [label, version].filter((part) => part !== null).join(" ");
}

function userTag(event: StoredEvent): string | null {
  const user = event.user;

  if (user === null) {
    return null;
  }

  const fields: [prefix: string, field: string][] = [
    ["id", "id"],
    ["email", "email"],
    ["username", "username"],
    ["ip", "ip_address"],
  ];

  for (const [prefix, field] of fields) {
    const value = getText(user, field);

    if (value !== null) {
      return `${prefix}:${value}`;
    }
  }

  return null;
}

/** The same derived tags the Worker indexes (src/core/tags.ts). */
type Candidate = [key: string, value: string | null];

function mechanismTags(event: StoredEvent): Candidate[] {
  const last = event.exceptions.at(-1)?.mechanism ?? null;
  const handled = last?.handled ?? null;

  return [
    ["handled", handled === null ? null : handled ? "yes" : "no"],
    ["mechanism", last?.type ?? null],
  ];
}

function derivedTags(event: StoredEvent): Candidate[] {
  return [
    ["level", event.level],
    ["environment", event.environment],
    ["release", event.release],
    ["server_name", event.serverName],
    ["logger", event.logger ?? null],
    ["transaction", event.transaction],
    ["browser", nameAndVersion(event, "browser")],
    ["browser.name", context(event, "browser", "name")],
    ["os", nameAndVersion(event, "os")],
    ["os.name", context(event, "os", "name")],
    ["runtime", nameAndVersion(event, "runtime")],
    ["device", context(event, "device", "model") ?? context(event, "device", "family")],
    ["url", event.request?.url ?? null],
    ["user", userTag(event)],
    ...mechanismTags(event),
  ];
}

/** Built-in tags first, then the event's own; the first value for a key wins. */
export function eventTags(event: StoredEvent): Pair[] {
  const tags = new Map<string, string>();

  for (const [key, value] of [...derivedTags(event), ...event.tags]) {
    if (value !== null && value !== "" && !tags.has(key)) {
      tags.set(key, value);
    }
  }

  return [...tags].toSorted(([left], [right]) => left.localeCompare(right));
}

const APPLICATION = new Set([
  "environment",
  "release",
  "dist",
  "transaction",
  "logger",
  "level",
  "handled",
  "mechanism",
  "server_name",
  "url",
]);

const CLIENT = new Set([
  "browser",
  "browser.name",
  "os",
  "os.name",
  "device",
  "device.family",
  "runtime",
  "runtime.name",
  "user",
  "client_os",
  "client_os.name",
]);

const TABS = ["all", "custom", "application", "client"] as const;

type Tab = (typeof TABS)[number];

function inTab(tab: Tab, key: string, own: Set<string>): boolean {
  switch (tab) {
    case "application": {
      return APPLICATION.has(key);
    }

    case "client": {
      return CLIENT.has(key);
    }

    case "custom": {
      return own.has(key) && !APPLICATION.has(key) && !CLIENT.has(key);
    }

    default: {
      return true;
    }
  }
}

type Group = { root: string; value: string | null; children: Pair[] };

/** "browser" and "browser.name" become one group with a child row. */
function tree(tags: Pair[]): Group[] {
  const groups = new Map<string, Group>();

  for (const [key, value] of tags) {
    const dot = key.indexOf(".");
    const root = dot === -1 ? key : key.slice(0, dot);
    const group = groups.get(root) ?? { root, value: null, children: [] };

    if (dot === -1) {
      group.value = value;
    } else {
      group.children.push([key.slice(dot + 1), value]);
    }

    groups.set(root, group);
  }

  return [...groups.values()];
}

type ValueProps = { org: string; projectId: number; tag: string; value: string };

function TagValue({ org, projectId, tag, value }: ValueProps): JSX.Element {
  const search = `/${org}/issues/?project=${projectId}&status=all&tag=${encodeURIComponent(`${tag}:${value}`)}`;
  const external = tag === "url" && /^https?:\/\//.test(value);

  return (
    <span className="tag-value">
      {external ? (
        <a href={value} target="_blank" rel="noreferrer">
          {value}
        </a>
      ) : (
        <span>{value}</span>
      )}
      <Menu
        label={`Actions for ${tag}`}
        items={[
          { label: "Search issues with this tag value", onSelect: () => navigate(search) },
          {
            label: "Copy tag value to clipboard",
            onSelect: () => void copyText(value, "Copied tag value"),
          },
        ]}
      >
        <Icon name="more" size={12} />
      </Menu>
    </span>
  );
}

type TreeProps = { org: string; projectId: number; groups: Group[] };

function TagTree({ org, projectId, groups }: TreeProps): JSX.Element {
  return (
    <div className="tag-tree">
      {groups.map((group) => (
        <div key={group.root} className="tag-group">
          <div className="tag-line">
            <span className="tag-name">{group.root}</span>
            {group.value !== null && (
              <TagValue org={org} projectId={projectId} tag={group.root} value={group.value} />
            )}
          </div>
          {group.children.map(([name, value]) => (
            <div key={name} className="tag-line child">
              <span className="tag-name">{name}</span>
              <TagValue
                org={org}
                projectId={projectId}
                tag={`${group.root}.${name}`}
                value={value}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const TAB_LABELS = new Map<Tab, string>([
  ["all", "All"],
  ["custom", "Custom"],
  ["application", "Application"],
  ["client", "Client"],
]);

export function TagsSection({ org, event }: { org: string; event: StoredEvent }): JSX.Element {
  const [tab, setTab] = useState<Tab>("all");
  const own = new Set(event.tags.map(([key]) => key));
  const tags = eventTags(event);

  const available = TABS.filter(
    (option) => option === "all" || tags.some(([key]) => inTab(option, key, own)),
  );

  const groups = tree(tags.filter(([key]) => inTab(tab, key, own)));
  const half = Math.ceil(groups.length / 2);

  const tabs = (
    <Segmented
      label="Tag groups"
      options={available.map((option): readonly [Tab, string] => [
        option,
        TAB_LABELS.get(option) ?? option,
      ])}
      value={tab}
      onChange={setTab}
    />
  );

  return (
    <Section id="tags" title="Tags" actions={tabs}>
      <div className="columns">
        <TagTree org={org} projectId={event.projectId} groups={groups.slice(0, half)} />
        <TagTree org={org} projectId={event.projectId} groups={groups.slice(half)} />
      </div>
    </Section>
  );
}
