// The form's sticky footer, as Sentry's: Step 2 of 2 and Back while creating,
// Delete and Cancel while editing, Test Monitor for uptime, then the primary
// action.

import type { ApiMonitor, MonitorPreview, NewMonitor } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { useConfirm } from "~/components/overlays";
import { api, ApiFailure } from "~/lib/api";
import { navigate } from "~/lib/router";
import { toast } from "~/lib/toast";

import { bodyOf } from "./form-state";

export type Mode = { kind: "create" } | { kind: "edit"; monitor: ApiMonitor };

const OUTCOMES = { ok: "Up", failed: "Down", unknown: "Unknown" } as const;

/** One line for a test check: its outcome, then whatever the check measured. */
function testText(result: Extract<MonitorPreview, { type: "uptime" }>): string {
  const parts: string[] = [OUTCOMES[result.outcome]];

  if (result.httpStatus !== undefined) {
    parts.push(`HTTP ${result.httpStatus}`);
  }

  if (result.durationMs !== undefined) {
    parts.push(`${result.durationMs}ms`);
  }

  if (result.reason !== undefined) {
    parts.push(result.reason);
  }

  return parts.join(" · ");
}

function TestButton({ org, draft }: { org: string; draft: NewMonitor }): JSX.Element {
  const [result, setResult] = useState<string | null>(null);

  const test = async (): Promise<void> => {
    setResult("Testing…");

    let preview: MonitorPreview;

    try {
      preview = await api.previewMonitor(org, bodyOf(draft));
    } catch (cause) {
      // The API's refusal (a bad URL, the rate limit) is the test's answer;
      // anything else is a bug and surfaces.
      if (!(cause instanceof ApiFailure)) {
        throw cause;
      }

      setResult(cause.message);

      return;
    }

    // Only uptime drafts show this button, and an uptime draft previews as uptime.
    if (preview.type !== "uptime") {
      throw new Error(`An uptime test returned a ${preview.type} preview`);
    }

    setResult(testText(preview));
  };

  return (
    <>
      {result !== null && <span className="muted small">{result}</span>}
      <button type="button" onClick={() => void test()}>
        Test Monitor
      </button>
    </>
  );
}

function EditActions({ org, monitor }: { org: string; monitor: ApiMonitor }): JSX.Element {
  const [ask, dialog] = useConfirm();

  const archive = async (): Promise<void> => {
    // A refused delete (a stale version, a non-owner) must say so; the page stays put.
    try {
      await api.setMonitorStatus(org, monitor, "archived");
    } catch (cause) {
      if (!(cause instanceof ApiFailure)) {
        throw cause;
      }

      toast(`The monitor could not be deleted: ${cause.message}`);

      return;
    }

    toast("Monitor deleted");
    navigate(`/${org}/monitors/`);
  };

  const remove = (): void =>
    ask({
      title: "Delete monitor?",
      message:
        "Are you sure you want to delete this monitor? It stops running, and its history is kept for its retention period.",
      confirm: "Delete",
      danger: true,
      onConfirm: () => void archive(),
    });

  return (
    <>
      <button type="button" className="danger" onClick={remove}>
        Delete
      </button>
      <span className="spacer" />
      <button type="button" onClick={() => navigate(`/${org}/monitors/${monitor.id}/`)}>
        Cancel
      </button>
      {dialog}
    </>
  );
}

function CreateActions({ org, type }: { org: string; type: NewMonitor["type"] }): JSX.Element {
  return (
    <>
      <span className="spacer" />
      <span className="muted">Step 2 of 2</span>
      <button type="button" onClick={() => navigate(`/${org}/monitors/new/?type=${type}`)}>
        Back
      </button>
    </>
  );
}

type FooterProps = {
  org: string;
  mode: Mode;
  draft: NewMonitor;
  saving: boolean;
  /** The cron guide is open: the SDK creates the monitor, so there is nothing to save here. */
  guided: boolean;
  /** The first invalid field's message; saving waits until every field is valid. */
  problem: string | null;
  save: () => void;
};

const GUIDED_TITLE = "Using Auto-Instrumentation does not require you to create a monitor here";

export function FormFooter(props: FooterProps): JSX.Element {
  const { org, mode, draft, saving, guided, problem, save } = props;

  return (
    <footer className="form-footer">
      {mode.kind === "edit" ? (
        <EditActions org={org} monitor={mode.monitor} />
      ) : (
        <CreateActions org={org} type={draft.type} />
      )}
      {problem !== null && <span className="field-error">{problem}</span>}
      {draft.type === "uptime" && <TestButton org={org} draft={draft} />}
      <button
        type="button"
        className="primary"
        disabled={saving || guided || problem !== null}
        title={guided ? GUIDED_TITLE : (problem ?? undefined)}
        onClick={save}
      >
        {mode.kind === "edit" ? "Save" : "Create Monitor"}
      </button>
    </footer>
  );
}
