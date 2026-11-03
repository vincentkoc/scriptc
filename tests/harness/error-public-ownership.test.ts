import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import {
  mangleClassGcFree,
  mangleClassNew,
  mangleClassReleaseDirect,
  mangleClassTrace,
} from "../../packages/compiler/src/backend/mangle.js";

const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const shared = `
const requiredSymbol = Symbol("required");
const publicSymbol = Symbol("public");
class OwnedError extends Error {
  next: OwnedError | null = null;
  [requiredSymbol] = 1;
  constructor(readonly tag: number) { super("owned " + tag); }
}
function dyn(value: unknown): any {
  return value;
}
function readPayload(error: Error): number {
  return Object.getOwnPropertyDescriptor(dyn(error), "payload")!.value.tag;
}
`;
const ordinary = `
function probe(error: any): any {
  Object.defineProperty(error, publicSymbol, { get: function (this: unknown) { return this; } });
  if (error[publicSymbol] !== error) throw new Error("lost nested receiver");
  return error;
}
function recordProbe(value: any): any { return probe(value.child); }
function arrayProbe(value: any): any { return probe(value[0]); }
function unionProbe(value: OwnedError | { other: number }): any { return probe(value); }
function nested(): void {
  const recordError = new OwnedError(1);
  const record: { child: OwnedError } = { child: recordError };
  if (recordProbe(record) !== dyn(recordError)) throw new Error("record identity");
  const arrayError = new OwnedError(2);
  const array: OwnedError[] = [arrayError];
  if (arrayProbe(array) !== dyn(arrayError)) throw new Error("array identity");
  const unionError = new OwnedError(3);
  if (unionProbe(unionError) !== dyn(unionError)) throw new Error("union identity");
  let refused = false;
  try { delete dyn(unionError)[requiredSymbol]; }
  catch (error) { refused = error instanceof TypeError; }
  if (!refused || unionError[requiredSymbol] !== 1 || dyn(unionError)[requiredSymbol] !== 1)
    throw new Error("required symbol deletion changed native state");
}
function ordinary(): void {
  nested();
  for (let i = 0; i < 100; i++) {
    const error = new OwnedError(i);
    error.next = new OwnedError(-1);
    Object.defineProperty(dyn(error), "payload", { value: { tag: i }, configurable: true });
    const base: Error = error;
    if (readPayload(base) !== i) throw new Error("lost public state");
  }
  console.log("ordinary ownership passed");
}
ordinary();
`;
const cyclic = `
function cycle(i: number): Error {
  const error = new OwnedError(i);
  Object.defineProperty(dyn(error), "owner", { value: () => error });
  Object.defineProperty(dyn(error), "payload", { value: { tag: i } });
  return error;
}
function cyclic(): void {
  const held: Error = cycle(999);
  for (let i = 0; i < 100; i++) {
    const error = cycle(i);
    const owner = Object.getOwnPropertyDescriptor(dyn(error), "owner")!.value;
    if (owner() !== error || readPayload(error) !== i) throw new Error("lost cyclic state");
  }
  const owner = Object.getOwnPropertyDescriptor(dyn(held), "owner")!.value;
  if (owner() !== held || readPayload(held) !== 999) throw new Error("collected held alias");
  console.log("cyclic ownership passed");
}
cyclic();
`;

function definition(llvm: string, symbol: string): string {
  return (
    llvm
      .split(/^define /m)
      .find(
        (body) =>
          body.startsWith("internal ") &&
          body.slice(0, body.indexOf("\n")).includes("@" + symbol + "("),
      ) ?? ""
  );
}

function errorPaths(llvm: string): string {
  const className = /; new ([^\n]*OwnedError)\n/.exec(llvm)?.[1];
  expect(className).toBeDefined();
  if (className === undefined) throw new Error("native Error allocator missing");
  const create = mangleClassNew(className);
  const trace = mangleClassTrace(className);
  const gcFree = mangleClassGcFree(className);
  const destroy = mangleClassReleaseDirect(className) + "_destroy";
  expect(llvm).toContain("call ptr @" + create + "(");
  expect(llvm).toContain("call void @scr_error_set_traced()");
  expect(definition(llvm, create)).toContain("@" + trace + ".cyctype");
  expect(llvm).toContain("ptr @" + trace + ", ptr @" + gcFree);
  const drop = definition(llvm, destroy);
  expect(drop).toContain("@scr_error_state_forget(ptr %o)");
  expect(drop).toMatch(/store ptr null, ptr %f\d+[^]*@scr_error_state_drop/);
  expect(drop.indexOf("@scr_error_state_forget")).toBeLessThan(drop.indexOf("@scr_str_release"));
  expect(definition(llvm, trace)).toContain("%errorPublicState");
  expect(definition(llvm, trace)).toContain("call void %visit");
  expect(definition(llvm, gcFree)).toContain("@scr_error_state_forget(ptr %o)");
  expect(definition(llvm, gcFree)).not.toContain("@scr_error_state_drop");
  expect(definition(llvm, gcFree)).not.toContain("@scr_dyn_release");
  // Runtime-rooted classes are excluded from direct-destroy targets.
  expect(definition(llvm, destroy + "_s")).toBe("");
  return create;
}

test.each([
  ["ordinary", ordinary],
  ["cyclic", cyclic],
])("native Error ownership: %s", { timeout: 300_000 }, async (name, body) => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-ownership-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, shared + body);
    const result = await compile(entry, {
      backend: "llvm",
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.islands?.modules ?? []).toEqual([]);
    expect(result.islands?.packages ?? []).toEqual([]);
    errorPaths(await readFile(result.llvmPath, "utf8"));
    for (const threshold of ["1", "7", "256"]) {
      const run = await exec(result.binaryPath, [], {
        timeout: 30_000,
        env: {
          ...process.env,
          SCR_CYCLE_THRESHOLD: threshold,
          ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1",
          UBSAN_OPTIONS: "halt_on_error=1",
        },
      });
      expect(run.stdout).toBe(name + " ownership passed\n");
      // Empty stderr also rejects the runtime's RC-audit-skipped notices.
      expect(run.stderr).toBe("");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const arenaTree = `
class Node {
  constructor(readonly left: Node | null, readonly right: Node | null) {}
  count(): number {
    return 1 + (this.left === null ? 0 : this.left.count()) + (this.right === null ? 0 : this.right.count());
  }
}
function tree(depth: number): Node {
  return depth === 0 ? new Node(null, null) : new Node(tree(depth - 1), tree(depth - 1));
}
let total = 0;
for (let d = 0; d < 4; d++) total += tree(d).count();
console.log(total);
`;

test("Error arena exclusion", { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-error-arena-"));
  const saved = process.env["SCRIPTC_ARENAS"];
  delete process.env["SCRIPTC_ARENAS"];
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, shared + ordinary + arenaTree);
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "main.ll"),
      outputKind: "llvm",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const llvm = await readFile(result.artifact.path, "utf8");
    const create = errorPaths(llvm);
    expect(llvm).toMatch(/call ptr @scr_arena_open\(/);
    expect(llvm).toMatch(/call ptr @sc_new_[^(]*\.r\(/);
    // super() enters the runtime constructor, which the arena escape analysis
    // does not classify as a frame-local borrow.
    expect(llvm).not.toContain("call ptr @" + create + ".r(");
  } finally {
    if (saved === undefined) delete process.env["SCRIPTC_ARENAS"];
    else process.env["SCRIPTC_ARENAS"] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
