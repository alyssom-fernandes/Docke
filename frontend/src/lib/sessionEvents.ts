/** Simple event bus for session expiry — decouples api.ts from React. */
const EVENT = "docke:session-expired";

export function emitSessionExpired() {
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function onSessionExpired(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
