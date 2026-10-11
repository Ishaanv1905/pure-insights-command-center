// A tiny in-process publish/subscribe bus.
//
// Services publish DOMAIN events ("alert.created") without knowing who listens.
// The WebSocket hub subscribes and forwards them to browsers. This keeps the
// business logic free of any WebSocket code, and lets tests subscribe directly.
//
// Scaling note: this only works inside ONE Node process. With several server
// instances you would swap this for Redis pub/sub or a message broker, and
// nothing else in the code would need to change.

export function createEventBus() {
  const listeners = new Set();
  return {
    publish(type, data) {
      const event = { type, data, at: new Date().toISOString() };
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // A failing subscriber must never break the publisher (e.g. ingestion).
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
