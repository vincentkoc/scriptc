import { expect, test } from "vitest";
import { VOID, type IrModule, type IrType } from "../../ir/ir.js";
import { LlEmitter } from "./emitter.js";

const error: IrType = { kind: "object", className: "%Error" };
function emitter(): LlEmitter {
  const loc = { file: "error-check.ts", start: 0, end: 0 };
  const module: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [{ name: "main", params: [], returnType: VOID, locals: [], body: [], loc }],
  };
  return new LlEmitter(module, {});
}

test("Error union matching checks the brand without extracting a typed mirror", () => {
  const host = emitter();
  const name = host.dyn.dynMatchHelper(error);
  const body = host.dyn.defs.join("\n").split(`@${name}(ptr %d)`)[1]!;
  expect(body).toMatch(/call zeroext i1 @scr_dyn_ref_is_error\(ptr %d\)/);
  expect(body).toMatch(/br i1 %\w+, label %dm\.err\.brand\d+, label %dm\.err\.encoding\d+/);
  expect(body).toMatch(/dm\.err\.brand\d+:\n  ret i1 true/);
  expect(body).toContain("@scr_dyn_obj_get");
  expect(body).not.toContain("@scr_error_from_dyn");
});

test("checked Error extraction keeps the native cache fast path and admits branded handles", () => {
  const host = emitter();
  const name = host.dyn.dynCheckHelper(error);
  const body = host.dyn.defs.join("\n").split(`@${name}(ptr %d, ptr %path)`)[1]!;
  expect(body.indexOf("@scr_errdyn_err_of")).toBeGreaterThanOrEqual(0);
  expect(body.indexOf("@scr_dyn_ref_is_error")).toBeGreaterThan(body.indexOf("@scr_errdyn_err_of"));
  expect(body).toMatch(/br i1 %\w+, label %dce\.g\d+, label %dce\.encoding\d+/);
  expect(body).toMatch(
    /dce\.g\d+:\n  %\w+ = call ptr @scr_error_from_dyn\(ptr %d\)\n  ret ptr %\w+/,
  );
  expect(body).toContain("@scr_dyn_check_fail");
  expect(body).toContain("@scr_dyn_obj_get");
});
