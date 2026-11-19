// Detail sections every monitor type shares: Ongoing Issues, Connected Alerts,
// and Zentry's own history of incidents, deliveries and configuration.

import type { ApiMonitorRule, MonitorDetail as Detail } from "@contract";
import type { JSX } from "react";

import { Ago, Link } from "~/components/basics";
import { Icon } from "~/components/icons";
import { useNow } from "~/lib/clock";
import { dateTime, duration } from "~/lib/format";

import { DetailSection, memberEmail } from "./parts";
import type { MonitorContext } from "./parts";

export function OngoingIssues({ org, detail }: { org: string; detail: Detail }): JSX.Element {
  const issue = detail.monitor.lastIssue;
  const periods = detail.incidents;
  const now = useNow();

  return (
    <DetailSection
      title={periods.some(({ closedAt }) => closedAt === null) ? "Ongoing Issues" : "Issues"}
    >
      {periods.length === 0 ? (
        <div className="panel empty-state muted">No ongoing issue found for this monitor</div>
      ) : (
        <table className="rows panel">
          <thead>
            <tr>
              <th>Issue</th>
              <th>Scope</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={`${period.issueId}:${period.openedAt}`}>
                <td>
                  <Link to={`/${org}/issues/${period.issueId}/`}>
                    {issue?.id === period.issueId ? issue.shortId : `#${period.issueId}`}
                  </Link>
                </td>
                <td>{period.scope === "" ? <span className="muted">—</span> : period.scope}</td>
                <td>{dateTime(period.openedAt)}</td>
                <td>
                  {period.closedAt === null ? (
                    <span className="tag danger">Ongoing</span>
                  ) : (
                    <span title={period.disposition ?? ""}>{dateTime(period.closedAt)}</span>
                  )}
                </td>
                <td>{duration((period.closedAt ?? now) - period.openedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailSection>
  );
}

const CHANNEL_LABELS = { email: "Email", push: "Mobile push" };

function RuleTable({ org, rules }: { org: string; rules: ApiMonitorRule[] }): JSX.Element {
  return (
    <table className="rows panel">
      <thead>
        <tr>
          <th>Name</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <tr key={rule.id}>
            <td>
              <Link to={`/${org}/monitors/alerts/${rule.id}/`}>{rule.name}</Link>
              {!rule.enabled && <span className="muted"> — Disabled</span>}
            </td>
            <td>
              <Icon name="mail" size={14} />{" "}
              {rule.channels.map((channel) => CHANNEL_LABELS[channel]).join(", ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ConnectedAlerts({
  org,
  detail,
  context,
}: {
  org: string;
  detail: Detail;
  context: MonitorContext;
}): JSX.Element {
  const rules = context.rules.filter(({ id }) => detail.monitor.alertRuleIds.includes(id));
  const edit = `/${org}/monitors/${detail.monitor.id}/edit/`;
  const create = `/${org}/monitors/alerts/new/?monitor=${detail.monitor.id}`;

  return (
    <DetailSection
      title="Connected Alerts"
      trailing={
        <span className="section-actions">
          <Link to={create} className="button-link small">
            <Icon name="add" size={12} /> New Alert
          </Link>
          <Link to={edit} className="button-link small">
            <Icon name="edit" size={12} /> Edit Alerts
          </Link>
        </span>
      }
    >
      {rules.length === 0 ? (
        <div className="panel empty-state">
          <Link to={edit} className="button-link">
            Connect Existing Alerts
          </Link>
          <Link to={create} className="button-link">
            <Icon name="add" size={14} /> Create a New Alert
          </Link>
          {!detail.monitor.notify && (
            <span className="muted small">Alerts are turned off for this monitor.</span>
          )}
        </div>
      ) : (
        <RuleTable org={org} rules={rules} />
      )}
    </DetailSection>
  );
}

/** Zentry keeps who changed a monitor and what each alert did; Sentry shows these elsewhere. */
export function Activity({
  detail,
  context,
}: {
  detail: Detail;
  context: MonitorContext;
}): JSX.Element {
  return (
    <DetailSection title="Activity">
      <details className="panel activity">
        <summary>Alert deliveries ({detail.deliveries.length})</summary>
        <ul>
          {detail.deliveries.map(({ id, transition, channel, time, suppression }) => (
            <li key={id}>
              <Ago at={time} label="Delivered" /> · {transition} · {channel} ·{" "}
              {suppression === null ? "sent" : `not sent: ${suppression.replaceAll("_", " ")}`}
            </li>
          ))}
        </ul>
      </details>
      <details className="panel activity">
        <summary>Configuration changes ({detail.audit.length})</summary>
        <ul>
          {detail.audit.map((entry) => (
            <li key={entry.version}>
              <Ago at={entry.time} label="Changed" /> · version {entry.version} by{" "}
              {entry.actorId === null
                ? "an SDK check-in"
                : (memberEmail(context.members, entry.actorId) ?? "a former member")}
            </li>
          ))}
        </ul>
      </details>
    </DetailSection>
  );
}
