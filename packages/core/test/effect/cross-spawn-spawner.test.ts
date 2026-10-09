import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Shell } from "@opencode-ai/core/shell"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const live = LayerNode.compile(CrossSpawnSpawner.node)
const fx = testEffect(live)

function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const total = chunks.reduce((acc, x) => acc + x.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const chunk of chunks) {
        out.set(chunk, off)
        off += chunk.length
      }
      return new TextDecoder("utf-8").decode(out).trim()
    }),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

describe("cross-spawn spawner", () => {
  describe("basic spawning", () => {
    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  describe("cwd option", () => {
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        expect(yield* Effect.promise(() => fs.realpath(out))).toBe(yield* Effect.promise(() => fs.realpath(tmp.path)))
      }),
    )

    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.spawn(ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" })),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("env option", () => {
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  describe("stderr", () => {
    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js(
          [
            "let pending = 2",
            "const done = () => {",
            "  pending -= 1",
            "  if (pending === 0) setTimeout(() => process.exit(0), 0)",
            "}",
            'process.stdout.write("stdout\\n", done)',
            'process.stderr.write("stderr\\n", done)',
          ].join("\n"),
        )
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: 2,
        })
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  describe("combined output (all)", () => {
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("echo", ["hello from stdout"])
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )
  })

  describe("process control", () => {
    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "kills a child when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)")
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const started = Date.now()
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js('process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)')
            yield* handle.kill({ forceKillAfter: 100 })
            return yield* handle.exitCode
          }),
        )

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["OPENCODE_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { OPENCODE_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("OPENCODE_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  })
  // #40, and #11 before it: on Windows `SessionPrompt.shell` burns its whole 15s wait on a
  // `sleep 0.2`, twice at 17138ms and 17085ms — 53ms apart, which is a stop rather than a slow
  // machine. What that failure cannot say is which step stopped, because the shell call spawns,
  // drains the merged output and then waits for the exit code inside one fiber. These bound the
  // three separately, in the shape that call uses (`stdin: "ignore"`, `forceKillAfter`, and the
  // merge of stdout and stderr), so a Windows run names the step. On Linux all of them are
  // milliseconds.
  //
  // Two leads this level can also settle, both deviations from the Effect spawner this file's
  // subject was forked from: it resolves its exit on the child's `close` rather than its `exit`,
  // and it opens Windows pipes `overlapped` where upstream never does. Either would strand a wait
  // exactly this way.
  describe("observing an exit the way the shell tool does", () => {
    // `fx.live` rather than `fx.effect`: every bound below is a real-clock timeout, and the shared
    // harness runs `effect` against a TestClock where virtual time never advances — a bound that
    // cannot fire would hand a Windows run the suite ceiling and none of these names.
    const bounded = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      message: string,
      duration: `${number} seconds` = "10 seconds",
    ) => effect.pipe(Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(new Error(message)) }))

    // The label is the point: if the drain is what stalls, a Windows run has to say which of pwsh,
    // powershell, Git Bash or cmd was on the other end of it, which is the whole reason these exist.
    //
    // The pid and the bytes already received are in the message because the first real firing of
    // this bound, on 1adda53919, carried neither and so could not separate the two shapes it leaves
    // open: a child that wrote its line and exited while the merge never signalled an end, and a
    // child still holding its handles with nothing written. Those want different fixes.
    const drain = (
      handle: { pid: number; all: Stream.Stream<Uint8Array, PlatformError.PlatformError> },
      what: string,
    ) =>
      Effect.gen(function* () {
        let out = ""
        yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.sync(() => {
            out += chunk
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail(
                new Error(
                  `the merged output of ${what} never ended; pid ${handle.pid} is ${alive(handle.pid) ? "still there" : "gone"} and it had written ${out ? JSON.stringify(out) : "nothing"}`,
                ),
              ),
          }),
        )
        return out
      })

    // The shell tool's own resolution and arguments, with the `stdin: "ignore"` and `forceKillAfter`
    // that call passes. Three tests below spawn it, and the shape is the thing under test, so it is
    // written once rather than copied a third time.
    const shellHandle = (shell: string) =>
      ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
        svc.spawn(
          ChildProcess.make(shell, Shell.args(shell, "echo opencode-shell-ok", process.cwd()), {
            cwd: process.cwd(),
            extendEnv: true,
            env: { TERM: "dumb" },
            stdin: "ignore",
            forceKillAfter: "3 seconds",
          }),
        ),
      )

    fx.live(
      "ends the merged output of a child that wrote to both streams and exited",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("out"); process.stderr.write("err"); process.exit(0)', {
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        })
        const out = yield* drain(handle, "a node child")
        expect(out).toContain("out")
        expect(out).toContain("err")
      }),
      30_000,
    )

    fx.live(
      "reports the exit code once that output has been drained",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done"); process.exit(7)', {
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        })
        expect(yield* drain(handle, "a node child")).toContain("done")
        const code = yield* bounded(handle.exitCode, "the exit code never arrived after the output ended")
        expect(code).toBe(ChildProcessSpawner.ExitCode(7))
      }),
      30_000,
    )

    fx.live(
      "reports the exit code of the preferred shell running a command",
      Effect.gen(function* () {
        // The shell tool's own resolution, which on Windows is whichever of pwsh, powershell, Git
        // Bash or COMSPEC comes first, with the arguments that shell is given there. A cold shell is
        // seconds on a loaded runner, hence the wider bound; the failure being chased is a stop.
        const shell = Shell.preferred()
        const handle = yield* shellHandle(shell)
        expect(yield* drain(handle, shell)).toContain("opencode-shell-ok")
        const code = yield* bounded(
          handle.exitCode,
          `the exit code of ${shell} never arrived after the output ended`,
          "20 seconds",
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
      // Above the sum of the two bounds, not equal to it: at 30s a double stall races the suite
      // ceiling and reports `timed out after 30000ms`, which is the message these exist to avoid.
      45_000,
    )

    // The test above reports that the merge of the two streams stalled; this reports which half, by
    // draining the sides separately with a bound each. The merge ends only once both sides have, so
    // the three cases #40 has been unable to tell apart read differently here: one side alone fails
    // and names itself, both fail if the child is holding its handles, and both passing while the
    // merged drain stalls puts the fault in the merge rather than in either pipe. Each bound also
    // reports whether the child's pid is still there, because a pipe left open by a process that is
    // gone and one held by a process still running want different fixes.
    //
    // Two samples so far, and they disagree about which of the three it is. On 1adda53919 this
    // passed in the job where the merged drain above failed, which reads as the third case; on
    // a153859255 both failed, this one naming `stdout`, which does not. The conclusion drawn from
    // the first sample alone was wrong, and is recorded on #40 as such: one job is one spawn of
    // one shell, and this bound fires in roughly one Windows job in four.
    //
    // What both samples do agree on is the pair of fields the merged message carries since
    // a153859255: the pid is still there and nothing has been written. Not a stream that delivered
    // output and then hung — a child that has produced nothing yet, while the forty spawns below
    // pass minutes later in the same process. That points at a cold start outlasting the bound
    // rather than at a stall in either shape.
    //
    // Drained concurrently and not one after the other: Windows opens these `overlapped`, where a
    // reader that stops reading can block the pipe, so reading one to its end while the other waits
    // would be a stall this test caused rather than one it found.
    fx.live(
      "names which of the preferred shell's streams never ends",
      Effect.gen(function* () {
        const shell = Shell.preferred()
        const handle = yield* shellHandle(shell)
        // Not `handle.isRunning`, which is `!Deferred.isDone(signal)` and so reports whether `close`
        // has fired — the very thing that has not, whenever this bound fires, so it would read
        // "alive" in every failure and distinguish nothing. Signal 0 checks for the pid instead,
        // which both platforms answer. It cannot tell a zombie from a live process, but a child of
        // this test is reaped by node, so a pid still present here means the process really is.
        const side = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>, which: string) =>
          Stream.runDrain(stream).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () =>
                Effect.fail(
                  new Error(
                    `the ${which} of ${shell} never ended, and pid ${handle.pid} is ${alive(handle.pid) ? "still there" : "gone"}`,
                  ),
                ),
            }),
          )
        yield* Effect.all([side(handle.stdout, "stdout"), side(handle.stderr, "stderr")], {
          concurrency: "unbounded",
        })
        const code = yield* bounded(
          handle.exitCode,
          `the exit code of ${shell} never arrived after both of its streams ended`,
          "20 seconds",
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
      45_000,
    )

    // #40 shows up in roughly one `unit (windows)` job in four, and a single spawn per run mostly
    // catches nothing, so this runs the same shape ATTEMPTS times in a row and puts the race under
    // load dozens of times in one job. The attempt number is in the message because "attempt 1" and
    // "attempt 37" are different findings: the first is a cold start, the second a race that needs
    // repetition to show.
    //
    // It drains the merged stream, which is the correction this test needed: the first version
    // bounded `stdout` and `stderr` separately, the shape the test above already covers once, so it
    // never exercised what `shellImpl` drains at all.
    //
    // Forty attempts have now passed in both jobs where the single spawns above failed, which is
    // itself the measurement: whatever this is, it is not a per-spawn race — it is paid once, early,
    // and not again.
    //
    // Sequential, one child at a time, and each in its own scope: that is the shape the shell tool
    // uses, and forty concurrent shells on a two-core runner would be a stall this test manufactured
    // rather than one it found.
    const ATTEMPTS = 40

    fx.live(
      "ends the merged output of the preferred shell on each of forty consecutive spawns",
      Effect.gen(function* () {
        const shell = Shell.preferred()
        yield* Effect.forEach(
          Array.from({ length: ATTEMPTS }, (_, i) => i + 1),
          (attempt) =>
            Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* shellHandle(shell)
                expect(yield* drain(handle, `${shell} on attempt ${attempt} of ${ATTEMPTS}`)).toContain(
                  "opencode-shell-ok",
                )
                expect(
                  yield* bounded(
                    handle.exitCode,
                    `the exit code of ${shell} never arrived on attempt ${attempt} of ${ATTEMPTS}`,
                  ),
                ).toBe(ChildProcessSpawner.ExitCode(0))
              }),
            ),
          { discard: true },
        )
      }),
      // Forty shells, not one: generous because a loaded Windows runner pays a few hundred milliseconds
      // of shell startup each time. A stall still fails at its own bound in ten seconds, so this
      // ceiling only has to cover the healthy path.
      240_000,
    )
  })
})
