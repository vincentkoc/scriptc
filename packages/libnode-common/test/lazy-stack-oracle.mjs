// Stock-Node contract probe. Keep Error values out of console and inspection.
import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { Session } from "node:inspector";
import { fileURLToPath } from "node:url";

const [mode, version, ...extra] = process.argv.slice(2);
const modes = ["plain", "inspector", "inspector-zero"];
const versions = ["24.22.0", "24.22.1"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  schema: "scriptc.lazy-stack-oracle.v1",
  mode,
  node: process.version,
  v8: process.versions.v8,
  fixtureSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  binarySha256: sha256(readFileSync(process.execPath)),
  inspector: { enabled: false, size: null, disabled: false, disconnected: false },
  stackTraceLimit: 2,
  assertions: 0,
  cases: [],
  failures: [],
  complete: false,
};
let phase = "arguments";
function check(condition, label) {
  report.assertions++;
  if (!condition) report.failures.push(`${phase}: ${label}`);
}
function descriptor(error) {
  const own = Object.getOwnPropertyDescriptor(error, "stack");
  check(typeof own?.get === "function" && typeof own?.set === "function", "own stack accessors");
  return own;
}
function withHook(hook, run) {
  const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  Object.defineProperty(Error, "prepareStackTrace", {
    value: hook,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (saved) Object.defineProperty(Error, "prepareStackTrace", saved);
    else delete Error.prepareStackTrace;
  }
}
function transition(name) {
  phase = name;
  const error = new Error("probe");
  const { get, set } = descriptor(error);
  const outer = {};
  const later = {};
  const assigned = {};
  const sentinel = {};
  let calls = 0;
  let inner;
  const results = withHook(
    (holder) => {
      calls++;
      check(holder === error, "formatter receives owner");
      if (calls !== 1) return later;
      if (name.startsWith("setter")) set.call(error, assigned);
      if (name.startsWith("recapture")) Error.captureStackTrace(error);
      if (name === "recursive" || name === "setter-read") inner = get.call(error);
      if (name.endsWith("throw")) throw sentinel;
      return outer;
    },
    () =>
      Array.from({ length: 3 }, () => {
        try {
          const value = get.call(error);
          return value === outer
            ? "outer"
            : value === later
              ? "later"
              : value === assigned
                ? "assigned"
                : "unexpected";
        } catch (value) {
          return value === sentinel ? "sentinel" : "unexpected-throw";
        }
      }),
  );
  const expected =
    name === "setter-throw"
      ? ["sentinel", "assigned", "assigned"]
      : name.endsWith("throw")
        ? ["sentinel", "later", "later"]
        : name === "recapture" && mode === "inspector"
          ? ["outer", "later", "later"]
          : ["outer", "outer", "outer"];
  const expectedCalls = expected.includes("later") ? 2 : 1;
  check(JSON.stringify(results) === JSON.stringify(expected), "three read identities");
  check(calls === expectedCalls, "formatter call count");
  const row = { name, results, calls };
  if (name === "recursive") {
    row.innerType = typeof inner;
    row.innerPrefix = typeof inner === "string" && inner.startsWith("Error: probe");
    check(row.innerType === "string" && row.innerPrefix, "recursive string fallback");
  } else if (name === "setter-read") {
    row.innerAssigned = inner === assigned;
    check(row.innerAssigned, "inner read sees assignment");
  }
  report.cases.push(row);
}
function borrowed(name) {
  phase = name;
  const holder = new Error("probe");
  const child = Object.create(holder);
  const { get, set } = descriptor(holder);
  const cached = {};
  let calls = 0;
  let owner = false;
  withHook(
    (error) => {
      calls++;
      owner = error === holder;
      return cached;
    },
    () => {
      if (name === "borrowed-set") set.call(child, cached);
      if (name === "get-empty") {
        check(get.call({}) === undefined, "empty receiver is undefined");
      } else {
        check(get.call(child) === cached, "borrowed getter identity");
        check(get.call(holder) === cached, "owner cache identity");
      }
      check(!Object.hasOwn(child, "stack"), "no child stack property");
      check(calls === (name === "borrowed-get" ? 1 : 0), "formatter call count");
      if (name === "borrowed-get") check(owner, "formatter receives holder");
    },
  );
  report.cases.push({ name, calls, owner, childHasStack: Object.hasOwn(child, "stack") });
}
const values = [
  ["undefined", () => undefined],
  ["null", () => null],
  ["false", () => false],
  ["zero", () => 0],
  ["negative-zero", () => -0],
  ["nan", () => NaN],
  ["bigint", () => 1n],
  ["symbol", () => Symbol("cached")],
  ["object", () => ({})],
  ["array", () => []],
  ["function", () => function cached() {}],
  ["error-self", (error) => error],
];
function cachedValue(label, make, assignment) {
  phase = `${assignment ? "assigned" : "returned"}-${label}`;
  const error = new Error("probe");
  const { get, set } = descriptor(error);
  const value = make(error);
  let calls = 0;
  const identities = withHook(
    (owner) => {
      calls++;
      check(owner === error, "formatter receives owner");
      return value;
    },
    () => {
      if (assignment) set.call(error, value);
      return Array.from({ length: 3 }, () => Object.is(get.call(error), value));
    },
  );
  check(identities.every(Boolean), "Object.is cache identity");
  check(calls === (assignment ? 0 : 1), "formatter call count");
  report.cases.push({ name: phase, identities, calls });
}
function failedCapture(name) {
  phase = name;
  const error = new Error("probe");
  const original = descriptor(error);
  if (name === "nonextensible") Object.preventExtensions(error);
  else Object.defineProperty(error, "stack", { configurable: false });
  const before = Object.getOwnPropertyDescriptor(error, "stack");
  const cached = {};
  let calls = 0;
  let typeError = false;
  let unchanged = false;
  withHook(
    (owner) => {
      calls++;
      check(owner === error, "formatter receives owner");
      return cached;
    },
    () => {
      try {
        Error.captureStackTrace(error);
      } catch (value) {
        typeError = value instanceof TypeError;
      }
      check(typeError, "recapture throws TypeError");
      const after = Object.getOwnPropertyDescriptor(error, "stack");
      unchanged = ["get", "set", "enumerable", "configurable"].every((key) =>
        Object.is(before[key], after[key]),
      );
      check(unchanged, "descriptor preserved");
      check(calls === 0, "old lazy state not formatted by failure");
      check(original.get.call(error) === cached, "old lazy state remains readable");
      check(original.get.call(error) === cached, "old cache remains stable");
      check(calls === 1, "formatter called once after failure");
    },
  );
  report.cases.push({ name, typeError, descriptorUnchanged: unchanged, calls });
}

let session;
const savedLimit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
const post = (method, params = {}) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)));
  });
