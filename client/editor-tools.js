import { call,card } from "./shared.js";

export const audienceCheck = {
  props:["material","accounts"],components:{"resource-card":card},
  data(){return {account:"",result:null,loading:false,error:"",seq:0};},
  watch:{account(){this.check();}},
  methods:{
    async check(){
      const seq=++this.seq;
      this.result=null;this.error="";
      if(!this.account){this.loading=false;return;}
      this.loading=true;
      try {
        const res=await call("admin/audience-preview",{id:this.material.id,userId:this.account});
        if(seq===this.seq)this.result=res;
      } catch(e){if(seq===this.seq)this.error=e.message;}
      finally{if(seq===this.seq)this.loading=false;}
    }
  },
  template:`<div class="content-ops"><h3>按账号核对发布效果</h3>
  <label>目标账号<select v-model="account"><option value="">选择销售或伙伴账号</option><option v-for="p in accounts.filter(p=>p.bgs.includes(material.bg))" :value="p.id">{{p.name}} · {{p.id}}</option></select></label>
  <p v-if="loading">正在核对权限…</p><p v-if="error" role="alert">{{error}}</p>
  <template v-if="result"><resource-card v-if="result.card" :m="result.card" :readonly="true" :preview-cover="result.card.coverId?'/api/admin/card-cover?id='+encodeURIComponent(material.id):''"/><p v-else class="notice">此账号看不到该资料卡片。</p>
  <ul><li v-for="f in result.files">{{f.name}} · {{f.reason}}</li></ul></template></div>`
};
export const reviewRecord={
  props:["material","accounts","busy"],
  data(){return {owner:this.material.ownerId || "",date:this.material.reviewOn || ""};},
  methods:{
    async save(confirm){if(await this.$root.action({op:"contentReview",id:this.material.id,version:this.material.version,reviewRevision:this.material.reviewRevision||0,ownerId:this.owner,reviewOn:this.date,confirm}))this.$emit("done");}
  },
  template:`<form class="form content-ops" @submit.prevent="save(false)"><h3>负责人和内容复核</h3><p>{{material.title}} · v{{material.version}}</p>
    <label>负责人<select required v-model="owner"><option value="">选择同 BG 编辑</option><option v-for="p in accounts.filter(p=>p.editorBgs.includes(material.bg))" :value="p.id">{{p.name}}</option></select></label>
    <label>下次复核日期<input type="date" required v-model="date"></label><p v-if="material.reviewedAt">上次确认 {{material.reviewedAt.slice(0,10)}}</p>
    <div class="action-row"><button class="btn" :disabled="busy">保存安排</button><button type="button" class="btn dark" :disabled="busy||!owner||!date" @click="save(true)">确认当前版本仍有效</button><button type="button" class="btn" @click="$emit('revise')">发起换版</button></div></form>`
};
export const gapPanel={
  data(){return {report:null,error:"",busy:false};},
  created(){this.load();},
  methods:{async load(){this.busy=true;this.error="";try{this.report=await call("admin/gaps");}catch(e){this.error=e.message;}finally{this.busy=false;}}},
  template:`<section class="content-ops"><button class="btn mini" @click="load" :disabled="busy">刷新报表</button><p role="alert" v-if="error">{{error}}</p>
  <template v-if="report"><section v-for="pair in [['terms','近 30 天无结果搜索'],['demand','近 30 天需求分布 · 国家 / 伙伴类型 / 主题']]"><h3>{{pair[1]}}</h3><table v-if="report[pair[0]].length"><thead><tr><th>项目</th><th>次数</th></tr></thead><tbody><tr v-for="r in report[pair[0]]"><td>{{r.label}}</td><td>{{r.count}}</td></tr></tbody></table><p v-else>暂无记录</p></section>
  <h3>已发布资料的目标伙伴权限</h3><p>按当前账号目录及资料默认受众核对，统计整份不可见或没有可下载附件的目标账号。</p><table v-if="report.inaccessible.length"><thead><tr><th>资料</th><th>目标账号</th><th>不可见</th><th>可看但无法下载</th></tr></thead><tbody><tr v-for="r in report.inaccessible"><td>{{r.title}} · {{r.bg}}</td><td>{{r.total}}</td><td>{{r.blocked}}</td><td>{{r.blockedDownload}}</td></tr></tbody></table><p v-else>当前目录内未发现目标账号权限缺口。</p></template></section>`
};
