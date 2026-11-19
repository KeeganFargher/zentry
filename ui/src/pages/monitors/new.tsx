// Step 1 of creating a monitor: choose its type, as Sentry's DetectorTypeForm.
// The small pictures are drawn here, not copied from Sentry.

import { useState } from "react";
import type { JSX } from "react";

import { Link } from "~/components/basics";
import { navigate, useUrl } from "~/lib/router";

import type { MonitorType } from "./form-state";
import { TopBar } from "./parts";

const TICKS = 24;

/** A row of ticks: the first `good` green, the rest in `tone`. */
function Ticks({ good, tone }: { good: number; tone: string }): JSX.Element {
  return (
    <svg viewBox={`0 0 ${TICKS * 10} 20`} className="type-art" aria-hidden="true">
      {Array.from({ length: TICKS }, (_, index) => (
        <rect
          key={index}
          x={index * 10 + 3}
          y="3"
          width="4"
          height="14"
          rx="1"
          className={index < good ? "art-good" : `art-${tone}`}
        />
      ))}
    </svg>
  );
}

function Area(): JSX.Element {
  const heights = [3, 4, 3, 5, 14, 4, 3, 3, 4, 6, 5, 7, 6, 4, 5, 8, 6, 15, 7, 6, 5, 7, 6, 5];
  const points = heights.map((height, index) => `${index * 10},${30 - height}`).join(" ");

  return (
    <svg viewBox="0 0 230 30" className="type-art" aria-hidden="true">
      <rect x="0" y="0" width="230" height="14" className="art-band" />
      <line x1="0" x2="230" y1="14" y2="14" className="art-threshold" />
      <polygon points={`0,30 ${points} 230,30`} className="art-area" />
    </svg>
  );
}

type Option = { type: MonitorType; name: string; description: string; art: JSX.Element };

const OPTIONS: Option[] = [
  {
    type: "metric",
    name: "Metric",
    description: "Monitor error counts in a project, by environment and level.",
    art: <Area />,
  },
  {
    type: "cron",
    name: "Cron",
    description: "Monitor the uptime and performance of any scheduled, recurring jobs.",
    art: <Ticks good={12} tone="meh" />,
  },
  {
    type: "uptime",
    name: "Uptime",
    description: "Monitor the uptime of specific endpoint in your applications.",
    art: <Ticks good={12} tone="bad" />,
  },
];

const TYPES = new Set<string>(["metric", "cron", "uptime"]);

function isType(value: string): value is MonitorType {
  return TYPES.has(value);
}

export function NewMonitor({ org }: { org: string }): JSX.Element {
  const url = useUrl();
  // An absent type reads as "", which no type matches, so the picker starts on Metric.
  const requested = url.searchParams.get("type") ?? "";
  const [type, setType] = useState<MonitorType>(isType(requested) ? requested : "metric");
  const project = url.searchParams.get("project");
  const next = `/${org}/monitors/new/settings/?type=${type}${project === null ? "" : `&project=${project}`}`;

  return (
    <>
      <TopBar crumbs={[{ label: "Monitors", to: `/${org}/monitors/` }, { label: "New Monitor" }]} />
      <div className="intro-bar">
        Monitors detect problems in your application and create Zentry issues.
      </div>
      <div className="content monitor-new">
        <div className="type-options" role="radiogroup" aria-label="Monitor type">
          {OPTIONS.map((option) => (
            <label
              key={option.type}
              className={option.type === type ? "type-option selected" : "type-option"}
            >
              <input
                type="radio"
                name="type"
                checked={option.type === type}
                onChange={() => setType(option.type)}
              />
              <span className="type-text">
                <strong>{option.name}</strong>
                <span className="muted">{option.description}</span>
              </span>
              {option.art}
            </label>
          ))}
        </div>
        {type === "uptime" && (
          <div className="alert-banner warning">
            Uptime checks reach only origins an operator has approved for this organization.
          </div>
        )}
        <p>
          Want to just alert on an existing monitor?{" "}
          <Link to={`/${org}/monitors/alerts/new/`}>Create an alert</Link>.
        </p>
      </div>
      <footer className="form-footer">
        <span className="muted">Step 1 of 2</span>
        <button type="button" onClick={() => navigate(`/${org}/monitors/`)}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={() => navigate(next)}>
          Next
        </button>
      </footer>
    </>
  );
}
