import { has } from "./permissions.js";
// Rules apply within a BG. The lowest active priority takes precedence.
export const defaultFlow = {
  name: "标准发布审核", steps: [{ name: "发布审核", reviewerId: "", reviewerName: "" }],
};

export function selectFlow(rules, material, fallback = true) {
  const matches = rules.filter((rule) =>
    rule.active && rule.bg === material.bg &&
    ["product", "solution", "type"].every((key) => !rule[key] || rule[key] === material[key]));
  return matches.sort((a, b) => a.priority - b.priority)[0] || (fallback ? defaultFlow : null);
}

export function currentStep(draft) {
  const flow = draft.approval;
  return flow ? flow.steps[flow.index] : defaultFlow.steps[0];
}

export function canReview(draft, user) {
  const step = currentStep(draft);
  const bg = step?.bg || draft.bg;
  return draft.state === "待审核" && has(user,"review",bg) && user.id !== draft.author &&
    !!step && (!step.roleId || user.scopes.some((s)=>s.bg===bg && s.ids.includes(step.roleId))) && (!step.reviewerId || step.reviewerId === user.id);
}
