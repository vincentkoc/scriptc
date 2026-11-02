import { createHash } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { Session } from "node:inspector";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const [addonPath, mode, version, ...extra] = process.argv.slice(2);
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const result = {
  schema: "scriptc.lazy-stack-api.v1",
  mode,
  node: process.version,
  v8: process.versions.v8,
  fixtureSha256: hash(fileURLToPath(import.meta.url)),
  binarySha256: hash(process.execPath),
  addonSha256: hash(addonPath),
  assertions: 0,
  cases: [],
  failures: [],
  complete: false,
  preexistingOverflowPermission: "source-reviewed-only",
};
let phase = "arguments";
let progressBytes = 0;
function writeAll(fd, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const size = writeSync(fd, bytes, offset, bytes.length - offset);
    if (size <= 0) throw new Error("probe write failed");
    offset += size;
  }
}
function progress(event, name) {
  const bytes = Buffer.from(`lazy-stack-api ${event} ${name}\n`);
  progressBytes += bytes.length;
  if (progressBytes > 16384) throw new Error("probe progress exceeds 16 KiB");
  writeAll(2, bytes);
}
function check(condition, label) {
  result.assertions++;
  if (!condition) throw new Error(`${phase}: ${label}`);
}
function test(name, body) {
  phase = name;
  progress("begin", name);
  const before = result.assertions;
  body();
  result.cases.push({ name, assertions: result.assertions - before });
  progress("end", name);
}
function withPrepare(hook, body) {
  const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  Object.defineProperty(Error, "prepareStackTrace", {
    value: hook,
    writable: true,
    configurable: true,
  });
  try {
    return body();
  } finally {
    if (saved) Object.defineProperty(Error, "prepareStackTrace", saved);
    else delete Error.prepareStackTrace;
  }
}
let session;
const post = (method, params = {}) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (error, value) => (error ? reject(error) : resolve(value)));
  });
