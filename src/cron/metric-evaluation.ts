import { planIssues } from "@/core/monitor-issues";
import type { MetricDecision, MetricEvaluationStore } from "@/db/metric-evaluation";
import { issueStateOf } from "@/db/monitor-issues";
import type { Signal } from "@/shared/monitor-issues";

/**
 * A metric window as the issue lifecycle reads it. Every failing window is a
 * sighting; awaiting data and unknown coverage leave the issue alone.
 */
function signalOf(decision: MetricDecision, at: number): Signal | null {
  const { health, severity } = decision;

  if (health === "healthy") {
    return { health, severity: null, sighted: false, at };
  }

  if (health !== "failing") {
    return null;
  }

  // The query fails a window only when it crossed a threshold, which sets a severity.
  if (severity === null) {
    throw new Error(`metric monitor ${decision.monitorId} failed with no severity`);
  }

  return { health, severity, sighted: true, at };
}

/** Evaluates the metric monitors due for the window ending at `windowEnd`. */
export async function evaluateMetrics(
  store: MetricEvaluationStore,
  windowEnd: number,
): Promise<void> {
  const decisions = await store.due(windowEnd);

  if (decisions.length === 0) {
    return;
  }

  const states = await store.issueStates(decisions.map(({ monitorId }) => monitorId));

  await store.write(
    windowEnd,
    decisions.map((decision) => ({
      decision,
      plan: planIssues(issueStateOf(states, decision), [signalOf(decision, windowEnd)]),
    })),
  );
}
