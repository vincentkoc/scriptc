# Standalone lazy stack API patch

`node-v24-lazy-stack-owner.patch` adds the proposed public V8 API `Exception::SetLazyStackTrace(context, target, formatter, data)` to Node 24.22.0 and 24.22.1. This is a dependency experiment. The production libnode builder, cache keys, pins, scriptc runtime, and bridge ABI do not consume this patch.

The API installs ordinary stack accessors without capturing frames or invoking the formatter. V8 owns the formatter and payload in an existing `Tuple2`. A read calls the formatter with `(holder, data, mayInvokeCustomFormatter)` and an undefined receiver. Bound functions, callable proxies, and normal function realm semantics apply. The holder is the hidden stack property's owner; a global object is exposed as its global proxy.

The permission argument is false during stack-formatting reentry or an existing stack overflow. The formatter must then use a native fallback without invoking user formatting. This does not guarantee enough stack remains to call the formatter. Invocation failures do not commit a formatter result; callback side effects, including a stack assignment before a throw, remain. Successful results use the existing plain and inspector-wrapped cache writeback paths.

Only the target's own detailed trace is preserved. Inherited metadata is not copied. Unsupported targets, including proxies, return `Just(false)` without invoking traps. Incompatible accessors and nonextensible targets throw through the ordinary capture installation policy and keep the old hidden state. All API handles must be nonempty and belong to the current isolate.

## Focused remote proof

`qualify-node-lazy-stack-patch.yml` builds each checksum-pinned official source archive in a fresh owned directory on the repository's existing Linux hosted route. It applies the exact patch, configures `--shared --ninja`, and builds the release Node executable and libnode with two compile jobs. It does not reuse a libnode cache or construct a scriptc pack. Disk, inode, and memory telemetry are recorded; resource failures stop the proof without a retry or runner cleanup.

The public C++ addon uses the exact patched headers and links to that build's libnode. Each pin runs fresh plain, inspector, and inspector-zero processes:

- The unchanged stock oracle checks 35 cases and 147 assertions, or 148 with inspector capture enabled.
- The API probe checks 47 cases and 184 JavaScript assertions, plus C++ owner assertions. It covers cache identities, receiver semantics, failed capture, reentry, throws, termination and retry, detailed traces, and weak-handle retention and release. Full collections require `--expose-gc`. All cases use Node's default stack size.

The workflow requires exact ordered inventories, clean exits, empty stderr, complete bounded streams, drained process groups, and unchanged source, configuration, toolchain, and binary hashes. It retains the input patch/tests, configuration, logs, normalized JSON records, and a manifest. Built binaries and source trees are removed after group drainage; their hashes are retained.

Compilation and patched-runtime results remain pending until the remote receipt is accepted. Formatter-induced recursive overflow tests propagation and retry; it does not exercise an already-overflowed stack's permission branch. That branch remains source-reviewed only. This proof does not claim heap-verifier, cross-platform, performance, production adoption, or scriptc integration qualification.
