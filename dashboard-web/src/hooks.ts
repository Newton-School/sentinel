import { useEffect, useState } from "react";

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/**
 * Minimal data-fetching hook: runs `fn` on mount and whenever `deps` change,
 * tracking loading/error/data. Ignores results from a stale invocation so a
 * fast filter change can't be overwritten by an in-flight slower request.
 * (TanStack Query is the planned P1 upgrade for caching/polling.)
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn()
      .then((data) => live && setState({ data, loading: false }))
      .catch((err) => live && setState({ error: String(err?.message ?? err), loading: false }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