try {
  check(
    extra.length === 0 && modes.includes(mode) && versions.includes(version),
    "exact mode/version arguments",
  );
  check(process.version === `v${version}`, "exact Node version");
  if (report.failures.length) throw null;
  if (mode !== "plain") {
    phase = "inspector-enable";
    session = new Session();
    session.connect();
    await post("Runtime.enable");
    report.inspector.enabled = true;
    const size = mode === "inspector" ? 32 : 0;
    await post("Runtime.setMaxCallStackSizeToCapture", { size });
    report.inspector.size = size;
  }
  Object.defineProperty(Error, "stackTraceLimit", { value: 2, writable: true, configurable: true });
  for (const name of [
    "recursive",
    "setter-read",
    "recapture",
    "throw",
    "setter-throw",
    "recapture-throw",
  ])
    transition(name);
  for (const name of ["borrowed-get", "borrowed-set", "get-empty"]) borrowed(name);
  for (const [label, make] of values) {
    cachedValue(label, make, true);
    cachedValue(label, make, false);
  }
  for (const name of ["nonextensible", "nonconfigurable"]) failedCapture(name);
  phase = "inventory";
  check(report.cases.length === 35, "35 complete cases");
  check(new Set(report.cases.map((row) => row.name)).size === 35, "unique cases");
} catch {
  report.failures.push(`${phase}: unexpected exception`);
} finally {
  if (savedLimit) Object.defineProperty(Error, "stackTraceLimit", savedLimit);
  else delete Error.stackTraceLimit;
  if (session) {
    try {
      await post("Runtime.disable");
      report.inspector.disabled = true;
    } catch {
      report.failures.push("inspector-disable: protocol failure");
    } finally {
      session.disconnect();
      report.inspector.disconnected = true;
    }
  }
}
report.complete = report.failures.length === 0 && report.cases.length === 35;
const output = Buffer.from(`${JSON.stringify(report)}\n`);
if (output.length > 32768) throw new Error("oracle record exceeds 32 KiB");
let offset = 0;
while (offset < output.length) {
  const written = writeSync(1, output, offset, output.length - offset);
  if (written <= 0) throw new Error("oracle stdout write failed");
  offset += written;
}
if (!report.complete) process.exitCode = 1;
