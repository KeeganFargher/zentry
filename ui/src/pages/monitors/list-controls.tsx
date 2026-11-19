// The list table's bulk actions and pagination, as Sentry's detector list
// (a checked row swaps the header for Enable / Disable / Delete).

import type { ApiMonitor } from "@contract";
import type { JSX } from "react";

import { Icon } from "~/components/icons";
import { useConfirm } from "~/components/overlays";
import { api, ApiFailure } from "~/lib/api";
import { replaceQuery } from "~/lib/router";
import { toast } from "~/lib/toast";

export const PAGE_SIZE = 20;

function countText(count: number): string {
  return `${count} monitor${count === 1 ? "" : "s"}`;
}

/**
 * Sets every selected monitor's status and returns why each failed one
 * failed. Monitors already in that status are skipped so the API sees no
 * no-op edits.
 */
async function setStatuses(
  org: string,
  selected: ApiMonitor[],
  status: ApiMonitor["status"],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    selected.flatMap((monitor) =>
      monitor.status === status ? [] : [api.setMonitorStatus(org, monitor, status)],
    ),
  );

  const failures: unknown[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;

      failures.push(reason);
    }
  }

  return failures;
}

export function BulkActions({
  org,
  selected,
  clear,
  reload,
}: {
  org: string;
  selected: ApiMonitor[];
  clear: () => void;
  reload: () => void;
}): JSX.Element {
  const [ask, dialog] = useConfirm();

  // Every update runs to the end, so one refusal (a stale version, a
  // member's 403) does not stop the rest; the list then reloads to show what
  // changed, and the toast counts what failed.
  const update = async (status: ApiMonitor["status"], label: string): Promise<void> => {
    const failures = await setStatuses(org, selected, status);

    clear();
    reload();

    // Anything but an API refusal is a bug, raised once the list has reloaded.
    const bug = failures.find((reason) => !(reason instanceof ApiFailure));

    if (bug !== undefined) {
      throw bug;
    }

    const [first] = failures;

    toast(
      first instanceof ApiFailure
        ? `${label}d ${selected.length - failures.length} of ${countText(selected.length)}; ${failures.length} failed: ${first.message}`
        : `${label}d ${countText(selected.length)}`,
    );
  };

  const apply = (status: ApiMonitor["status"], label: string): void =>
    ask({
      title: `${label} ${countText(selected.length)}?`,
      message:
        status === "archived"
          ? "Deleted monitors stop running and keep their history for its retention period."
          : "",
      confirm: label,
      danger: status === "archived",
      onConfirm: () => void update(status, label),
    });

  return (
    <div className="bulk-actions">
      <button type="button" className="small" onClick={() => apply("active", "Enable")}>
        Enable
      </button>
      <button type="button" className="small" onClick={() => apply("paused", "Disable")}>
        Disable
      </button>
      <button type="button" className="small danger" onClick={() => apply("archived", "Delete")}>
        Delete
      </button>
      {dialog}
    </div>
  );
}

function goToPage(to: number): void {
  const query = new URLSearchParams(window.location.search);

  query.set("page", String(to));
  replaceQuery(query);
}

export function Pagination({ page, total }: { page: number; total: number }): JSX.Element {
  const first = page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);

  return (
    <div className="pagination">
      <span className="muted">
        {first}-{last} of {total}
      </span>
      <span className="joined">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => goToPage(page - 1)}
        >
          <Icon name="previous" size={14} />
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={last >= total}
          onClick={() => goToPage(page + 1)}
        >
          <Icon name="next" size={14} />
        </button>
      </span>
    </div>
  );
}
