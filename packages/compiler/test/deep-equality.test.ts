import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

test("native deep equality keeps opaque values and accessors explicitly refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-deep-equality-"));
  try {
    const entry = join(dir, "main.cjs");
    writeFileSync(
      entry,
      `
const { isDeepStrictEqual: equal } = require("node:util");
/** @param {any} value */
function dyn(value) { return value; }
function attempt(a, b) {
  try { console.log(equal(a, b)); }
  catch (error) { console.log(error.name, error.code, error.message); }
}
class Value { value = 1; }
attempt(new Value(), new Value());
attempt(new Map([[1, 2]]), new Map([[1, 2]]));
attempt(new Set([1]), new Set([1]));
attempt(new Error("fail"), new Error("fail"));
class Failure extends Error {}
attempt(new Failure("fail"), new Failure("fail"));
attempt({ error: new Error("fail") }, { error: new Error("fail") });
const sameError = new Failure("same");
attempt(sameError, sameError);
let getterCalls = 0;
Object.defineProperty(dyn(sameError), "extra", {
  get() { getterCalls++; throw new Error("must not read"); },
  enumerable: true,
});
attempt(sameError, new Failure("other"));
console.log("Error getters", getterCalls);
attempt({ get value() { return 1; } }, { value: 1 });
const ctor = () => 1;
attempt({ constructor: ctor }, { constructor: ctor });
console.log("after");
`,
    );
    const result = await compile(entry, {
      sanitize: process.env["SCRIPTC_SAN"] === "1",
      outDir: dir,
      outPath: join(dir, "program"),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    if (!result.ok) return;
    const child = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe(
      "TypeError SC2020 util.isDeepStrictEqual over opaque native references is not supported yet\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native handles is not supported yet\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native handles is not supported yet\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native Error values is not supported yet\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native Error values is not supported yet\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native Error values is not supported yet\n" +
        "true\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native Error values is not supported yet\n" +
        "Error getters 0\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native accessor properties is not supported yet\n" +
        "TypeError SC2020 util.isDeepStrictEqual over native own constructor functions is not supported yet\nafter\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
