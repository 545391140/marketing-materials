export default {
  props:["lists","material","busy"],
  data(){return { name:"",selected:"" };},
  computed:{
    current(){return this.lists.find(x=>x.id===this.selected) || this.lists[0];}
  },
  methods:{
    t(key){return this.$root.tx(key);},
    async create(){
      const name=this.name.trim();
      if(!name || !await this.$root.action({op:"createOpportunity",name})) return;
      this.selected=this.lists.find(x=>x.name===name)?.id || "";
      this.name="";
    },
    add(mid){return this.$root.action({op:"saveOpportunityItem",listId:this.current.id,mid});},
    drop(key){return this.$root.action({op:"removeOpportunityItem",listId:this.current.id,key});},
    open(mid){this.$root.open(this.$root.d.materials.find(m=>m.id===mid));}
  },
  template:`<section class="opportunity-panel">
    <form class="tools-row" @submit.prevent="create"><label>{{t('新商机清单')}}<input v-model.trim="name" maxlength="80" :placeholder="t('客户或项目名称')"></label><button class="btn mini" :disabled="busy||!name">{{t('创建清单')}}</button></form>
    <div v-if="current" class="tools-row"><label>{{t('选择商机')}}<select :value="current.id" @change="selected=$event.target.value"><option v-for="l in lists" :value="l.id" :key="l.id">{{l.name}}</option></select></label><button v-if="material" class="btn" :disabled="busy" @click="add(material.id)">{{t('保存当前版本到清单')}}</button></div>
    <template v-if="!material && current"><div v-for="item in current.items" :key="item.key" class="manage-row"><div class="grow"><strong>{{item.title}}</strong><small>v{{item.version}} · {{t(item.status)}}</small></div><button v-if="item.mid" class="btn mini" @click="open(item.mid)">{{t('查看资料')}}</button><button v-if="item.status==='已换版'" class="btn mini" @click="add(item.mid)">{{t('采用新版')}}</button><button class="text-btn" @click="drop(item.key)">{{t('移出清单')}}</button></div><p v-if="!current.items.length" class="empty">{{t('从资料详情添加到这个商机。')}}</p></template>
  </section>`
};
