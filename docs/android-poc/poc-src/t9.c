
#include <rime_api.h>
#include <stdio.h>
static void type_str(RimeApi*r,RimeSessionId s,const char*t){for(const char*p=t;*p;++p)r->process_key(s,(int)*p,0);}
int main(int argc,char**argv){
  RimeApi*r=rime_get_api();RIME_STRUCT(RimeTraits,tr);
  tr.shared_data_dir="shared";tr.user_data_dir="user";tr.app_name="rime.poc";
  tr.distribution_name="PoC";tr.distribution_code_name="poc";tr.distribution_version="0.1";
  r->setup(&tr);r->initialize(&tr);
  if(r->start_maintenance(False))r->join_maintenance_thread();
  RimeSessionId s=r->create_session();
  if(!r->select_schema(s,"t9_poc")){printf("schema select failed\n");return 1;}
  const char*tests[]={"9426994269","64426","94848624","2454264"};
  const char*hint[]={"xianwaixianwai?","nihao(64426)","zhishuruf?","aiji?"};
  for(int i=0;i<4;++i){
    type_str(r,s,tests[i]);
    RIME_STRUCT(RimeContext,ctx);
    if(r->get_context(s,&ctx)){
      printf("input %s | preedit: %s\n",tests[i],ctx.composition.preedit?ctx.composition.preedit:"");
      for(int j=0;j<ctx.menu.num_candidates&&j<5;++j)printf("  %d. %s\n",j+1,ctx.menu.candidates[j].text);
      r->free_context(&ctx);
    }
    r->clear_composition(s);
  }
  r->destroy_session(s);r->finalize();return 0;}
