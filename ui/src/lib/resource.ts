// Data loading for views: load when the key changes, expose state and a reload.

import { useCallback, useEffect, useRef, useState } from "react";

export type Resource<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

type State<T> = { key: string; data: T | null; error: string | null };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}

/** `key` identifies what is being loaded; a new key discards the old data. */
export function useResource<T>(key: string, load: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<State<T>>({ key: "", data: null, error: null });
  const [version, setVersion] = useState(0);
  const loader = useRef(load);
  // A reload bumps the version, which makes this a new run of the same key.
  const run = `${version}:${key}`;

  useEffect(() => {
    loader.current = load;
  });

  useEffect(() => {
    let current = true;

    loader
      .current()
      .then((data) => current && setState({ key: run, data, error: null }))
      .catch(
        (cause: unknown) => current && setState({ key: run, data: null, error: message(cause) }),
      );

    return () => {
      current = false;
    };
  }, [run]);

  const reload = useCallback(() => {
    setVersion((value) => value + 1);
  }, []);

  // Data from an earlier version of the same key stays visible while reloading.
  const fresh = state.key.slice(state.key.indexOf(":") + 1) === key;

  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: state.key !== run,
    reload,
  };
}
