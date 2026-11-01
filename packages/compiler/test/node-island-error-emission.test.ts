import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrModule } from "../src/ir/ir.js";

async function lowered(source: string, island: boolean): Promise<IrModule> {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-error-predicates-"));
  try {
    const entry = join(dir, "main.mts");
    const foreign = join(dir, "island.mjs");
    writeFileSync(entry, source);
    writeFileSync(foreign, "export function get() { return new TypeError('foreign'); }\n");
    const result = await compile(entry, {
      outputKind: "ir",
      outDir: dir,
      outPath: join(dir, "program.ir.json"),
      nodeIslands: island ? { mode: "explicit", islands: [foreign] } : { mode: "off" },
    });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(readFileSync(result.artifact.path, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function nodes(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  JSON.stringify(value, (_key, node: unknown) => {
    if (node !== null && typeof node === "object") found.push(node as Record<string, unknown>);
    return node;
  });
  return found;
}

test("authored island Error instanceof uses one value-aware predicate for every operand form", async () => {
  const source = `import * as island from './island.mjs';
function dynamic(value: unknown): boolean { return value instanceof Error; }
function typed(value: Error): boolean { return value instanceof TypeError; }
function expression(): boolean { return island.get() instanceof Error; }
function caught(): boolean { try { throw island.get(); } catch (value) { return value instanceof Error; } }
function branded(value: unknown): boolean { return Error.isError(value); }
console.log(dynamic(island.get()), typed(island.get() as Error), expression(), caught(), branded(island.get()));
`;
  const module = await lowered(source, true);
  const calls = nodes(module).filter(
    (node) => node.kind === "libCall" && node.fn === "dyn.errInstanceof",
  );
  for (const text of [
    "value instanceof Error",
    "value instanceof TypeError",
    "island.get() instanceof Error",
  ]) {
    const starts = [
      ...source.matchAll(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")),
    ].map((m) => m.index);
    for (const start of starts)
      expect(
        calls.some((call) => (call.loc as { start: number }).start === start),
        text,
      ).toBe(true);
  }
  expect(
    nodes(module).some(
      (node) => node.kind === "libCall" && node.fn === "nodeIsland.instanceofGlobal",
    ),
  ).toBe(false);
  expect(nodes(module).some((node) => node.kind === "dynTest" && node.test === "error")).toBe(true);
});

test("pure native typed Error instanceof retains its unboxed class test", async () => {
  const module = await lowered(
    `function native(value: Error): boolean { return value instanceof TypeError; }
console.log(native(new TypeError('native')));
`,
    false,
  );
  expect(module.nodeIsland).toBeUndefined();
  const all = nodes(module);
  expect(all.some((node) => node.kind === "libCall" && node.fn === "dyn.errInstanceof")).toBe(
    false,
  );
  expect(all.some((node) => node.kind === "dynFrom")).toBe(false);
  expect(all.some((node) => node.kind === "instanceOf")).toBe(true);
});
