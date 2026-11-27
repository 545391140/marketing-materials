import { has } from "../shared/permissions.js";
import { roleList, people, effective } from "./roles.js";
import { need, manages, str, uid } from "./access.js";
import { recipient } from "./db.js";
import { selectFlow } from "../shared/approval.js";

export async function saveFlow(s, ctx, env, input) {
  const rules = s.approvalRules || (s.approvalRules = []);
  const prior = rules.find((r) => r.id === input.id);
  const bg = str(input.bg);
  need(has(ctx.u,"flow",bg) &&
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
    const roleId=str(step?.roleId);
    const role=roleId && roleList(s).find(r=>r.id===roleId && r.caps.includes("review"));
    need(!roleId || (role && !reviewerId),400,"请指定一个有审批权限的业务角色或人员");
    let reviewerName = role?.name || "";
    if (reviewerId && input.active) {
      const reviewer = await recipient(ctx, env, reviewerId);
      need(reviewer && has(effective(s,reviewer,ctx,env),"review",bg), 400, "审批账号须为该 BG 的有效审核人：" + reviewerId);
      reviewerName = reviewer.name;
    } else if (reviewerId) {
      reviewerName = prior?.steps.find((s) => s.reviewerId === reviewerId)?.reviewerName || reviewerId;
    }
    steps.push({ name: label, reviewerId, reviewerName, roleId });
  }
  const rule = { id: prior?.id || uid(), version: (prior?.version || 0) + 1,
    bg, priority, product, solution, type, name, active: input.active, steps };
  if (prior) Object.assign(prior, rule);
  else rules.push(rule);
  return rule;
}

export async function startApproval(s, draft, ctx, env) {
  const rule = selectFlow(s.approvalRules || [], draft);
  need(!rule.steps.some((step) => step.reviewerId === draft.author), 409,
    "提交人与流程中指定的审核人相同，请调整分工后再提交");
  for (const step of rule.steps) {
    const ids = step.reviewerId ? [step.reviewerId] : people(s,ctx)
      .filter(p=>p.active!==false && eligible(p,step)).map(p=>p.id);
    function eligible(p,step) {
      if(!p || p.id===draft.author) return false;
      const u=effective(s,p,ctx,env);
      return has(u,"review",draft.bg) && (!step.roleId ||
        u.scopes.some(g=>g.bg===draft.bg && g.ids.includes(step.roleId)));
    }
    let found=false;
    for(const id of ids) {
      const p=await recipient(ctx,env,id);
      if(eligible(p,step)) {found=true;break;}
    }
    need(found,409,"节点「"+step.name+"」没有可确认的审核人，请检查目录、BG 和角色授权");
  }
  return { ruleId: rule.id || "", version: rule.version || 0, name: rule.name,
    steps: rule.steps.map((step) => ({ ...step })), index: 0, token: uid() };
}