const limit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
try {
  check(extra.length === 0 && ["plain", "inspector", "inspector-zero"].includes(mode), "mode");
  check(["24.22.0", "24.22.1"].includes(version) && process.version === `v${version}`, "version");
  phase = "addon-load";
  progress("begin", phase);
  const api = createRequire(import.meta.url)(addonPath);
  progress("end", phase);
  if (mode !== "plain") {
    session = new Session();
    session.connect();
    await post("Runtime.enable");
    await post("Runtime.setMaxCallStackSizeToCapture", { size: mode === "inspector" ? 32 : 0 });
  }
  Error.stackTraceLimit = 2;
  for (const name of [
    "recursive",
    "setter-read",
    "recapture",
    "reinstall",
    "throw",
    "setter-throw",
    "recapture-throw",
  ]) {
    test(name, () => {
      const target = new Error("probe"),
        data = {},
        outer = {},
        later = {},
        assigned = {},
        sentinel = {};
      let custom = 0,
        ordinary = 0,
        calls = 0,
        inner;
      const permissions = [];
      const next = () => {
        ordinary++;
        return later;
      };
      const formatter = function (holder, payload, allowed) {
        calls++;
        permissions.push(allowed);
        check(holder === target && payload === data && this === undefined, "callback arguments");
        if (!allowed) return "fallback";
        custom++;
        if (custom !== 1) return later;
        if (name.startsWith("setter")) target.stack = assigned;
        if (name.startsWith("recapture")) Error.captureStackTrace(target);
        if (name === "reinstall")
          check(api.install(target, next, data), "replacement installation");
        if (name === "recursive" || name === "setter-read") inner = target.stack;
        if (name.endsWith("throw")) throw sentinel;
        return outer;
      };
      check(api.install(target, formatter, data), "installation");
      check(calls === 0, "installation is lazy");
      const observed = withPrepare(next, () =>
        Array.from({ length: 3 }, () => {
          try {
            const value = target.stack;
            return value === outer
              ? "outer"
              : value === later
                ? "later"
                : value === assigned
                  ? "assigned"
                  : "other";
          } catch (value) {
            return value === sentinel ? "sentinel" : "other-throw";
          }
        }),
      );
      const expected =
        name === "setter-throw"
          ? ["sentinel", "assigned", "assigned"]
          : name.endsWith("throw")
            ? ["sentinel", "later", "later"]
            : ["recapture", "reinstall"].includes(name) && mode === "inspector"
              ? ["outer", "later", "later"]
              : ["outer", "outer", "outer"];
      check(JSON.stringify(observed) === JSON.stringify(expected), "three read identities");
      check(custom === (name === "throw" ? 2 : 1), "custom calls");
      check(
        ordinary ===
          (name === "recapture-throw" ||
          (["recapture", "reinstall"].includes(name) && mode === "inspector")
            ? 1
            : 0),
        "replacement calls",
      );
      check(
        JSON.stringify(permissions) ===
          JSON.stringify(
            name === "recursive" ? [true, false] : name === "throw" ? [true, true] : [true],
          ),
        "permission sequence",
      );
      if (name === "recursive") check(inner === "fallback", "recursive fallback");
      if (name === "setter-read") check(inner === assigned, "setter observed inside callback");
    });
  }
  const cachedValues = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["false", () => false],
    ["zero", () => 0],
    ["negative-zero", () => -0],
    ["nan", () => NaN],
    ["bigint", () => 1n],
    ["symbol", () => Symbol()],
    ["object", () => ({})],
    ["array", () => []],
    ["function", () => function () {}],
    ["self", (target) => target],
  ];
  for (const [label, make] of cachedValues) {
    for (const assigned of [false, true])
      test(`${assigned ? "assigned" : "returned"}-${label}`, () => {
        const target = new Error("cached"),
          value = make(target);
        let calls = 0;
        check(
          api.install(
            target,
            () => {
              calls++;
              return value;
            },
            value,
          ),
          "install",
        );
        if (assigned) target.stack = value;
        check(
          [target.stack, target.stack, target.stack].every((item) => Object.is(item, value)),
          "Object.is identity",
        );
        check(calls === (assigned ? 0 : 1), "cache call count");
      });
  }
  test("borrowed-holder", () => {
    const holder = new Error("holder"),
      child = Object.create(holder),
      value = {},
      data = {};
    let calls = 0;
    check(
      api.install(
        holder,
        (owner, payload, allow) => {
          calls++;
          check(owner === holder && payload === data && allow, "holder arguments");
          return value;
        },
        data,
      ),
      "install",
    );
    const { get, set } = Object.getOwnPropertyDescriptor(holder, "stack");
    check(get.call(child) === value && get.call(holder) === value && calls === 1, "holder cache");
    set.call(child, data);
    check(get.call(holder) === data && !Object.hasOwn(child, "stack"), "setter updates holder");
    check(get.call({}) === undefined, "empty getter");
  });
  for (const name of ["nonextensible", "nonconfigurable"])
    test(name, () => {
      const target = new Error("old"),
        old = {};
      let calls = 0,
        typeError = false;
      check(
        api.install(
          target,
          () => {
            calls++;
            return old;
          },
          null,
        ),
        "old installation",
      );
      if (name === "nonextensible") Object.preventExtensions(target);
      else Object.defineProperty(target, "stack", { configurable: false });
      const before = Object.getOwnPropertyDescriptor(target, "stack");
      try {
        api.install(target, () => "new", null);
      } catch (error) {
        typeError = error instanceof TypeError;
      }
      const after = Object.getOwnPropertyDescriptor(target, "stack");
      check(typeError && calls === 0, "failure without formatting");
      check(
        ["get", "set", "enumerable", "configurable"].every((key) => before[key] === after[key]),
        "descriptor unchanged",
      );
      typeError = false;
      try {
        Error.captureStackTrace(target);
      } catch (error) {
        typeError = error instanceof TypeError;
      }
      const recaptured = Object.getOwnPropertyDescriptor(target, "stack");
      check(typeError && calls === 0, "failed recapture without formatting");
      check(
        ["get", "set", "enumerable", "configurable"].every(
          (key) => before[key] === recaptured[key],
        ),
        "failed recapture preserves descriptor",
      );
      check(
        // oxlint-disable-next-line oxc/const-comparisons -- Each accessor read is observable and verifies caching.
        target.stack === old && target.stack === old && calls === 1,
        "old hidden state preserved",
      );
    });
  test("unsupported-proxy-target", () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        defineProperty() {
          traps++;
          return true;
        },
      },
    );
    check(
      api.install(proxy, () => "no", null) === false && traps === 0,
      "proxy rejected without traps",
    );
  });
  test("revoked-formatter-retries", () => {
    const owner = {},
      marker = {};
    const { proxy, revoke } = Proxy.revocable(() => marker, {});
    check(api.install(owner, proxy, null), "revocable callable install");
    revoke();
    for (let i = 0; i < 2; i++) {
      let typeError = false;
      try {
        void owner.stack;
      } catch (error) {
        typeError = error instanceof TypeError;
      }
      check(typeError, "revoked callback throws again without cache");
    }
    check(
      api.install(owner, () => marker, null) && owner.stack === marker,
      "replace after revoked callback",
    );
  });
  test("strict-sloppy-bound-proxy-realms", () => {
    const owner = {},
      data = {};
    let calls = 0;
    check(
      api.install(
        owner,
        function (h, d, allow) {
          calls++;
          return [this, h, d, allow];
        },
        data,
      ),
      "strict install",
    );
    check(
      owner.stack[0] === undefined &&
        owner.stack[1] === owner &&
        owner.stack[2] === data &&
        owner.stack[3],
      "strict receiver",
    );
    const sloppy = Function("h", "d", "allow", "return [this, h, d, allow]");
    check(
      api.install(owner, sloppy, data) && owner.stack[0] === globalThis,
      "sloppy global receiver",
    );
    const boundThis = {};
    check(
      api.install(owner, sloppy.bind(boundThis), data) && owner.stack[0] === boundThis,
      "bound callable",
    );
    const marker = {};
    const proxy = new Proxy(function () {}, {
      apply(fn, receiver, args) {
        calls++;
        check(
          receiver === undefined && args[0] === owner && args[1] === data && args[2],
          "proxy apply args",
        );
        return marker;
      },
    });
    check(
      api.install(owner, proxy, data) && owner.stack === marker && owner.stack === marker,
      "proxy callable",
    );
    const context = vm.createContext({});
    const realmGlobal = vm.runInContext("globalThis", context);
    const cross = vm.runInContext(
      "(function(h, d, allow) { return [this, h, d, allow]; })",
      context,
    );
    check(api.install(owner, cross, data), "cross realm install");
    check(
      owner.stack[0] === realmGlobal &&
        owner.stack[1] === owner &&
        owner.stack[2] === data &&
        owner.stack[3],
      "cross realm receiver",
    );
    check(calls === 2, "strict/proxy cached once");
  });
  test("global-holder", () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "stack");
    const marker = {};
    try {
      check(
        api.install(
          globalThis,
          (holder) => {
            check(holder === globalThis, "global proxy exposed");
            return marker;
          },
          null,
        ),
        "install global",
      );
      check(globalThis.stack === marker, "global cache");
    } finally {
      if (saved) Object.defineProperty(globalThis, "stack", saved);
      else delete globalThis.stack;
    }
  });
  test("ordinary-formatter-recursion-guard", () => {
    const outer = new Error("outer"),
      target = {},
      marker = {};
    let permission;
    check(
      api.install(
        target,
        (holder, data, allow) => {
          permission = allow;
          return "native fallback";
        },
        null,
      ),
      "install",
    );
    withPrepare(
      () => {
        check(target.stack === "native fallback", "fallback result");
        return marker;
      },
      () => {
        check(outer.stack === marker && permission === false, "global formatting guard");
      },
    );
  });
  test("overflow-throws-without-cache", () => {
    const target = {},
      marker = {};
    let calls = 0,
      rangeError = false;
    function overflow() {
      return overflow() + 1;
    }
    check(
      api.install(
        target,
        () => {
          if (++calls === 1) return overflow();
          return marker;
        },
        null,
      ),
      "install",
    );
    try {
      void target.stack;
    } catch (error) {
      rangeError = error instanceof RangeError;
    }
    check(rangeError && calls === 1, "formatter overflow propagated");
    // oxlint-disable-next-line oxc/const-comparisons -- Each accessor read is observable and verifies caching.
    check(target.stack === marker && target.stack === marker && calls === 2, "overflow not cached");
  });
  test("termination-without-cache", () =>
    check(api.termination() === true, "termination and retry"));
  test("own-detailed-trace", () => {
    api.captureDetailed(true);
    try {
      function capturedOwner() {
        return new Error("detailed");
      }
      const owner = capturedOwner(),
        data = {};
      let calls = 0;
      const before = api.trace(owner);
      check(before.length > 0, "detailed trace available");
      check(
        before.some(([name]) => name === ""),
        "unnamed frame preserved",
      );
      check(
        before.some(([name]) => name === "capturedOwner"),
        "named owner frame preserved",
      );
      check(
        api.installTrace(
          owner,
          () => {
            calls++;
            return data;
          },
          null,
        ),
        "same detailed trace object",
      );
      check(
        JSON.stringify(api.trace(owner)) === JSON.stringify(before) && calls === 0,
        "trace retained without formatting",
      );
      api.message(owner);
      check(calls === 0, "CreateMessage does not format lazy tuple");
      const child = Object.create(owner);
      check(
        api.install(child, () => data, null),
        "child install",
      );
      check(api.trace(child).length === 0, "inherited detailed trace not copied");
      check(JSON.stringify(api.trace(owner)) === JSON.stringify(before), "parent trace unchanged");
      check(owner.stack === data && calls === 1, "format later");
      check(
        JSON.stringify(api.trace(owner)) === JSON.stringify(before),
        "detailed trace survives formatting",
      );
    } finally {
      api.captureDetailed(mode === "inspector");
    }
  });
  for (const [action, label] of [
    "format",
    "setter",
    "recapture",
    "reinstall",
    "owner-drop",
  ].entries()) {
    test(`gc-${label}`, () => {
      const rounds = api.ownership(action);
      check(
        Number.isInteger(rounds) && rounds >= 1 && rounds <= 8,
        "pair retained then released with canary",
      );
    });
  }
  check(result.cases.length === 47, "exact complete case inventory");
  result.complete = true;
} catch (error) {
  result.failures.push(
    `${phase}: ${typeof error?.message === "string" ? error.message : "unexpected throw"}`,
  );
} finally {
  if (limit) Object.defineProperty(Error, "stackTraceLimit", limit);
  else delete Error.stackTraceLimit;
  if (session) {
    try {
      await post("Runtime.disable");
    } catch {
      result.complete = false;
      result.failures.push("Runtime.disable failed");
    } finally {
      session.disconnect();
    }
  }
}
const bytes = Buffer.from(`${JSON.stringify(result)}\n`);
if (bytes.length > 32768) throw new Error("probe record exceeds 32 KiB");
writeAll(1, bytes);
if (!result.complete || result.failures.length) process.exitCode = 1;
