// The weekly report's numbers for one organization. DESIGN.md §18.7.

import type { WeeklyIssue, WeeklyProject, WeeklyTotals } from "@/shared/notify";

export type WeeklyNumbers = { totals: WeeklyTotals; projects: WeeklyProject[]; top: WeeklyIssue[] };

export type WeekRange = { start: number; end: number };

type TopRow = Omit<WeeklyIssue, "shortId"> & { slug: string; shortNumber: number };

const TOP_ISSUES = 5;

export class ReportStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async weekly(organizationId: number, range: WeekRange): Promise<WeeklyNumbers> {
    const db = this.#db;
    const binds = [organizationId, range.start, range.end];

    const [projects, activity, top] = await Promise.all([
      // Received events per project, from the hourly counts, and the issues
      // first seen in the week.
      db
        .prepare(
          `SELECT p.slug,
                  COALESCE((SELECT sum(received) FROM project_stats s
                            WHERE s.project_id = p.id AND s.bucket >= ?2 AND s.bucket < ?3), 0) AS events,
                  (SELECT count(*) FROM groups g
                   WHERE g.project_id = p.id AND g.first_seen >= ?2 AND g.first_seen < ?3) AS newIssues
           FROM projects p WHERE p.organization_id = ?1 ORDER BY events DESC, p.slug`,
        )
        .bind(...binds)
        .all<WeeklyProject>(),
      db
        .prepare(
          `SELECT count(DISTINCT CASE WHEN a.type = 'regressed' THEN a.group_id END) AS regressed,
                  count(DISTINCT CASE WHEN a.type = 'resolved' THEN a.group_id END) AS resolved
           FROM activity a JOIN projects p ON p.id = a.project_id
           WHERE p.organization_id = ?1 AND a.created_at >= ?2 AND a.created_at < ?3`,
        )
        .bind(...binds)
        .first<Pick<WeeklyTotals, "regressed" | "resolved">>(),
      db
        .prepare(
          `SELECT g.id, p.slug, g.short_id AS shortNumber, g.title, g.culprit, sum(s.count) AS events
           FROM group_stats s
           JOIN groups g ON g.id = s.group_id
           JOIN projects p ON p.id = g.project_id
           WHERE p.organization_id = ?1 AND s.bucket >= ?2 AND s.bucket < ?3
           GROUP BY g.id ORDER BY events DESC, g.id LIMIT ?4`,
        )
        .bind(...binds, TOP_ISSUES)
        .all<TopRow>(),
    ]);

    const projectRows = projects.results;
    const counts = activity ?? { regressed: 0, resolved: 0 };
    const topRows = top.results;

    return {
      totals: {
        events: projectRows.reduce((total, row) => total + row.events, 0),
        newIssues: projectRows.reduce((total, row) => total + row.newIssues, 0),
        regressed: counts.regressed,
        resolved: counts.resolved,
      },
      projects: projectRows,
      top: topRows.map((row) => ({
        id: row.id,
        shortId: `${row.slug.toUpperCase()}-${row.shortNumber}`,
        title: row.title,
        culprit: row.culprit,
        events: row.events,
      })),
    };
  }
}
