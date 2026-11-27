import template from "./system-admin.html";
import { permissions, groups, has, front } from "../shared/permissions.js";
import { call } from "./shared.js";
export default {
  template,
  props: ["admin", "section", "user", "busy"],
  data: () => ({
    q: "",
    role: null,
    person: null,
    bg: "",
    ids: [],
    who: "",
    mid: "",
    reason: "",
    to: "",
    result: null,
    error: "",
    transfer: null,
    permissions,
    groups,
  }),
  computed: {
    menuCatalog() {
      return [
        [
          "伙伴与销售前台",
          [
            ["资料发现", "", ["browse"]],
            ["资料库", "", ["browse"]],
            ["场景包", "", ["kits"]],
            ["我的工作台", "", ["personal"]],
          ],
        ],
        ...groups,
      ];
    },
    system() {
      return this.admin.system || { accounts: [], roles: [] };
    },
    allowedRoles() {
      return this.system.roles.filter(
        (r) =>
          (this.person?.role !== "partner" ||
            r.caps.every((k) => front.includes(k))) &&
          (this.user.root ||
            !r.caps.some((k) =>
              [
                "users",
                "roles",
                "diagnose",
                "flow",
                "audit",
                "catalog",
              ].includes(k)
            ))
      );
    },
    mayAssign() {
      return (
        this.person &&
        !this.person.root &&
        this.bg &&
        this.person.active !== false &&
        (this.user.root ||
          (this.person.id !== this.user.id &&
            has(this.user, "users", this.bg) &&
            this.person.scopes
              .find((g) => g.bg === this.bg)
              ?.ids.every((id) => this.allowedRoles.some((r) => r.id === id))))
      );
    },
    rows() {
      return this.system.accounts.filter((p) =>
        [p.name, p.id, p.org]
          .join(" ")
          .toLowerCase()
          .includes(this.q.trim().toLowerCase())
      );
    },
    pending() {
      return this.admin.drafts.filter(
        (d) => d.state === "待审核" && has(this.user, "flow", d.bg)
      );
    },
  },
  methods: {
    editRole(r) {
      this.role = r
        ? { ...r, caps: [...r.caps] }
        : { id: "", name: "", caps: [] };
    },
    select(p) {
      this.person = p;
      this.bg = p.scopes[0]?.bg || "";
      this.pick();
    },
    pick() {
      this.ids = [
        ...(this.person.scopes.find((g) => g.bg === this.bg)?.ids || []),
      ];
    },
    names(ids) {
      return (
        ids
          .map((id) => this.system.roles.find((r) => r.id === id)?.name || id)
          .join("、") || "无角色"
      );
    },
    async save(a) {
      if (await this.$root.action(a)) {
        this.role = null;
        this.person = null;
        this.transfer = null;
        this.error = "";
      }
    },
    async check() {
      this.result = null;
      this.error = "";
      try {
        this.result = await call("diagnose", {
          id: this.mid,
          userId: this.who,
        });
      } catch (e) {
        this.error = e.message;
      }
    },
  },
};
