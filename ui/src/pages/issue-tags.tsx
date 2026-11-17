// The tag panel beside the issue graph: four leading tags as segmented bars,
// or every tag as a card of its top values.

import type { ApiIssue, ApiTag } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Link } from "~/components/basics";
import { Tooltip } from "~/components/tooltip";
import { share } from "~/lib/format";

const FRONTEND = ["browser", "release", "url", "environment"];
const BACKEND = ["transaction", "url", "user", "release", "organization.slug", "environment"];
const MOBILE = ["device", "os", "release", "environment", "transaction"];

const FALLBACK = [
  "transaction",
  "environment",
  "release",
  "user",
  "browser",
  "runtime",
  "os",
  "level",
];

const MOBILE_PLATFORMS = new Set(["cocoa", "android", "react-native", "flutter", "dart", "apple"]);

/** Sentry picks the preview tags by the kind of platform. */
function preferred(platform: string | null): string[] {
  if (platform === "javascript") {
    return FRONTEND;
  }

  if (MOBILE_PLATFORMS.has(platform ?? "")) {
    return MOBILE;
  }

  return platform === null ? FALLBACK : BACKEND;
}

function previewTags(tags: ApiTag[], platform: string | null): ApiTag[] {
  const order = [...preferred(platform), ...FALLBACK];

  const rank = (tag: ApiTag): number => {
    const position = order.indexOf(tag.key);

    return position === -1 ? order.length : position;
  };

  return tags.toSorted((left, right) => rank(left) - rank(right)).slice(0, PREVIEW);
}

const PREVIEW = 4;
const SEGMENTS = 3;

type Segment = { label: string; count: number };

/** The top values of a tag, with everything else summed as "Other". */
function segmentsOf(tag: ApiTag): Segment[] {
  const top = tag.values.slice(0, SEGMENTS).map(({ value, count }) => ({ label: value, count }));
  const rest = tag.total - top.reduce((sum, segment) => sum + segment.count, 0);

  return rest > 0 ? [...top, { label: "Other", count: rest }] : top;
}

function Legend({ tag }: { tag: ApiTag }): JSX.Element {
  return (
    <div className="tag-legend">
      {segmentsOf(tag).map((segment, index) => (
        <div key={segment.label}>
          <span className={`swatch seg-${segment.label === "Other" ? "other" : index}`} />
          <span className="clip">{segment.label}</span>
          <strong>{share(segment.count, tag.total)}</strong>
        </div>
      ))}
    </div>
  );
}

function PreviewRow({ tag, onOpen }: { tag: ApiTag; onOpen: () => void }): JSX.Element | null {
  const [top] = tag.values;

  if (top === undefined) {
    return null;
  }

  const leftEllipsis = tag.key === "url" || tag.key === "transaction";

  return (
    <Tooltip content={<Legend tag={tag} />} className="tag-row-wrap">
      <button type="button" className="plain tag-row" onClick={onOpen}>
        <span className="key clip">{tag.key}</span>
        <span className="meter">
          {segmentsOf(tag).map((segment, index) => (
            <span
              key={segment.label}
              className={`seg-${segment.label === "Other" ? "other" : index}`}
              style={{ width: `${(segment.count / Math.max(1, tag.total)) * 100}%` }}
            />
          ))}
        </span>
        <span className="share">{share(top.count, tag.total)}</span>
        <span className={leftEllipsis ? "clip value left" : "clip value"}>{top.value}</span>
      </button>
    </Tooltip>
  );
}

type AllProps = { org: string; issue: ApiIssue; tags: ApiTag[] };

function TagCard({ org, issue, tag }: Omit<AllProps, "tags"> & { tag: ApiTag }): JSX.Element {
  const search = (value: string): string =>
    `/${org}/issues/?project=${issue.projectId}&status=all&tag=${encodeURIComponent(`${tag.key}:${value}`)}`;

  return (
    <div className="tag-card">
      <div className="tag-key">{tag.key}</div>
      {segmentsOf(tag).map((segment, index) => (
        <Tooltip
          key={segment.label}
          content={`${segment.count.toLocaleString()} of ${tag.total.toLocaleString()} tagged events`}
        >
          {segment.label === "Other" ? (
            <span className="tag-value-row">
              <span className="swatch seg-other" />
              <span className="clip">Other</span>
              <strong>{share(segment.count, tag.total)}</strong>
            </span>
          ) : (
            <Link to={search(segment.label)} className="tag-value-row">
              <span className={`swatch seg-${index}`} />
              <span className="clip">{segment.label}</span>
              <strong>{share(segment.count, tag.total)}</strong>
            </Link>
          )}
        </Tooltip>
      ))}
    </div>
  );
}

function AllTags({ org, issue, tags }: AllProps): JSX.Element {
  const [filter, setFilter] = useState("");
  const shown = tags.filter((tag) => tag.key.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <input
        type="search"
        className="small-search"
        aria-label="Filter tags"
        placeholder="Filter tags…"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="tag-cards">
        {shown.map((tag) => (
          <TagCard key={tag.key} org={org} issue={issue} tag={tag} />
        ))}
      </div>
    </>
  );
}

export function TagPanel({ org, issue, tags }: AllProps): JSX.Element {
  const [all, setAll] = useState(false);

  return (
    <div className={all ? "panel tag-panel all" : "panel tag-panel"}>
      {tags.length === 0 && <div className="muted small">No tags yet.</div>}
      {all ? (
        <AllTags org={org} issue={issue} tags={tags} />
      ) : (
        previewTags(tags, issue.platform).map((tag) => (
          <PreviewRow key={tag.key} tag={tag} onOpen={() => setAll(true)} />
        ))
      )}
      {tags.length > 0 && (
        <button type="button" className="plain small link" onClick={() => setAll(!all)}>
          {all ? "Show fewer tags" : "View all tags"}
        </button>
      )}
    </div>
  );
}
