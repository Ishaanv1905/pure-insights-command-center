import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useRealtime } from '../realtime/RealtimeContext.jsx';

/**
 * Fetches `path` and re-fetches when:
 *  - the path changes (filters, pagination),
 *  - `refreshKey` changes,
 *  - one of `liveEvents` arrives on the WebSocket (throttled, so a burst of
 *    readings causes one refresh, not hundreds),
 *  - the WebSocket reconnects (catch up on missed changes).
 * Pass path = null to skip fetching.
 */
export function useApi(path, { liveEvents = [], throttleMs = 2000, refreshKey = 0 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const { subscribe, reconnectCount } = useRealtime();
  const lastRun = useRef(0);
  const pending = useRef(null);
  const eventsKey = liveEvents.join(',');

  useEffect(() => {
    if (!eventsKey) return undefined;
    const wanted = new Set(eventsKey.split(','));
    const unsubscribe = subscribe((event) => {
      if (!wanted.has(event.type)) return;
      const wait = throttleMs - (Date.now() - lastRun.current);
      if (wait <= 0) {
        lastRun.current = Date.now();
        setTick((t) => t + 1);
      } else if (!pending.current) {
        pending.current = setTimeout(() => {
          pending.current = null;
          lastRun.current = Date.now();
          setTick((t) => t + 1);
        }, wait);
      }
    });
    return () => {
      unsubscribe();
      clearTimeout(pending.current);
      pending.current = null;
    };
  }, [eventsKey, subscribe, throttleMs]);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    api
      .get(path)
      .then((data) => !cancelled && setState({ data, error: null, loading: false }))
      .catch((error) => !cancelled && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      cancelled = true;
    };
  }, [path, tick, refreshKey, reconnectCount]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
