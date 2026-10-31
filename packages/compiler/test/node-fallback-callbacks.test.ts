import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { checkPreflight, loadProgram } from "../src/frontend/program-node.js";

const exactTypes = `
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function expectType<T extends true>(): void;
`;

function preflight(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fallback-callbacks-"));
  try {
    writeFileSync(join(directory, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const entry = join(directory, "main.ts");
    writeFileSync(entry, exactTypes + source);
    const load = loadProgram(entry);
    try {
      expect(load.typeWorld?.nodeFallback).toBe(true);
      return checkPreflight(load);
    } finally {
      load.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const specifier of ["global", "process", "node:process"]) {
  const imported = specifier === "global" ? "" : 'import process from "' + specifier + '";\n';

  test(`fallback ${specifier} rejection listeners infer promises and unknown reasons`, () => {
    const calls = ["on", "once", "off", "removeListener"]
      .map(
        (method) => `
const unhandled_${method}: void = process.${method}("unhandledRejection", (reason, pending) => {
  expectType<Equal<typeof reason, unknown>>();
  expectType<Equal<typeof pending, Promise<unknown>>>();
  pending.then((value) => expectType<Equal<typeof value, unknown>>());
  pending.catch(() => {});
});
const handled_${method}: void = process.${method}("rejectionHandled", (pending) => {
  expectType<Equal<typeof pending, Promise<unknown>>>();
  pending.catch(() => {});
});
`,
      )
      .join("");
    expect(preflight(imported + calls)).toEqual([]);
  });

  test(`fallback ${specifier} exception listeners infer errors and origins`, () => {
    const calls = ["on", "once", "off", "removeListener", "prependListener"]
      .flatMap((method) =>
        ["uncaughtException", "uncaughtExceptionMonitor"].map(
          (event) => `
const ${event}_${method}: void = process.${method}("${event}", (error, origin) => {
  expectType<Equal<typeof error, Error>>();
  expectType<Equal<typeof origin, "uncaughtException" | "unhandledRejection">>();
  console.log(error.message, origin);
});
`,
        ),
      )
      .join("");
    expect(preflight(imported + calls)).toEqual([]);
  });

  test(`fallback ${specifier} rejection reasons still require narrowing`, () => {
    const diagnostics = preflight(
      imported +
        `process.on("unhandledRejection", (reason, pending) => {
  const message: string = reason;
  pending.catch(() => {});
  console.log(message);
});`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("SC0001");
    expect(diagnostics[0]?.message).toContain("Type 'unknown' is not assignable to type 'string'");
  });
}

for (const specifier of ["fs", "node:fs"]) {
  const imported = `import { stat, lstat, fstat, type Stats, type BigIntStats, type StatOptions } from "${specifier}";\n`;
  const members = [
    ["stat", '"."'],
    ["lstat", 'new URL("file:///tmp")'],
    ["fstat", "0"],
  ];

  test(`fallback ${specifier} stat callbacks infer option-selected snapshots`, () => {
    const calls = members
      .flatMap(([member, argument]) =>
        [
          ["", "Stats"],
          ["undefined, ", "Stats"],
          ["{ bigint: false }, ", "Stats"],
          ["{ bigint: true }, ", "BigIntStats"],
          ["options, ", "Stats | BigIntStats"],
        ].map(
          ([options, snapshot], index) => `
const ${member}_${index}: void = ${member}(${argument}, ${options}(error, stats) => {
  expectType<Equal<typeof error, NodeJS.ErrnoException | null>>();
  expectType<Equal<typeof stats, ${snapshot}>>();
  expectType<Equal<typeof stats.size, ${snapshot === "Stats" ? "number" : snapshot === "BigIntStats" ? "bigint" : "number | bigint"}>>();
});
`,
        ),
      )
      .join("");
    expect(
      preflight(
        imported + "const options: StatOptions = { bigint: process.argv.length > 0 };\n" + calls,
      ),
    ).toEqual([]);
  });

  test(`fallback ${specifier} stat callbacks reject the wrong numeric representation`, () => {
    const calls = members
      .flatMap(([member, argument]) => [
        `${member}(${argument}, (error, stats) => {
  if (error) throw error;
  const size: bigint = stats.size;
  console.log(size);
});`,
        `${member}(${argument}, { bigint: true }, (error, stats) => {
  if (error) throw error;
  const size: number = stats.size;
  console.log(size);
});`,
      ])
      .join("\n");
    const diagnostics = preflight(imported + calls);
    expect(diagnostics).toHaveLength(6);
    expect(diagnostics.every((diagnostic) => diagnostic.code === "SC0001")).toBe(true);
    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes("Type 'number' is not assignable to type 'bigint'"),
      ),
    ).toHaveLength(3);
    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.message.includes("Type 'bigint' is not assignable to type 'number'"),
      ),
    ).toHaveLength(3);
  });
}

async function lowered(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-fallback-callback-ir-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const entry = join(directory, "main.ts");
    const outPath = join(directory, "main.ir.json");
    writeFileSync(entry, source);
    const load = loadProgram(entry);
    try {
      expect(load.typeWorld?.nodeFallback).toBe(true);
    } finally {
      load.dispose();
    }
    const result = await compile(entry, { outDir: directory, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return JSON.stringify(deserializeModule(readFileSync(outPath, "utf8")).functions);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.for(["global", "process", "node:process"])(
  "fallback %s callback parameters lower through native process listeners",
  async (specifier) => {
    const imported = specifier === "global" ? "" : `import process from "${specifier}";\n`;
    const source = ["on", "once", "off", "removeListener"]
      .map(
        (method) => `
process.${method}("unhandledRejection", (reason, pending) => {
  pending.catch(() => console.log(typeof reason));
});
process.${method}("rejectionHandled", (pending) => {
  pending.catch(() => console.log("handled"));
});
`,
      )
      .join("");
    const exceptions = ["on", "once", "off", "removeListener", "prependListener"]
      .flatMap((method) =>
        ["uncaughtException", "uncaughtExceptionMonitor"].map(
          (event) =>
            `process.${method}("${event}", (error, origin) => console.log(error.message, origin));`,
        ),
      )
      .join("\n");
    const ir = await lowered(imported + source + exceptions);
    for (const operation of [
      "process.onUnhandledRejection",
      "process.offUnhandledRejection",
      "process.onRejectionHandled",
      "process.offRejectionHandled",
      "process.onUncaughtException",
      "process.offUncaughtException",
      "process.prependUncaughtException",
    ])
      expect(ir).toContain(`"fn":"${operation}"`);
  },
);

test.for(["fs", "node:fs"])(
  "fallback %s error-only stat callbacks lower through native filesystem calls",
  async (specifier) => {
    const calls = ["stat", "lstat", "fstat"]
      .flatMap((member) =>
        ["", "undefined, ", "{ bigint: false }, ", "{ bigint: true }, ", "options, "].map(
          (options) => `${member}(${member === "fstat" ? "0" : '"."'}, ${options}(error) => {
  if (error) console.log(error.message);
});`,
        ),
      )
      .join("\n");
    const ir = await lowered(
      `import { stat, lstat, fstat, type StatOptions } from "${specifier}";
const options: StatOptions = { bigint: process.argv.length > 0 };
${calls}
`,
    );
    expect(ir).toContain('"fn":"fs.callbackCall"');
  },
);
