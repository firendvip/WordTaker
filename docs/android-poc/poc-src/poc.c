// librime PoC: feed pinyin strings, print top candidates
#include <rime_api.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/time.h>

static double now_ms(void) {
  struct timeval tv; gettimeofday(&tv, NULL);
  return tv.tv_sec * 1000.0 + tv.tv_usec / 1000.0;
}

static void on_message(void* ctx, RimeSessionId sid, const char* type, const char* value) {
  fprintf(stderr, "[rime] %s: %s\n", type, value);
}

static void print_candidates(RimeApi* rime, RimeSessionId sid, const char* label) {
  RIME_STRUCT(RimeContext, context);
  if (!rime->get_context(sid, &context)) { printf("  (no context)\n"); return; }
  printf("%s | preedit: %s\n", label,
         context.composition.preedit ? context.composition.preedit : "(null)");
  for (int i = 0; i < context.menu.num_candidates && i < 9; ++i) {
    printf("  %d. %s\n", i + 1, context.menu.candidates[i].text);
  }
  rime->free_context(&context);
}

static void type_string(RimeApi* rime, RimeSessionId sid, const char* input) {
  for (const char* p = input; *p; ++p) rime->process_key(sid, (int)*p, 0);
}

int main(int argc, char** argv) {
  RimeApi* rime = rime_get_api();
  RIME_STRUCT(RimeTraits, traits);
  traits.shared_data_dir = "shared";
  traits.user_data_dir = "user";
  traits.app_name = "rime.poc";
  traits.distribution_name = "PoC";
  traits.distribution_code_name = "poc";
  traits.distribution_version = "0.1";

  double t0 = now_ms();
  rime->setup(&traits);
  rime->set_notification_handler(on_message, NULL);
  rime->initialize(&traits);
  if (rime->start_maintenance(True)) rime->join_maintenance_thread();
  double t1 = now_ms();
  fprintf(stderr, "[time] init+deploy: %.0f ms\n", t1 - t0);

  double t2 = now_ms();
  RimeSessionId sid = rime->create_session();
  if (!sid) { fprintf(stderr, "no session\n"); return 1; }
  // warm-up: schema load happens on first use
  rime->process_key(sid, 'a', 0);
  rime->clear_composition(sid);
  double t3 = now_ms();
  fprintf(stderr, "[time] session+schema load: %.0f ms\n", t3 - t2);

  const char* tests[] = {
    "zhongguorenmin",
    "jintiantianqizhenhaowomenyiqiqugongyuanba",
    "xianwaixiaomao",
    "yuyinshurufa",
    "nihao",
    "shurufa",
    "zhngguo",   // typo tolerance check
    "beijingdaxue",
  };
  for (size_t i = 0; i < sizeof(tests)/sizeof(tests[0]); ++i) {
    double ta = now_ms();
    type_string(rime, sid, tests[i]);
    double tb = now_ms();
    printf("\n=== input: %s (%.0f ms) ===\n", tests[i], tb - ta);
    print_candidates(rime, sid, "ctx");
    rime->clear_composition(sid);
  }

  // user-dict learning test: commit a novel phrase twice, see if it ranks up
  printf("\n=== learning test: commit '弦外小猫' char by char, then retype ===\n");
  type_string(rime, sid, "xianwai");
  print_candidates(rime, sid, "before");
  // select candidate 1 of first segment repeatedly to commit something
  rime->clear_composition(sid);

  rime->destroy_session(sid);
  rime->finalize();
  return 0;
}
