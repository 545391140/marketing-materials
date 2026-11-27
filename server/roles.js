import { permissions, front, builtins, has } from "../shared/permissions.js";
import { profiles } from "./seed.js";

export const roleList = (s) => [...builtins, ...(s.businessRoles || [])];
export const people = (s, ctx) =>
  ctx.demo ? Object.values(profiles) : s.directory || [];
export function isRoot(person, ctx, env) {
  return (
    person.role !== "partner" &&
    (ctx.demo
      ? person.id === "admin"
      : (env.PC_ADMIN_IDS || "")
          .split(",")
          .map((id) => id.trim())
          .includes(person.id))
  );
}
export function effective(s, person, ctx, env) {
  if (!person) return null;
  const root = isRoot(person, ctx, env);
  const record = s.assignments?.find((a) => a.id === person.id);
  let base = ["viewer"];
  if (person.role === "editor") base = ["editor"];
  if (person.role === "reviewer") base = ["reviewer"];
  if (ctx.demo && person.id === "productReviewer")
    base = ["reviewer", "product"];
  if (ctx.demo && person.id === "reviewer")
    base = ["reviewer", "editor", "operations", "flow"];
  const catalog = roleList(s);
  const scopes = [...new Set(person.grants.map((g) => g.bg))].map((bg) => {
    const ids = record?.byBg.find((b) => b.bg === bg)?.ids || base;
    const caps = root
      ? [
          ...front,
          "read",
          "roles",
          "users",
          "diagnose",
          "audit",
          "flow",
          "catalog",
        ]
      : [
          ...new Set(
            catalog.filter((r) => ids.includes(r.id)).flatMap((r) => r.caps)
          ),
        ].filter(
          (k) =>
            (person.role !== "partner" || front.includes(k)) && k !== "roles"
        );
    return { bg, ids, caps };
  });
  return { ...person, scopes, root };
}
export function knownProfile(p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    org: p.org,
    grants: p.grants,
    active: p.active !== false,
  };
}
export function remember(s, p) {
  const list = s.directory || (s.directory = []);
  const old = list.find((v) => v.id === p.id);
  if (old) Object.assign(old, knownProfile(p));
  else list.push(knownProfile(p));
}
export function permittedUser(u, key) {
  return { ...u, grants: u.grants.filter((g) => has(u, key, g.bg)) };
}
