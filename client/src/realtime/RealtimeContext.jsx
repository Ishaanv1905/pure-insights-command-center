// Owns the single WebSocket connection for the app.
//
// - Connects only when logged in (the server checks the session cookie on the handshake).
// - Reconnects with exponential backoff (1s, 2s, 4s ... max 30s) when the connection drops.
// - Lets components subscribe to event types ("alert.created", "reading.ingested"...).
// - Shows a short-lived toast for each NEW alert.
// - Bumps `reconnectCount` after a reconnect so pages can re-fetch over REST and
//   catch up on anything that happened while disconnected.
// - Stops and returns to login when the server ends the session (close code 4001).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';

const RealtimeContext = createContext(null);
const MAX_BACKOFF_MS = 30_000;
const TOAST_MS = 8_000;
const MAX_TOASTS = 3;
const SESSION_ENDED = 4001;

export function RealtimeProvider({ children }) {
  const { user, refresh } = useAuth();
  const [status, setStatus] = useState('disconnected'); // connecting | connected | disconnected
  const [toasts, setToasts] = useState([]);
  const [reconnectCount, setReconnectCount] = useState(0);
  const listeners = useRef(new Set());

  const subscribe = useCallback((listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const dismissToast = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  useEffect(() => {
    if (!user) return undefined;
    let ws;
    let retryTimer;
    let attempt = 0;
    let closedByUs = false;
    let hasConnectedBefore = false;

    const connect = () => {
      setStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

      ws.onopen = () => {
        attempt = 0;
        setStatus('connected');
        if (hasConnectedBefore) setReconnectCount((n) => n + 1);
        hasConnectedBefore = true;
      };

      ws.onmessage = (msg) => {
        let event;
        try {
          event = JSON.parse(msg.data);
        } catch {
          return;
        }
        for (const listener of listeners.current) listener(event);
        if (event.type === 'alert.created') {
          const toast = { id: `${event.data.id}-${Date.now()}`, alert: event.data };
          setToasts((list) => [toast, ...list].slice(0, MAX_TOASTS));
          setTimeout(() => dismissToast(toast.id), TOAST_MS);
        }
      };

      ws.onclose = (event) => {
        setStatus('disconnected');
        if (closedByUs) return;
        // 4001 = the server ended this session (logout elsewhere, expiry, revoked).
        // Re-check over REST: that sends the user to the login page instead of
        // reconnecting forever with a dead cookie.
        if (event.code === SESSION_ENDED) {
          refresh();
          return;
        }
        const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closedByUs = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, [user, dismissToast, refresh]);

  return (
    <RealtimeContext.Provider value={{ status, subscribe, toasts, dismissToast, reconnectCount }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export const useRealtime = () => useContext(RealtimeContext);
