// PC and OA consume the same durable business event and deduplicate by event ID.
import { canReview } from "../shared/approval.js";
import { effective } from "./roles.js";
import { visible } from "./access.js";
import { has } from "../shared/permissions.js";
import { recipient, readState, update } from "./db.js";

export async function sendPortalNotifications(
  env,
  send = fetch,
  now = Date.now()
) {
  if (
    !(env.PC_SESSION_URL || env.OA_SESSION_URL) ||
    !(env.PC_MESSAGE_URL || env.OA_MESSAGE_URL)
  )
    return;
  const { s } = await readState(env, "portal");
  const pending = s.notices
    .filter(
      (n) => !n.portalSkipped && !n.portalSent && (n.portalRetryAt || 0) <= now
    )
    .slice(-20)
    .reverse();
  if (!pending.length) return;
  const results = [];
  for (const n of pending) {
    let ok = false;
    try {
      const ctx = { demo: false, u: { id: "" } };
      const account = env.OA_SESSION_URL
        ? await recipient(ctx, env, n.to)
        : null;
      const source =
        account?.employeeId || (env.OA_SESSION_URL && n.studio) ? "OA" : "PC";
      const address = env[source + "_MESSAGE_URL"],
        token = env[source + "_SERVICE_TOKEN"];
      const user = account && effective(s, account, ctx, env);
      const draft = n.draftId && s.drafts.find((d) => d.id === n.draftId);
      const delivery =
        n.rid &&
        s.requests?.find(
          (r) =>
            r.id === n.rid && n.key === [r.id, r.material, r.version].join(":")
        );
      const material =
        delivery &&
        s.materials.find(
          (m) => m.id === delivery.material && m.version === delivery.version
        );
      const authorized =
        material && user && visible(material, user, s.materials);
      const unavailable =
        delivery &&
        !delivery.deliveryFiles.every((id) =>
          authorized?.files.some(
            (f) =>
              f.id === id &&
              (!delivery.needDownload || f.canDownload) &&
              (!delivery.external || (f.canDownload && f.usage === "可发客户"))
          )
        );
      if (
        env.OA_SESSION_URL &&
        (unavailable ||
          !account ||
          (n.stepToken &&
            (!draft ||
              draft.approval?.token !== n.stepToken ||
              !canReview(draft, user))) ||
          (n.flowBg && !has(user, "flow", n.flowBg)))
      ) {
        results.push({ key: n.key, skipped: true });
        continue;
      }
      if (!address || !token) throw Error("消息接口未配置");
      const endpoint = new URL(address);
      if (endpoint.protocol !== "https:") throw Error("消息接口需要 HTTPS");
      let link = "#/work/" + encodeURIComponent("站内消息");
      if (env.OA_SESSION_URL) {
        if (n.studio && env.ADMIN_ORIGIN) {
          const target = new URL("/", env.ADMIN_ORIGIN);
          if (n.draftId) target.searchParams.set("review", n.draftId);
          if (n.flowBg) target.searchParams.set("flow", n.flowBg);
          link = target.href;
        } else if (env.PORTAL_ORIGIN) {
          const target = new URL(
            "/" +
              source.toLowerCase() +
              "/" +
              (account?.actorId
                ? "as/" + encodeURIComponent(account.companyId) + "/"
                : ""),
            env.PORTAL_ORIGIN
          );
          target.hash = link.slice(1);
          link = target.href;
        }
      }
      const response = await send(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "idempotency-key": n.key,
        },
        body: JSON.stringify({
          eventId: n.key,
          recipientId: account?.employeeId || n.to,
          message: n.msg,
          requestId: n.rid || null,
          link,
          companyId: account?.actorId ? account.companyId : undefined,
        }),
      });
      ok = response.ok;
    } catch {
      /* Retain undelivered events for the next attempt. */
    }
    results.push({ key: n.key, ok });
  }
  await update(env, "portal", (state) => {
    for (const { key, ok, skipped } of results) {
      const n = state.notices.find((v) => v.key === key);
      if (!n || n.portalSent) continue;
      if (skipped) n.portalSkipped = true;
      else if (ok) n.portalSent = true;
      else {
        n.portalAttempts = (n.portalAttempts || 0) + 1;
        n.portalRetryAt =
          now +
          Math.min(3600000, 30000 * 2 ** Math.min(7, n.portalAttempts - 1));
      }
    }
  });
  return {
    sent: results.filter((r) => r.ok).length,
    deferred: results.filter((r) => !r.ok && !r.skipped).length,
  };
}
