// The organization in view: the one last chosen on this phone, while the user
// is still a member of it, else their first.

import type { ApiMe, ApiOrganization } from "@contract";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { usePreferences } from "./preferences";
import { meQuery } from "./queries";
import { useApi } from "./session";

export function useMe(): UseQueryResult<ApiMe> {
  return useQuery(meQuery(useApi()));
}

/** The organization with this slug while the user is still a member of it, else their first. */
export function pickOrganization(all: ApiOrganization[], slug: string): ApiOrganization | null {
  return all.find((entry) => entry.slug === slug) ?? all[0] ?? null;
}

export type Organizations = {
  current: ApiOrganization | null;
  all: ApiOrganization[];
  choose: (slug: string) => void;
  loading: boolean;
  error: Error | null;
};

export function useOrganizations(): Organizations {
  const me = useMe();
  const { organization, setOrganization } = usePreferences();
  const all = me.data?.organizations ?? [];
  // Until one is chosen on this phone, the first.
  const current = organization === null ? (all[0] ?? null) : pickOrganization(all, organization);

  return {
    current,
    all,
    choose: setOrganization,
    loading: me.isPending,
    error: me.error,
  };
}

/** The organization in view. Screens behind the organization gate call this. */
export function useOrganization(): ApiOrganization {
  const { current } = useOrganizations();

  if (current === null) {
    throw new Error("useOrganization on a screen that is not behind the organization gate");
  }

  return current;
}

/** The slug of the organization in view. Screens behind the organization gate call this. */
export function useOrg(): string {
  return useOrganization().slug;
}
