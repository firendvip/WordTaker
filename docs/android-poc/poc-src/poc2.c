// PoC2: simplified schema, user-dict learning, candidate selection
#include <rime_api.h>
#include <stdio.h>
#include <string.h>

static void print_cands(RimeApi* rime, RimeSessionId sid, const char* label) {
  RIME_STRUCT(RimeContext, ctx);
  if (!rime->get_context(sid, &ctx)) return;
  printf("%s | preedit: %s\n", label, ctx.composition.preedit ? ctx.composition.preedit : "");
  for (int i = 0; i < ctx.menu.num_candidates && i < 5; ++i)
    printf("  %d. %s\n", i + 1, ctx.menu.candidates[i].text);
  rime->free_context(&ctx);
}

static void type_str(RimeApi* rime, RimeSessionId sid, const char* s) {
  for (const char* p = s; *p; ++p) rime->process_key(sid, (int)*p, 0);
}

static void commit_and_show(RimeApi* rime, RimeSessionId sid) {
  RIME_STRUCT(RimeCommit, commit);
  if (rime->get_commit(sid, &commit)) {
    printf("  committed: %s\n", commit.text);
    rime->free_commit(&commit);
  }
}

int main(void) {
  RimeApi* rime = rime_get_api();
  RIME_STRUCT(RimeTraits, traits);
  traits.shared_data_dir = "shared";
  traits.user_data_dir = "user";
  traits.app_name = "rime.poc";
  traits.distribution_name = "PoC";
  traits.distribution_code_name = "poc";
  traits.distribution_version = "0.1";
  rime->setup(&traits);
  rime->initialize(&traits);
  if (rime->start_maintenance(False)) rime->join_maintenance_thread();

  RimeSessionId sid = rime->create_session();
  rime->select_schema(sid, "luna_pinyin_simp");

  printf("=== simp: zhongguorenmin ===\n");
  type_str(rime, sid, "zhongguorenmin");
  print_cands(rime, sid, "ctx");
  rime->clear_composition(sid);

  printf("\n=== learning: type xianwaixiaomao, pick 弦 外 小 猫 char by char ===\n");
  type_str(rime, sid, "xianwaixiaomao");
  print_cands(rime, sid, "round1");
  // navigate to compose 弦外小猫 by selecting per-segment candidates
  // find & select "弦" then "外" then "小猫"
  for (int seg = 0; seg < 6; ++seg) {
    RIME_STRUCT(RimeContext, ctx);
    if (!rime->get_context(sid, &ctx)) break;
    if (!ctx.composition.preedit || ctx.menu.num_candidates == 0) { rime->free_context(&ctx); break; }
    int pick = -1;
    const char* wants[] = {"弦", "外", "小猫", "小", "猫"};
    for (int i = 0; i < ctx.menu.num_candidates; ++i) {
      for (int w = 0; w < 5; ++w)
        if (strcmp(ctx.menu.candidates[i].text, wants[w]) == 0) { pick = i; break; }
      if (pick >= 0) break;
    }
    if (pick < 0) pick = 0;
    printf("  seg%d picking: %s\n", seg, ctx.menu.candidates[pick].text);
    rime->free_context(&ctx);
    rime->select_candidate_on_current_page(sid, pick);
    RIME_STRUCT(RimeStatus, st);
    rime->get_status(sid, &st);
    int composing = st.is_composing;
    rime->free_status(&st);
    if (!composing) break;
  }
  commit_and_show(rime, sid);

  printf("\n=== retype xianwaixiaomao (expect 弦外小猫 ranked #1) ===\n");
  type_str(rime, sid, "xianwaixiaomao");
  print_cands(rime, sid, "round2");
  rime->clear_composition(sid);

  printf("\n=== prediction after committing 语音 (type yuyin, select, then check) ===\n");
  type_str(rime, sid, "yuyin");
  rime->select_candidate_on_current_page(sid, 0);
  commit_and_show(rime, sid);

  rime->destroy_session(sid);
  rime->finalize();
  return 0;
}
