// The list table's bulk actions and pagination, as Sentry's detector list
// (a checked row swaps the header for Enable / Disable / Delete).

import type { ApiMonitor } from "@contract";
import type { JSX } from "react";

import { Icon } from "~/components/icons";
import { useConfirm } from "~/components/overlays";
import { api } from "~/lib/api";
import { replaceQuery } from "~/lib/router";
import { toast } from "~/lib/toast";

export const PAGE_SIZE = 20;

function countText(count: number): string {
  return `${count} monitor${count === 1 ? "" : "s"}`;
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

  // Monitors already in the chosen status are skipped so the API sees no
  // no-op edits; the toast still counts the whole selection.
  const update = async (status: ApiMonitor["status"], label: string): Promise<void> => {
    await Promise.all(
      selected
        .filter((monitor) => monitor.status !== status)
        .map((monitor) => api.setMonitorStatus(org, monitor, status)),
    );

    toast(`${label}d ${countText(selected.length)}`);
    clear();
    reload();
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
