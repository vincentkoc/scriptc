import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { EXECUTABLE_RUNTIME_SOURCES } from "../../compiler/src/backend/native-toolchain.js";

const exec = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test("direct dynamic errorMonitor adapts fixed Error and zero-argument listeners", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-emitter-monitor-"));
  try {
    const bin = join(dir, "emitter-monitor");
    await exec(
      "clang",
      [
        "-std=c11",
        "-O1",
        "-Wall",
        "-Wextra",
        "-Wno-deprecated-declarations",
        "-pthread",
        ...(sanitize ? ["-fsanitize=address,undefined", "-DSCR_RC_AUDIT"] : []),
        ...(process.platform === "linux" ? ["-D_GNU_SOURCE"] : []),
        join(import.meta.dirname, "scr_events_emitter.test.c"),
        join(import.meta.dirname, "scr_events_emitter.c"),
        join(import.meta.dirname, "scr_dyn_handle.c"),
        ...EXECUTABLE_RUNTIME_SOURCES.map((name) => join(import.meta.dirname, name)),
        ...(process.platform === "linux" ? ["-lm"] : []),
        "-o",
        bin,
      ],
      { timeout: 180_000 },
    );
    const result = await exec(bin, [], {
      timeout: 30_000,
      env: { ...process.env, UBSAN_OPTIONS: "halt_on_error=1" },
    });
    expect(result.stdout).toBe("direct dynamic errorMonitor adapts fixed listeners\n");
    expect(result.stderr).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 240_000);
