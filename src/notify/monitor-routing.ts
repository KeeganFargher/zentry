import { routeTransition } from "@/core/monitor-routing";
import type { MonitorRoutingStore } from "@/db/monitor-routing";

/**
 * Routes a transition to its alert rules, after any earlier transition of the
 * same scope that is still unrouted: throttling, "already paged" and a
 * high-priority rule's first failure read earlier deliveries, so a scope
 * routes in order even when a later outbox row is handled first.
 */
export async function routeTransitions(
  store: MonitorRoutingStore,
  transitionId: number,
  now: number,
): Promise<void> {
  for (const id of await store.unrouted(transitionId)) {
    const input = await store.input(id);

    // Retention pruned it; there is nothing left to route.
    if (input !== null) {
      await store.save(id, {
        groupId: input.groupId,
        deliveries: routeTransition(input, input.rules),
        now,
      });
    }
  }
}
