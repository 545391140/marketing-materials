// An idempotent HTTP adapter for the portal team's message service. Only portal
// notifications leave the app; all demo activity stays in its own workspace.
import { readState, update } from "./db.js";

export async function sendPortalNotifications(
  env,
  send = fetch,
  now = Date.now(),
) {
  if (!env.PC_SESSION_URL || !env.PC_MESSAGE_URL || !env.PC_SERVICE_TOKEN)
    return;
  const endpoint = new URL(env.PC_MESSAGE_URL);
  if (endpoint.protocol !== "https:")
    throw new Error("PC_MESSAGE_URL must use HTTPS");
  const { s } = await readState(env, "portal");
  const pending = s.notices
    .filter((n) => !n.portalSent && (n.portalRetryAt || 0) <= now)
    .slice(-20)
    .reverse();
  if (!pending.length) return;
  const results = [];
  for (const n of pending) {
    let ok = false;
    try {
      const response = await send(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        headers: {
          authorization: "Bearer " + env.PC_SERVICE_TOKEN,
          "content-type": "application/json",
          "idempotency-key": n.key,
        },
        body: JSON.stringify({
          eventId: n.key,
          recipientId: n.to,
          message: n.msg,
          requestId: n.rid || null,
          link: "#/work/" + encodeURIComponent("站内消息"),
        }),
      });
      ok = response.ok;
    } catch {
      /* Retain undelivered events for the next attempt. */
    }
    results.push({ key: n.key, ok });
  }
  await update(env, "portal", (state) => {
    for (const { key, ok } of results) {
      const n = state.notices.find((v) => v.key === key);
      if (!n || n.portalSent) continue;
      if (ok) n.portalSent = true;
      else {
        n.portalAttempts = (n.portalAttempts || 0) + 1;
        n.portalRetryAt =
          now +
          Math.min(3600000, 30000 * 2 ** Math.min(7, n.portalAttempts - 1));
      }
    }
  });
  return {sent:results.filter(r=>r.ok).length,deferred:results.filter(r=>!r.ok).length};
}
