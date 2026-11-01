/* The monitor key cannot pass through the compiler's computed string-name
 * route. Exercise the dynamic runtime owner directly in a fresh process. */
#undef NDEBUG
#include "scr_runtime.h"
#include <assert.h>
#include <stdio.h>

static unsigned calls;
static ScrError *expected;

static void monitor(ScrClosure *self, ScrError *error) {
  (void)self;
  assert(error == expected);
  calls++;
}

static void empty_monitor(ScrClosure *self) {
  (void)self;
  calls++;
}

int main(void) {
  scr_init();
  assert(scr_ee_dyn == NULL);
  ScrEmitter *em = scr_emitter_new();
  ScrStr *key = scr_emitter_error_monitor(); /* Borrowed immortal symbol key. */
  expected = scr_error_new(SCR_ERR_ERROR, NULL);
  ScrDyn *value = scr_dyn_from_error(expected);
  assert(scr_ee_dyn == NULL);
  ScrClosure *cb = scr_closure_new((void *)&monitor, 0);
  scr_emitter_release(scr_emitter_on(em, key, cb, &scr_ee_inv_fixed1, false, false));
  assert(scr_ee_dyn == NULL);
  assert(!scr_exc_pending());
  assert(scr_emitter_emit_any(em, key, &value, 1));
  assert(scr_ee_dyn != NULL);
  assert(calls == 1);
  assert(!scr_exc_pending());
  scr_emitter_release(scr_emitter_off(em, key, cb));
  cb = scr_closure_new((void *)&empty_monitor, 0);
  scr_emitter_release(scr_emitter_on(em, key, cb, &scr_ee_inv_fixed0, false, false));
  assert(scr_emitter_emit_any(em, key, NULL, 0));
  assert(calls == 2);
  assert(!scr_exc_pending());
  scr_emitter_release(em);
  scr_dyn_release(value);
  scr_error_release(expected);
  puts("direct dynamic errorMonitor adapts fixed listeners");
  return 0;
}
