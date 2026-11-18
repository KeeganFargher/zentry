// What you can do to an issue from a phone: resolve or reopen it, archive it,
// and follow it (workflow notifications for issues you follow). Deleting is
// left to the web UI: it removes every stored event and cannot be undone.

import type { ApiIssue } from "@contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JSX } from "react";
import { View } from "react-native";

import { Button } from "~/components/button";
import { Text } from "~/components/text";
import { toast, useSetStatus } from "~/lib/issue-actions";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

/** Null while the subscription is loading; `error` when it could not be read. */
type Follow = { following: boolean | null; error: Error | null; toggle: () => void };

function useFollow(issueId: number): Follow {
  const api = useApi();
  const org = useOrg();
  const queries = useQueryClient();
  const key = ["issues", org, issueId, "subscription"];
  const subscription = useQuery({ queryKey: key, queryFn: () => api.subscription(org, issueId) });

  const mutation = useMutation({
    mutationFn: (subscribed: boolean) => api.setSubscription(org, issueId, subscribed),
    onSuccess: (result) => {
      queries.setQueryData(key, result);
      toast(result.subscribed ? "Following this issue" : "No longer following");
    },
    onError: (cause) => toast(cause.message),
  });

  const following = subscription.data?.subscribed ?? null;

  return {
    following,
    error: subscription.error,
    toggle: () => {
      if (following !== null) {
        mutation.mutate(!following);
      }
    },
  };
}

/** Sentry's action row: Resolve leads and takes the free width. */
export function IssueActions({ issue }: { issue: ApiIssue }): JSX.Element {
  const palette = usePalette();
  const setStatus = useSetStatus();
  const follow = useFollow(issue.id);
  const ids = [issue.id];

  return (
    <View
      style={{
        gap: SPACE.sm,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.md,
        borderBottomWidth: 1,
        borderBottomColor: palette.borderSoft,
      }}
    >
      <View style={{ flexDirection: "row", gap: SPACE.sm }}>
        {issue.status === "resolved" ? (
          <Button
            label="Reopen"
            icon="previous"
            grow
            onPress={() => setStatus({ ids, status: "unresolved" })}
          />
        ) : (
          <Button
            label="Resolve"
            kind="primary"
            icon="check"
            grow
            onPress={() => setStatus({ ids, status: "resolved" })}
          />
        )}
        {issue.status === "ignored" ? (
          <Button label="Unarchive" onPress={() => setStatus({ ids, status: "unresolved" })} />
        ) : (
          <Button label="Archive" onPress={() => setStatus({ ids, status: "ignored" })} />
        )}
        <Button
          label={follow.following === true ? "Unfollow this issue" : "Follow this issue"}
          icon="bell"
          iconOnly
          selected={follow.following === true}
          disabled={follow.following === null}
          onPress={follow.toggle}
        />
      </View>
      {follow.error !== null && (
        <Text tone="danger" size={13}>
          Could not tell whether you follow this issue: {follow.error.message}
        </Text>
      )}
    </View>
  );
}
