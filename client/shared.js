import Vue from "vue";
import {
  Search,
  Compass,
  Library,
  Layers,
  Bookmark,
  BriefcaseBusiness,
  ClipboardCheck,
  MessagesSquare,
  ArrowUpRight,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  SlidersHorizontal,
  Globe2,
  Bell,
  X,
  Plus,
  Check,
  Menu,
  Download,
  Eye,
  FileText,
  CalendarDays,
  Grid2x2,
  Clock3,
  FolderOpen,
  Inbox,
  Send,
  Filter,
  MapPin,
  ExternalLink,
  PenLine,
  UploadCloud,
  PanelTop,
  ShieldCheck,
  UserRound,
  BookOpen,
  Settings2,
  Building2,
  Tag,
  ArrowLeft,
  UsersRound,
  ListChecks,
  PackageOpen,
  Image as ImageIcon,
  LayoutGrid,
  CheckCircle2,
  Minus,
  MessageCircleMore,
  Headphones,
  ClipboardList,
  NotebookPen,
  Activity,
  RefreshCw,
} from "lucide-vue";
const icons = {
  Search,
  Compass,
  Library,
  Layers,
  Bookmark,
  BriefcaseBusiness,
  ClipboardCheck,
  MessagesSquare,
  ArrowUpRight,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  SlidersHorizontal,
  Globe2,
  Bell,
  X,
  Plus,
  Check,
  Menu,
  Download,
  Eye,
  FileText,
  CalendarDays,
  Grid2x2,
  Clock3,
  FolderOpen,
  Inbox,
  Send,
  Filter,
  MapPin,
  ExternalLink,
  PenLine,
  UploadCloud,
  PanelTop,
  ShieldCheck,
  UserRound,
  BookOpen,
  Settings2,
  Building2,
  Tag,
  ArrowLeft,
  UsersRound,
  ListChecks,
  PackageOpen,
  ImageIcon,
  LayoutGrid,
  CheckCircle2,
  Minus,
  MessageCircleMore,
  Headphones,
  ClipboardList,
  NotebookPen,
  Activity,
  RefreshCw,
};
Vue.component("ic", {
  functional: true,
  props: { n: String, size: { default: 18 } },
  render(h, c) {
    return h(icons[c.props.n] || FileText, {
      attrs: {
        width: c.props.size,
        height: c.props.size,
        "stroke-width": 1.7,
        "aria-hidden": "true",
      },
      class: c.data.staticClass,
    });
  },
});
export const rules = () => [
  { role: "全部", bg: "EBG", region: "全部", country: "全部", channel: "全部" },
];
export const date = (s) => (s || "").slice(0, 10).replaceAll("-", ".");
export const entryPath = () => location.pathname.match(/^\/(oa|pc)(?:\/as\/[^/]+)?(?=\/)/)?.[0] || "";
export function fileUrl(m, f, mode = "preview", draft = false) {
  const q = new URLSearchParams({
    m: m.id,
    f: f.id,
    mode,
    draft: draft ? "1" : "0",
  });
  return entryPath() + "/api/file?" + q;
}
export async function call(path, body) {
  const r = await fetch(
    entryPath() + "/api/" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "x-material-client": "hub",
            ...(body instanceof FormData
              ? {}
              : { "content-type": "application/json" }),
          },
          body: body instanceof FormData ? body : JSON.stringify(body),
        },
  );
  const j = await r.json();
  if (!r.ok) throw Error(j.error || "请求失败");
  return j;
}
export const tasks = ["准备客户拜访", "回应客户问题", "准备投标"];
export const card = {
  props: ["m", "saved", "lang", "previewCover", "readonly"],
  methods: {
    date, entryPath,
    formats(m) { return [...new Set(m.files.map(f=>f.ext.toUpperCase()))].join("、"); },
    usages(m) { return [...new Set(m.files.map(f=>this.txt(f.usage)))].join(" · "); },
    txt(s) {
      return this.$root.tx(s);
    },
  },
  template:
    `<article class="resource"><button type="button" class="card-image" @click="$emit('open',m)" :aria-label="m.title"><img :src="previewCover || (m.coverId?entryPath()+'/api/cover?m='+m.id:'/img/'+m.img+'.webp')" :alt="m.title" loading="lazy"><span class="badge badge-photo">{{txt(m.type)}}</span></button><button v-if="!readonly && $root.canFront('personal')" type="button" class="bookmark" :class="{saved}" @click="$emit('fav',m)" :aria-pressed="String(saved)" :aria-label="txt(saved?'已收藏':'收藏')"><ic n="Bookmark" :size="16"/></button><div class="resource-body"><div class="resource-tags"><span>{{m.industry}}</span><i></i><span>{{m.cat}}</span></div><button class="card-name" @click="$emit('open',m)">{{lang==='en'&&m.en?m.en:m.title}}</button><p>{{m.summary}}</p><div class="market-meta">{{m.language || txt('语言待标注')}} · {{(m.markets || []).join(' / ') || txt('适用国家待标注')}} · v{{m.version}}</div><small class="usage-summary">{{usages(m)}}</small><div class="resource-foot"><span class="filetype"><ic n="FileText" :size="13"/>{{formats(m)}} · {{m.files.length}} {{txt('个附件')}}</span><span>{{date(m.updated)}}</span></div></div></article>`,
};
