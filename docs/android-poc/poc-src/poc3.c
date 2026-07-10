// PoC3: real user-dict learning — compose 弦外小猫 via global candidate index
#include <rime_api.h>
#include <stdio.h>
#include <string.h>

static void type_str(RimeApi* r, RimeSessionId s, const char* t) {
  for (const char* p = t; *p; ++p) r->process_key(s, (int)*p, 0);
}

static int select_text(RimeApi* r, RimeSessionId s, const char* want) {
  RimeCandidateListIterator it = {0};
  if (!r->candidate_list_begin(s, &it)) return -1;
  int idx = -1;
  while (r->candidate_list_next(&it)) {
    if (strcmp(it.candidate.text, want) == 0) { idx = it.index; break; }
    if (it.index > 200) break;
  }
  r->candidate_list_end(&it);
  if (idx >= 0) r->select_candidate(s, idx);
  return idx;
}

static void show_top(RimeApi* r, RimeSessionId s, const char* label, int n) {
  RIME_STRUCT(RimeContext, ctx);
  if (!r->get_context(s, &ctx)) return;
  printf("%s:\n", label);
  for (int i = 0; i < ctx.menu.num_candidates && i < n; ++i)
    printf("  %d. %s\n", i + 1, ctx.menu.candidates[i].text);
  r->free_context(&ctx);
}

int main(void) {
  RimeApi* r = rime_get_api();
  RIME_STRUCT(RimeTraits, tr);
  tr.shared_data_dir = "shared"; tr.user_data_dir = "user";
  tr.app_name = "rime.poc"; tr.distribution_name = "PoC";
  tr.distribution_code_name = "poc"; tr.distribution_version = "0.1";
  r->setup(&tr); r->initialize(&tr);
  if (r->start_maintenance(False)) r->join_maintenance_thread();
  RimeSessionId s = r->create_session();
  r->select_schema(s, "luna_pinyin_simp");

  printf("=== compose 弦外小猫 (pick 弦, 外, 小猫 across segments) ===\n");
  type_str(r, s, "xianwaixiaomao");
  const char* picks[] = {"弦", "外", "小猫"};
  for (int i = 0; i < 3; ++i) {
    int idx = select_text(r, s, picks[i]);
    printf("  pick %s -> global index %d\n", picks[i], idx);
    if (idx < 0) break;
  }
  RIME_STRUCT(RimeCommit, c);
  if (r->get_commit(s, &c)) { printf("  committed: %s\n", c.text); r->free_commit(&c); }

  printf("\n=== retype xianwaixiaomao ===\n");
  type_str(r, s, "xianwaixiaomao");
  show_top(r, s, "after learning", 3);
  r->clear_composition(s);

  printf("\n=== retype short: xianwai ===\n");
  type_str(r, s, "xianwai");
  show_top(r, s, "xianwai", 3);
  r->clear_composition(s);

  r->destroy_session(s); r->finalize();
  return 0;
}
