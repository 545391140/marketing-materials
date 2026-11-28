import {call} from "./shared.js";
export default {
  props:["material","shares","busy"],
  data(){return {selected:[],downloads:[],days:7,pending:false,error:"",recent:"",confirmId:"",copyText:""};},
  computed:{
    eligible(){return this.material?.files.filter(f=>f.canShare)||[];},
    made(){return this.shares.find(x=>x.id===this.recent);}
  },
  methods:{
    t(s){return this.$root.tx(s);},
    when(d){return new Date(d).toLocaleString();},
    async create(){
      if(this.pending || !this.selected.length) return;
      this.pending=true;this.error="";
      try{
        const result=await call("shares",{mid:this.material.id,version:this.material.version,files:this.selected,
          downloads:this.downloads.filter(id=>this.selected.includes(id)),days:this.days});
        this.recent=result.id;
        await this.$root.refresh();
      }catch(e){this.error=e.message;}finally{this.pending=false;}
    },
    async copy(link){
      if(!link?.path)return;
      this.copyText="";
      try{await navigator.clipboard.writeText(link.path);this.$root.toast(this.t("已复制客户链接"));}
      catch{this.copyText=link.path;}
    },
    async close(id){
      if(await this.$root.action({op:"closeShare",id})){this.confirmId="";this.copyText="";}
    },
    openCurrent(link){const m=this.$root.d.materials.find(x=>x.id===link.mid);if(m)this.$root.open(m);}
  },
  template:`<section class="share-controls">
    <template v-if="material"><h3>{{t('分享给客户')}}</h3><p>{{t('链接固定至当前版本')}} v{{material.version}} · {{t('持链接可访问')}}</p>
    <div v-for="f in eligible" :key="f.id" class="share-file"><label><input type="checkbox" :value="f.id" v-model="selected">{{f.name}}</label>
    <label v-if="f.customerDownload && selected.includes(f.id)"><input type="checkbox" :value="f.id" v-model="downloads">{{t('允许客户下载原件')}}</label><small v-else>{{t('仅预览')}}</small></div>
    <div class="tools-row"><label>{{t('链接有效期')}} <select v-model.number="days"><option v-for="n in [1,7,30]" :value="n">{{n}} {{t('天')}}</option></select></label>
    <button class="btn red" :disabled="pending||!selected.length" @click="create">{{t('生成分享链接')}}</button></div>
    <div v-if="made && made.path" class="notice"><a :href="made.path" target="_blank" rel="noreferrer">{{t('打开客户链接')}}</a><button class="btn mini" @click="copy(made)">{{t('复制链接')}}</button></div></template>
    <template v-else><div class="manage-row" v-for="x in shares" :key="x.id"><div class="grow"><strong>{{x.title}} · v{{x.version}}</strong><small>{{x.count}} {{t('个附件')}} · {{t(x.status)}} · {{when(x.expiresAt)}} {{t('到期')}}</small><small v-if="x.latest>x.version">{{t('已有新版')}} v{{x.latest}}</small></div>
    <button v-if="x.path" class="btn mini" @click="copy(x)">{{t('复制链接')}}</button><button v-if="x.latest>x.version && $root.d.materials.some(m=>m.id===x.mid)" class="btn mini" @click="openCurrent(x)">{{t('查看新版')}}</button>
    <button v-if="!['已关闭','已到期'].includes(x.status)" class="btn mini" @click="confirmId===x.id?close(x.id):confirmId=x.id">{{t(confirmId===x.id?'确认关闭链接':'关闭分享')}}</button></div>
    <p v-if="!shares.length" class="empty">{{t('还没有客户分享链接')}}</p></template>
    <label v-if="copyText">{{t('可手动复制链接')}}<input readonly :value="copyText" @focus="$event.target.select()"></label><p v-if="error" role="alert">{{error}}</p>
  </section>`
};
