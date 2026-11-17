// Selection and bulk actions on the issue list.

import type { ApiIssue, IssueStatus } from "@contract";
import { useState } from "react";

import type { Confirmation, MenuItem } from "~/components/overlays";
import { api } from "~/lib/api";
import { copyText, toast } from "~/lib/toast";

export type Selection = {
  ids: Set<number>;
  chosen: ApiIssue[];
  /** `range` extends from the last row toggled to this one (shift-click). */
  toggle: (index: number, range: boolean) => void;
  toggleAll: () => void;
  clear: () => void;
};

function rangeOf(anchor: number, index: number): [number, number] {
  return [Math.min(anchor, index), Math.max(anchor, index)];
}

export function useSelection(issues: ApiIssue[]): Selection {
  const [ids, setIds] = useState(new Set<number>());
  const [anchor, setAnchor] = useState<number | null>(null);

  const toggle = (index: number, range: boolean): void => {
    const target = issues[index];

    if (target === undefined) {
      return;
    }

    // The whole range takes the state the clicked row is switching to.
    const select = !ids.has(target.id);
    const [from, to] = range && anchor !== null ? rangeOf(anchor, index) : [index, index];
    const next = new Set(ids);

    for (const issue of issues.slice(from, to + 1)) {
      if (select) {
        next.add(issue.id);
      } else {
        next.delete(issue.id);
      }
    }

    setAnchor(index);
    setIds(next);
  };

  const toggleAll = (): void => {
    setIds(ids.size === issues.length ? new Set() : new Set(issues.map((issue) => issue.id)));
  };

  return {
    ids,
    chosen: issues.filter((issue) => ids.has(issue.id)),
    toggle,
    toggleAll,
    clear: () => setIds(new Set()),
  };
}

const DONE = new Map<IssueStatus, string>([
  ["resolved", "Resolved"],
  ["ignored", "Archived"],
  ["unresolved", "Unresolved"],
]);

const VERB = new Map<IssueStatus, string>([
  ["resolved", "Resolve"],
  ["ignored", "Archive"],
  ["unresolved", "Unresolve"],
]);

function changed(issues: ApiIssue[], status: IssueStatus): string {
  const [only] = issues;
  const what = issues.length === 1 && only !== undefined ? only.shortId : `${issues.length} issues`;

  return `${DONE.get(status) ?? status} ${what}`;
}

export type Bulk = { org: string; issues: ApiIssue[]; refresh: () => void };

/** Changes status, then offers to put every issue back the way it was. */
export async function applyStatus(bulk: Bulk, status: IssueStatus): Promise<void> {
  const { org, issues, refresh } = bulk;

  await api.setStatus(
    org,
    issues.map((issue) => issue.id),
    status,
  );
  refresh();

  const undo = async (): Promise<void> => {
    for (const previous of ["unresolved", "resolved", "ignored"] as const) {
      const ids = issues.flatMap((issue) => (issue.status === previous ? [issue.id] : []));

      if (ids.length > 0) {
        await api.setStatus(org, ids, previous);
      }
    }

    refresh();
  };

  toast(changed(issues, status), () => void undo());
}

/** As on Sentry, a status change over a whole page of several issues is confirmed first. */
export function needsConfirming(chosen: ApiIssue[], pageSize: number): boolean {
  return chosen.length > 1 && chosen.length === pageSize;
}

export function confirmation(count: number, status: IssueStatus, run: () => void): Confirmation {
  const verb = VERB.get(status) ?? status;

  return {
    title: `${verb} ${count} issues?`,
    message: `This changes all ${count} issues selected on this page.`,
    confirm: verb,
    onConfirm: run,
  };
}

export function copyItems(org: string, chosen: ApiIssue[]): MenuItem[] {
  const ids = chosen.map((issue) => issue.shortId).join(", ");
  const links = chosen.map((issue) => `${window.location.origin}/${org}/issues/${issue.id}/`);

  return [
    { label: "Copy Issue IDs", onSelect: () => void copyText(ids, "Copied issue IDs") },
    {
      label: "Copy Issue Links",
      onSelect: () => void copyText(links.join("\n"), "Copied issue links"),
    },
  ];
}
