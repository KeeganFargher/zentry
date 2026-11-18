// Changing an issue's status from the list or the issue screen, with the
// cache brought up to date afterwards. Failures surface as a toast with the
// server's reason, never silently.

import type { IssueStatus } from "@contract";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { ToastAndroid } from "react-native";

import { useOrg } from "./organization";
import { useApi } from "./session";

export function toast(message: string): void {
  ToastAndroid.show(message, ToastAndroid.SHORT);
}

const DONE: Record<IssueStatus, string> = {
  resolved: "Resolved",
  ignored: "Archived",
  unresolved: "Reopened",
};

type Change = { ids: number[]; status: IssueStatus };

export function useSetStatus(): (change: Change) => void {
  const api = useApi();
  const org = useOrg();
  const queries = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ ids, status }: Change) => api.setStatuses(org, ids, status),
    onSuccess: (_, { ids, status }) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(ids.length === 1 ? DONE[status] : `${DONE[status]} ${ids.length} issues`);
    },
    onError: (cause) => toast(cause.message),
    // Both lists and the issue screens may show what changed.
    onSettled: () => queries.invalidateQueries({ queryKey: ["issues", org] }),
  });

  return mutation.mutate;
}
