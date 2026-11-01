/* Island object handles (scope-B NI-4) where a differential corpus program
 * cannot show it: handles to Node objects the program dropped are released,
 * so the import table does not grow with the work a program does (acyclic
 * garbage; node-island-gc.test.ts covers cycles across both heaps). The
 * corpus (6812-6815) pins handle semantics against Node. An island package
 * ships with the program, so the executable runs without the tree it was
 * built from. Needs a libnode pack in SCRIPTC_LIBNODE (libnode.ts). */
import { execFile } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/node-island-handles");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const skip = libnodePack() === null;

describe.skipIf(skip)("Node island handles", () => {
  test("handles the program dropped are released", async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/node-island/handles-leak.mjs"), {
      outPath: join(outDir, "handles-leak"),
      outDir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const env = { ...process.env, SCRIPTC_NODE_ISLANDS_TRACE: "handles" };
    const counts: number[] = [];
    for (const n of ["2000", "20000"]) {
      const { stdout, stderr } = await execFileAsync(result.binaryPath, [n], {
        env,
        encoding: "utf8",
      });
      expect(stdout).toMatch(/^sum \d+ 499500 object -1\n$/);
      const live = /\[node-islands\] live handles (\d+)/.exec(stderr);
      expect(live).not.toBeNull();
      counts.push(Number(live![1]));
    }
    // The module and the kept object (with util.inspect, at most a few
    // more), independent of the number of iterations.
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBeLessThan(8);
  }, 300_000);

  async function runFixture(name: string, entry: string): Promise<string> {
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(repoRoot, "tests/fixtures/node-island", entry), {
      outPath: join(dir, name),
      outDir: dir,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const env = { ...process.env, XDG_CACHE_HOME: join(dir, "cache") };
    return (await execFileAsync(result.binaryPath, [], { env, encoding: "utf8" })).stdout;
  }

  test("island member calls and assignments evaluate in JavaScript's order", async () => {
    expect(await runFixture("order", "order/main.ts")).toBe(
      "original\nreceiver,key,value,receiver,value 1 1\n",
    );
  }, 300_000);

  test("requireModule() loads Node's built-in modules", async () => {
    expect(await runFixture("builtins", "builtins.ts")).toBe("a/b string\n");
  }, 300_000);

  /** Runs a binary that refuses at run time: its stderr. */
  async function refusal(binary: string): Promise<string> {
    const run = await execFileAsync(binary, [], { encoding: "utf8" }).catch(
      (e: { stderr?: string }) => e,
    );
    return String((run as { stderr?: string }).stderr ?? "");
  }

  test("a package marked native never runs in a Node island", async () => {
    // esmbridge's native build has deferred refusals (its CommonJS exports
    // object read as a value, an Object.keys form), so by default it runs in
    // a Node island; marked native, it compiles natively and refuses at run
    // time.
    const dir = join(outDir, "native-policy");
    mkdirSync(dir, { recursive: true });
    const entry = join(repoRoot, "tests/fixtures/npm/cases/cjs-esm-named/main.ts");
    const islanded = await compile(entry, { outPath: join(dir, "main"), outDir: dir, sanitize });
    // The SC8001 notes that name esmbridge.
    const islandNotes = (r: typeof islanded): string[] =>
      r.ok
        ? (r.warnings ?? [])
            .filter((d) => d.code === "SC8001" && d.message.includes("'esmbridge@"))
            .map((d) => d.message)
        : [];
    expect(islanded.ok).toBe(true);
    expect(islandNotes(islanded)).toHaveLength(1);
    const marked = await compile(entry, {
      outPath: join(dir, "marked"),
      outDir: dir,
      sanitize,
      nodeIslands: { native: ["esmbridge"] },
    });
    expect(marked.ok).toBe(true);
    expect(islandNotes(marked)).toEqual([]);
    if (marked.ok)
      expect(await refusal(marked.binaryPath)).toMatch(/\[SC\d{4} at [^\]]*\/esmbridge\//);
  }, 300_000);

  /** The SC8001 notes of a build that name `pkg`. */
  async function islandNotesOf(entry: string, name: string, pkg: string): Promise<string[]> {
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    const result = await compile(join(repoRoot, entry), {
      outPath: join(dir, name),
      outDir: dir,
      sanitize,
    });
    expect(result.ok, name).toBe(true);
    if (!result.ok) return [];
    return (result.warnings ?? [])
      .filter((d) => d.code === "SC8001" && d.message.includes(`'${pkg}@`))
      .map((d) => d.message);
  }

  test("a package whose fences may never run stays native", async () => {
    // jose's run-time fences are inside function bodies, on paths a program
    // may never call: only fences that surely fire make a Node island.
    expect(
      await islandNotesOf("tests/corpus/6331-jose-root-entry/main.ts", "jose-native", "jose"),
    ).toEqual([]);
  }, 300_000);

  test("a fence in module code makes a Node island, with the ES modules importing it", async () => {
    // cjszoo's module code sets its exports object's prototype (R2.2), so
    // its fence fires when it loads; esmbridge's ES module imports names
    // from it, which only Node's CommonJS facade gives as Node does.
    const entry = "tests/fixtures/npm/cases/cjs-esm-named/main.ts";
    const zoo = await islandNotesOf(entry, "fence-sure", "cjszoo");
    expect(zoo).toHaveLength(1);
    expect(zoo[0]).toContain("R2.2");
    const bridge = await islandNotesOf(entry, "fence-sure", "esmbridge");
    expect(bridge).toEqual([
      "package 'esmbridge@1.0.0' runs in a Node island: packaging: an ES module of the package imports the CommonJS island package 'cjszoo'",
    ]);
  }, 300_000);

  test("without islands, a package's deferred refusals refuse at run time", async () => {
    // With --node-islands=off, packages whose native builds have deferred
    // refusals compile natively and report them when they run: orderkit's
    // createRequire call with a computed specifier (SC2020), and the first
    // one cjs-esm-named reaches in its packages (esmbridge, cjszoo).
    const cases = [
      ["order-off", "tests/fixtures/node-island/order/main.ts", /\[SC2020 at [^\]]*\/orderkit\//],
      [
        "esm-named-off",
        "tests/fixtures/npm/cases/cjs-esm-named/main.ts",
        /\[SC\d{4} at [^\]]*\/node_modules\/(?:esmbridge|cjszoo)\//,
      ],
    ] as const;
    for (const [name, entry, code] of cases) {
      const dir = join(outDir, name);
      mkdirSync(dir, { recursive: true });
      const result = await compile(join(repoRoot, entry), {
        outPath: join(dir, name),
        outDir: dir,
        sanitize,
        nodeIslands: { mode: "off" },
      });
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      expect((result.warnings ?? []).map((d) => d.code)).not.toContain("SC8001");
      expect(await refusal(result.binaryPath), name).toMatch(code);
    }
  }, 300_000);

  test("an island array that contradicts its declaration throws at the crossing", async () => {
    // The crossing copies the island's array element-wise, and the checked
    // conversion throws on an element of the wrong type: `lie()` declares
    // string[] and hands back numbers, so no number reaches a native
    // string[]. (A corpus program cannot pin this: Node prints the numbers.)
    const root = join(outDir, "declared-arrays-lie");
    rmSync(root, { recursive: true, force: true });
    cpSync(join(repoRoot, "tests/corpus/6897-node-island-declared-arrays"), root, {
      recursive: true,
    });
    copyFileSync(
      join(repoRoot, "tests/fixtures/node-island/declared-arrays-lie.ts"),
      join(root, "main.ts"),
    );
    const result = await compile(join(root, "main.ts"), {
      outPath: join(root, "main"),
      outDir: root,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(await refusal(result.binaryPath)).toContain(
      "TypeError: expected string at $[0], got number",
    );
  }, 300_000);

  test("an island record that contradicts its declaration throws at the crossing", async () => {
    // A record the island hands back crosses as a deep checked copy:
    // `unsafe<T>` declares the caller's own record type and hands back a
    // JSON object whose `fg` is a number, so the copy's conversion throws
    // before a number reaches a native string field.
    const root = join(outDir, "unsafe-record-lie");
    rmSync(root, { recursive: true, force: true });
    cpSync(join(repoRoot, "tests/corpus/6899-node-island-unsafe-record"), root, {
      recursive: true,
    });
    copyFileSync(
      join(repoRoot, "tests/fixtures/node-island/unsafe-record-lie.ts"),
      join(root, "main.ts"),
    );
    const result = await compile(join(root, "main.ts"), {
      outPath: join(root, "main"),
      outDir: root,
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(await refusal(result.binaryPath)).toContain(
      "TypeError: expected string at $.fg, got number",
    );
  }, 300_000);

  test("an island package ships with the program", async () => {
    const root = join(outDir, "ships");
    const src = join(root, "src");
    rmSync(root, { recursive: true, force: true });
    cpSync(join(repoRoot, "tests/corpus/6816-node-island-objects"), src, { recursive: true });
    const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache") };
    const built: Record<string, string> = {};
    for (const libnode of ["inside", "beside"]) {
      const dir = join(root, libnode);
      mkdirSync(dir, { recursive: true });
      const result = await compile(join(src, "main.ts"), {
        outPath: join(dir, "main"),
        outDir: dir,
        sanitize,
        ...(libnode === "beside" ? { libnode } : {}),
      });
      if (!result.ok)
        throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
      built[libnode] = result.binaryPath;
    }
    const before = await execFileAsync(built["inside"]!, [], { env, encoding: "utf8" });
    expect(before.stdout).toMatch(/^islandkit \d/);
    // The executable names its island package by its path in the shipped
    // tree, never by the directory it was built from.
    expect(readFileSync(built["inside"]!).toString("latin1").includes(src)).toBe(false);
    // Beside the executable, the tree holds the package's files.
    const index = readFileSync(join(src, "node_modules/islandkit/index.js"), "utf8");
    const modules = join(root, "beside/main.libnode/modules");
    const files = readdirSync(modules, { recursive: true, encoding: "utf8" });
    expect(
      files.some((f) => f.endsWith("index.js") && readFileSync(join(modules, f), "utf8") === index),
    ).toBe(true);
    renameSync(src, join(root, "moved"));
    for (const binary of Object.values(built)) {
      const after = await execFileAsync(binary, [], { env, encoding: "utf8" });
      expect(after.stdout).toBe(before.stdout);
    }
  }, 300_000);
});

// These fixtures live outside node_modules so Node can strip their TypeScript.
const foreignErrorModule = `
let kept = new TypeError('same');
export function get() { return kept; }
export function fresh() { return new TypeError('same'); }
export function same(a, b) { return a === b; }
export function echo(value) { return value; }
export function fail() { throw kept; }
export function rethrow(value) { throw value; }
export function call(fn) { return fn(kept); }
export function callWith(fn, value) { return fn(value); }
export function callNull(fn) { return fn(null); }
export function fulfill() { return Promise.resolve(kept); }
export function reject() { return Promise.reject(kept); }
export function write(value) { kept.code = value; }
export function code() { return kept.code; }
export function plain() { return { name: 'TypeError', message: 'same', '%error': true }; }
export function prototypeOnly() { return Object.create(Error.prototype); }
export function detach(value) { Object.setPrototypeOf(value, null); }
let reads = 0;
export function guarded() {
  const value = new TypeError('guarded');
  Object.defineProperty(value, 'name', { get() { reads++; return 'TypeError'; } });
  Object.defineProperty(value, 'code', { get() { reads++; return 'CODE'; } });
  return value;
}
export function readCount() { return reads; }
`;

async function withForeignErrors(
  name: string,
  source: string,
  check: (entry: string, binary: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `scriptc-${name}-`));
  try {
    const entry = join(dir, "main.mts");
    const island = join(dir, "island.mjs");
    writeFileSync(entry, `import * as island from './island.mjs';\n${source}`);
    writeFileSync(island, foreignErrorModule);
    const result = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      sanitize,
      nodeIslands: { mode: "explicit", islands: [island] },
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    await check(entry, result.binaryPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const foreignErrorEnv = { ...process.env };
delete foreignErrorEnv["FORCE_COLOR"];
const contextSwitchWarning =
  /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext functions and may produce false positives in some cases!\n/gm;

async function foreignErrorParity(entry: string, binary: string, expected: string): Promise<void> {
  const node = await execFileAsync(process.execPath, [entry], {
    env: foreignErrorEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(node.stdout).toBe(expected);
  expect(node.stderr).toBe("");
  const native = await execFileAsync(binary, [], {
    env: foreignErrorEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(native.stdout).toBe(node.stdout);
  expect(native.stderr.replace(contextSwitchWarning, "")).toBe(node.stderr);
}

describe.skipIf(skip)("foreign Error identity", () => {
  test("returned, caught, callback and promise Errors keep their island identity", async () => {
    await withForeignErrors(
      "error-identity",
      `
const value: unknown = island.get();
const other: unknown = island.fresh();
console.log('returned', value === island.get(), value !== other);
const typed = value as Error;
const again = value as Error;
const nullable = value as Error | null;
console.log('checked', typed === again, (typed as unknown) === value, (nullable as unknown) === value);
console.log('echo', island.echo(typed) === value, island.same(typed, typed));
try { island.fail(); } catch (caught) {
  console.log('caught', caught === value, caught instanceof Error, caught instanceof TypeError);
  try { throw caught; } catch (rethrown) { console.log('rethrow', rethrown === value); }
}
try { throw value; } catch (caught) {
  console.log('native-throw', caught === value, caught instanceof Error);
  try { island.rethrow(caught); } catch (rethrown) { console.log('island-rethrow', rethrown === value); }
}
function accept(error: Error): boolean { return (error as unknown) === value; }
function acceptNullable(error: Error | null): boolean { return error === null || (error as unknown) === value; }
console.log('callback', island.call(accept), island.call(acceptNullable), island.callNull(acceptNullable));
const fulfilled = island.fulfill() as Promise<Error>;
console.log('fulfilled', ((await fulfilled) as unknown) === value);
const rejected = island.reject() as Promise<Error>;
try { await rejected; } catch (caught) { console.log('rejected', caught === value, caught instanceof Error); }
const dynamic: any = value;
dynamic.code = 'native';
console.log('write', island.code() === 'native');
island.write('island');
console.log('read', dynamic.code === 'island');
island.detach(typed);
console.log('typed-prototype', typed instanceof Error, typed instanceof TypeError);
try { throw typed; } catch (caught) {
  console.log('caught-prototype', caught === value, caught instanceof Error, caught instanceof TypeError);
}
`,
      (entry, binary) =>
        foreignErrorParity(
          entry,
          binary,
          "returned true true\nchecked true true true\necho true true\ncaught true true true\nrethrow true\nnative-throw true true\nisland-rethrow true\ncallback true true true\nfulfilled true\nrejected true true\nwrite true\nread true\ntyped-prototype false false\ncaught-prototype true false false\n",
        ),
    );
  }, 300_000);

  test("Error branding and prototype membership do not read island properties", async () => {
    await withForeignErrors(
      "error-brand",
      `
const value: unknown = island.guarded();
console.log('brand', Error.isError(value), value instanceof Error, value instanceof TypeError);
console.log('repeat', value === island.echo(value), island.same(value, value));
function acceptUnknown(error: unknown): boolean { return Error.isError(error); }
console.log('callback', island.callWith(acceptUnknown, value));
const detached: unknown = island.guarded();
island.detach(detached);
console.log('detached', Error.isError(detached), detached instanceof Error, detached instanceof TypeError);
const prototype: unknown = island.prototypeOnly();
console.log('prototype', Error.isError(prototype), prototype instanceof Error);
const spoof: unknown = island.plain();
console.log('spoof', Error.isError(spoof), spoof instanceof Error);
console.log('calls', island.echo(value) instanceof Error, island.echo(detached) instanceof Error);
console.log('reads', island.readCount());
`,
      (entry, binary) =>
        foreignErrorParity(
          entry,
          binary,
          "brand true true true\nrepeat true true\ncallback true\ndetached true false false\nprototype false true\nspoof false false\ncalls true false\nreads 0\n",
        ),
    );
  }, 300_000);

  test("checked Error conversions reject non-Error island handles", async () => {
    await withForeignErrors(
      "error-reject",
      `
function check(value: unknown): void {
  try { const error = value as Error; console.log('direct', island.same(error, value)); }
  catch (error) { console.log('direct rejected', error instanceof TypeError); }
  try { const error = value as Error | null; console.log('union', island.same(error, value)); }
  catch (error) { console.log('union rejected', error instanceof TypeError); }
}
check(island.plain());
check(island.prototypeOnly());
check(42);
`,
      async (_entry, binary) => {
        const result = await execFileAsync(binary, [], {
          env: foreignErrorEnv,
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(result.stdout).toBe("direct rejected true\nunion rejected true\n".repeat(3));
        expect(result.stderr.replace(contextSwitchWarning, "")).toBe("");
      },
    );
  }, 300_000);

  test("released typed Error mirrors do not root island handles", async () => {
    await withForeignErrors(
      "error-release",
      `
function consume(): boolean {
  const value: unknown = island.fresh();
  const error = value as Error;
  return island.same(error, value);
}
const count = Number(process.argv[2]);
let matches = 0;
for (let i = 0; i < count; i++) if (consume()) matches++;
console.log('matches', matches);
`,
      async (entry, binary) => {
        const live: number[] = [];
        for (const count of [200, 2000]) {
          const node = await execFileAsync(process.execPath, [entry, String(count)], {
            env: foreignErrorEnv,
            encoding: "utf8",
            timeout: 30_000,
          });
          const native = await execFileAsync(binary, [String(count)], {
            env: { ...foreignErrorEnv, SCRIPTC_NODE_ISLANDS_TRACE: "handles" },
            encoding: "utf8",
            timeout: 30_000,
          });
          expect(node.stdout).toBe(`matches ${count}\n`);
          expect(node.stderr).toBe("");
          expect(native.stdout).toBe(node.stdout);
          const stderr = native.stderr.replace(contextSwitchWarning, "");
          const rows = [...stderr.matchAll(/^\[node-islands\] live handles (\d+)\n/gm)];
          expect(rows).toHaveLength(1);
          expect(stderr.replace(rows[0]![0], "")).toBe("");
          live.push(Number(rows[0]![1]));
        }
        expect(live[1]).toBe(live[0]);
        expect(live[1]).toBeLessThan(8);
      },
    );
  }, 300_000);
});
