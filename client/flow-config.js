import { has } from "../shared/permissions.js";
import template from "./flow-config.html";

const step = () => ({ roleId:"", name: "", reviewerId: "" });
export default {
  template,
  props: ["admin", "user", "demo", "choices", "busy"],
  data: () => ({ form: null, error: "" }),
  methods: {
    canFlow(bg){return has(this.user,"flow",bg);},
    edit(rule) {
      this.error = "";
      this.form = rule ? JSON.parse(JSON.stringify(rule)) : {
        name: "", bg: this.admin.managementBgs.find(bg=>this.canFlow(bg)), priority: 10, product: "", solution: "",
        type: "", active: true, steps: [step()],
      };
    },
    add() { this.form.steps.push(step()); },
    move(i, delta) {
      const list = this.form.steps;
      list.splice(i + delta, 0, list.splice(i, 1)[0]);
    },
    async save() {
      this.error = "";
      if (await this.$root.action({ ...this.form, op: "saveFlow" }, "审批流程已保存"))
        this.form = null;
      else this.error = this.$root.err;
    },
  },
};
