import { need, manages, str, uid } from "./access.js";
import { recipient } from "./db.js";
import { selectFlow } from "../shared/approval.js";

export async function saveFlow(s, ctx, env, input) {
  const rules = s.approvalRules || (s.approvalRules = []);
  const prior = rules.find((r) => r.id === input.id);
  const bg = str(input.bg);
  need(ctx.u.role === "reviewer" && manages(ctx.u, { bg }) &&
    (!input.id || (prior && prior.bg === bg)), 403, "无权配置该 BG 的流程");
  if (prior) need(prior.version === input.version, 409, "配置已有更新，请重新打开");
  const name = str(input.name, 100);
  const priority = Number(input.priority);
  need(name && Number.isInteger(priority) && priority >= 1 && priority <= 9999 &&
    typeof input.active === "boolean", 400, "请填写流程名称及 1 至 9999 的优先级");
  need(!input.active || !rules.some((r) => r.id !== prior?.id && r.active && r.bg === bg &&
    r.priority === priority), 409, "同一 BG 的启用流程须使用不同优先级");
  const product = str(input.product), solution = str(input.solution), type = str(input.type);
  need((!product || s.library.products?.includes(product)) &&
    (!solution || s.library.solutions?.includes(solution)) &&
    (!type || s.library.types.some((t) => t.name === type)), 400, "请使用目录中的产品、方案和资料类型");
  need(Array.isArray(input.steps) && input.steps.length >= 1 && input.steps.length <= 10,
    400, "请配置 1 至 10 个审批节点");
  const steps = [];
  for (const step of input.steps) {
    const label = str(step?.name, 100), reviewerId = str(step?.reviewerId);
    need(label, 400, "每个审批节点都要填写名称");
    let reviewerName = "";
    if (reviewerId && input.active) {
      const reviewer = await recipient(ctx, env, reviewerId);
      need(reviewer?.role === "reviewer" && manages(reviewer, { bg }), 400, "审批账号须为该 BG 的有效审核人：" + reviewerId);
      reviewerName = reviewer.name;
    } else if (reviewerId) {
      reviewerName = prior?.steps.find((s) => s.reviewerId === reviewerId)?.reviewerName || reviewerId;
    }
    steps.push({ name: label, reviewerId, reviewerName });
  }
  const rule = { id: prior?.id || uid(), version: (prior?.version || 0) + 1,
    bg, priority, product, solution, type, name, active: input.active, steps };
  if (prior) Object.assign(prior, rule);
  else rules.push(rule);
  return rule;
}

export function startApproval(s, draft) {
  const rule = selectFlow(s.approvalRules || [], draft);
  need(!rule.steps.some((step) => step.reviewerId === draft.author), 409,
    "提交人与流程中指定的审核人相同，请调整分工后再提交");
  return { ruleId: rule.id || "", version: rule.version || 0, name: rule.name,
    steps: rule.steps.map((step) => ({ ...step })), index: 0, token: uid() };
}
