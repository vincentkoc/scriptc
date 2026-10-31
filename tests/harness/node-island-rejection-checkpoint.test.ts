import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const pack = libnodePack();
function body(directCatch: boolean, lateHandling: boolean): string {
  if (lateHandling)
    return `const pending: Promise<void> = Promise.reject(new RangeError("sentinel"));
process.on("unhandledRejection", () => {
  console.log("unhandled");
  setImmediate(() => {
    console.log("attach");
    pending.catch(() => console.log("caught"));
    console.log("after");
    process.nextTick(() => console.log("tick"));
  });
});
process.on("rejectionHandled", () => console.log("handled"));
`;
  return `const pending: Promise<void> = Promise.reject(new RangeError("sentinel"));
queueMicrotask(() => {
  console.log("microtask");
${
  directCatch
    ? '  pending.catch(() => console.log("caught"));'
    : `  process.nextTick(() => {
    console.log("tick");
    pending.catch(() => console.log("caught"));
  });`
}
});
setImmediate(() => console.log("done"));
`;
}

const cases = [
  { id: "native-next-tick", hosted: false, macrotask: false, directCatch: false },
  { id: "hosted-next-tick", hosted: true, macrotask: false, directCatch: false },
  { id: "hosted-macrotask-next-tick", hosted: true, macrotask: true, directCatch: false },
  { id: "hosted-direct-catch", hosted: true, macrotask: false, directCatch: true },
  {
    id: "native-late-handling",
    hosted: false,
    macrotask: false,
    directCatch: false,
    lateHandling: true,
  },
  {
    id: "hosted-late-handling",
    hosted: true,
    macrotask: false,
    directCatch: false,
    lateHandling: true,
  },
];

for (const { id, hosted, macrotask, directCatch, lateHandling = false } of cases) {
  test.skipIf(hosted && pack === null)(
    lateHandling
      ? `late rejection events follow queued work (${id})`
      : `a queued catch precedes rejection reporting (${id})`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "scriptc-rejection-checkpoint-"));
      try {
        const files: Record<string, string> = {
          "package.json": JSON.stringify({
            private: true,
            type: "module",
            scriptc: {
              nodeIslands: { auto: false },
              ...(hosted ? { packages: { "checkpoint-host": "node" } } : {}),
            },
          }),
          "main.ts":
            (hosted ? 'import { start } from "checkpoint-host";\nstart();\n' : "") +
            (macrotask
              ? `setImmediate(() => {\n${body(directCatch, lateHandling)}});\n`
              : body(directCatch, lateHandling)),
        };
        if (hosted) {
          files["node_modules/checkpoint-host/package.json"] = JSON.stringify({
            name: "checkpoint-host",
            version: "1.0.0",
            main: "index.js",
            types: "index.d.ts",
          });
          files["node_modules/checkpoint-host/index.js"] =
            'exports.start = function start() { console.log("island ready"); };\n';
          files["node_modules/checkpoint-host/index.d.ts"] =
            "export declare function start(): void;\n";
        }
        for (const [name, source] of Object.entries(files)) {
          const path = join(dir, name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, source);
        }
        const entry = join(dir, "main.ts");
        const expected = await execFileAsync(process.execPath, [entry], {
          encoding: "utf8",
          timeout: 20_000,
        });
        expect(expected.stdout).toBe(
          (hosted ? "island ready\n" : "") +
            (lateHandling
              ? "unhandled\nattach\nafter\ntick\ncaught\nhandled\n"
              : "microtask\n" + (directCatch ? "" : "tick\n") + "caught\ndone\n"),
        );
        expect(expected.stderr).toBe("");

        const result = await compile(entry, {
          outPath: join(dir, "program"),
          outDir: dir,
          sanitize,
          ...(hosted && pack !== null ? { libnode: pack } : {}),
        });
        if (!result.ok)
          throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
        const actual = await execFileAsync(result.binaryPath, [], {
          encoding: "utf8",
          timeout: 20_000,
        });
        expect(actual.stdout).toBe(expected.stdout);
        // Match the differential harness's sole ASan context-switch warning normalization.
        const stderr = sanitize
          ? actual.stderr.replace(
              /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
              "",
            )
          : actual.stderr;
        expect(stderr).toBe(expected.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000,
  );
}
