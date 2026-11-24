import { ALL, countriesOf, values } from "../shared/audience.js";
import { rules } from "./shared.js";

const optionsFor = (catalog, key) => key === "country" ? catalog.countries : catalog.partnerTypes;
const formValue = (r, k) => k === "country" ? countriesOf(r) : r.channel;
const labelFor = (opts, code) => opts.find((o) => o.value === code)?.label || code;
const labels = (opts, value) => values(value).map((v) => labelFor(opts, v)).join("、");

const scopePicker = {
  props: ["value", "options", "label"],
  data: () => ({ search: "", open: false }),
  computed: {
    selected() { return values(this.value); },
    caption() { return labels(this.options, this.value) || "请选择"; },
    choices() {
      const extra = this.selected.filter((v) => v !== ALL && !this.options.some((o) => o.value === v));
      const q = this.search.trim().toLowerCase();
      return [...this.options, ...extra.map((value) => ({value, label: value}))]
        .filter((o) => (o.label + " " + o.value).toLowerCase().includes(q));
    },
  },
  methods: {
    toggle(value, checked) {
      if (value === ALL) return this.$emit("input", checked ? ALL : []);
      const selected = this.selected.filter((v) => v !== ALL && v !== value);
      if (checked) selected.push(value);
      this.$emit("input", selected);
    },
  },
  template: `<div class="scope-field"><span>{{label}}</span><details class="scope-picker" @toggle="open=$event.target.open">
    <summary :aria-label="label+'：'+caption">{{caption}}</summary><div v-if="open" class="scope-options">
    <input type="search" v-model="search" :aria-label="'搜索'+label" :placeholder="'搜索'+label">
    <label class="tick"><input type="checkbox" :checked="value==='全部'" @change="toggle('全部',$event.target.checked)">全部</label>
    <label v-for="o in choices" :key="o.value" class="tick"><input type="checkbox" :checked="selected.includes(o.value)" @change="toggle(o.value,$event.target.checked)">{{o.label}}</label>
    <small v-if="!choices.length">没有匹配选项</small></div></details></div>`,
};

export const ruleEditor = {
  props: ["value", "catalog"],
  components: { scopePicker },
  methods: {
    countriesOf,
    add() { this.$emit("input", [...this.value, { ...rules()[0], role: "伙伴", country: [], channel: [] }]); },
    remove(i) { this.$emit("input", this.value.filter((_, j) => j !== i)); },
  },
  template: `<div class="rule-editor"><fieldset class="scope-group" v-for="(r,i) in value" :key="i">
    <legend>授权组 {{i+1}}</legend><div class="scope-line">
    <label>身份<select v-model="r.role"><option v-for="s in [...new Set(['全部','员工','伙伴',r.role])]" :value="s">{{s}}</option></select></label>
    <label>BG<input v-model.trim="r.bg"></label><label>区域<input v-model.trim="r.region"></label>
    <scope-picker label="国家" :value="countriesOf(r)" :options="catalog.countries" @input="$set(r,'country',$event)"/>
    <scope-picker label="伙伴类型" v-model="r.channel" :options="catalog.partnerTypes"/>
    </div><button type="button" class="text-btn" @click="remove(i)">移除本组</button></fieldset>
    <p v-if="!value.length" class="muted">无人获准</p>
    <button type="button" class="text-btn" @click="add" :disabled="value.length>=25"><ic n="Plus" :size="14"/>添加授权组</button></div>`,
};

function describe(rule, catalog) {
  return [rule.role, "BG "+rule.bg, "区域 "+rule.region,
    ...[["country", "国家"], ["channel", "伙伴类型"]].map(([key, label]) =>
      label+" "+labels(optionsFor(catalog, key), formValue(rule, key)))].join(" · ");
}
const signature = (r) => JSON.stringify([r.role, r.bg, r.region,
  [...values(countriesOf(r))].sort(), [...values(r.channel)].sort()]);

export const reviewScope = {
  props: ["title", "rules", "previous", "catalog"],
  computed: {
    rows() {
      const now = this.rules || [], before = this.previous || [];
      const oldKeys = new Set(before.map(signature)), newKeys = new Set(now.map(signature));
      return [
        ...now.map((r) => ({ text: describe(r, this.catalog), change:
          this.previous && !oldKeys.has(signature(r)) ? "新增授权组" : "" })),
        ...before.filter((r) => !newKeys.has(signature(r))).map((r) =>
          ({ text: describe(r, this.catalog), change: "移除授权组" })),
      ];
    },
  },
  template: `<section class="review-scope"><strong>{{title}}</strong><p v-if="!rules.length">无人获准</p><p v-for="row in rows"><b v-if="row.change">{{row.change}} · </b>{{row.text}}</p></section>`,
};
