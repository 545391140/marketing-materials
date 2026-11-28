export const permissions = {
  browse: "资料发现与资料库",
  kits: "浏览场景包",
  personal: "我的工作台",
  request: "提交资料需求",
  download: "下载已授权附件",
  read: "查阅资料台账",
  edit: "上传、编辑与送审",
  withdraw: "下架资料",
  review: "处理审批节点",
  demand: "处理资料需求",
  assign: "分派需求",
  kitEdit: "编排场景包",
  catalog: "维护分类与类型",
  flow: "流程配置与转派",
  audit: "查看操作记录",
  users: "用户与 BG 授权",
  roles: "维护角色与菜单权限",
  diagnose: "查询权限原因",
};
export const front = ["browse", "kits", "personal", "request", "download"];
export const groups = [
  [
    "工作台",
    [
      [
        "运营待办",
        "ListChecks",
        ["read", "edit", "review", "demand", "flow", "kitEdit"],
      ],
      ["发布审核", "ShieldCheck", ["review"]],
    ],
  ],
  [
    "内容管理",
    [
      ["资料管理", "Library", ["read", "edit", "withdraw"]],
      ["待整理附件", "UploadCloud", ["edit"]],
      ["场景包", "Layers", ["kitEdit"]],
      ["分类与类型", "Settings2", ["catalog"]],
    ],
  ],
  ["需求管理", [["需求池", "Inbox", ["demand", "assign"]], ["资料缺口报表","Activity",["demand","audit"]]]],
  [
    "流程管理",
    [
      ["审批流程", "ListChecks", ["flow"]],
      ["在途审批", "Clock3", ["flow"]],
    ],
  ],
  [
    "系统管理",
    [
      ["用户管理", "UsersRound", ["users"]],
      ["角色管理", "UsersRound", ["roles"]],
      ["菜单权限", "Settings2", ["roles"]],
      ["权限诊断", "ShieldCheck", ["diagnose"]],
      ["操作记录", "Activity", ["audit"]],
    ],
  ],
];
const role = (id, name, caps) => ({ id, name, caps, builtin: true });
export const builtins = [
  role("viewer", "资料使用者", front),
  role("editor", "内容编辑", [
    ...front,
    "read",
    "edit",
    "withdraw",
    "demand",
    "kitEdit",
  ]),
  role("reviewer", "发布审核员", [...front, "read", "review"]),
  role("product", "产品经理", ["read", "review"]),
  role("operations", "渠道运营经理", [
    "read",
    "review",
    "demand",
    "assign",
    "catalog",
  ]),
  role("flow", "流程管理员", ["flow"]),
  role("bgAdmin", "BG 用户管理员", ["users", "diagnose", "audit"]),
];
export function has(u, key, bg) {
  return (u?.scopes || []).some(
    (s) => (!bg || s.bg === bg) && s.caps.includes(key)
  );
}
export function any(u, keys, bg) {
  return keys.some((key) => has(u, key, bg));
}
export const materialCaps = ["read", "edit", "review", "withdraw", "flow"];
export const menus = (u) =>
  groups
    .map(([group, items]) => [
      group,
      items.filter(([, , keys]) => any(u, keys)),
    ])
    .filter(([, items]) => items.length);
