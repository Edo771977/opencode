import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import { spawn } from "#pty"

// bun-pty delivers an event to the listeners registered at that instant and keeps nothing for
// anyone else. Its read loop used to take its first read inside the `Terminal` constructor —
// `_startReadLoop` is async but has nothing to await before that read — so a process that finished,
// or wrote, before `spawn` returned fired at an emitter nobody could have subscribed to yet. A lost
// exit strands the session: the loop breaks after firing it, so nothing reports it again and the
// session stays `running` for the life of the process. patches/bun-pty@0.4.8.patch defers that
// first read past the constructor.
//
// What this batch is and is not. Reaching that window needs the child to finish, or write, before
// the constructor's first read, so the rate follows how descheduled the parent is — and only
// qualitatively. Two independent measurements on four cores, unpatched, in batches of 30: single
// figures of lost exits per 150 with the machine idle, several times that under load, and lost
// outputs running about twice lost exits throughout. Neither of us reproduced the other's exact
// rates, and within one run the rate fell as the load average rose, so no pair of numbers describes
// this and earlier versions of this comment quoting some were wrong to. What does reproduce, and is
// the whole argument that the constructor window is the mechanism rather than slowness: give the
// child 50ms of life and lost exits go to zero in every condition, while outputs keep being lost.
//
// So this is a real but probabilistic guard on the deferral — an unpatched idle run still failed it
// in roughly three batches of five — and `patched-dependencies.test.ts` holds the deterministic one,
// asserting the added line is there exactly once. What no marker can cover is `Pty.create` still
// subscribing in the turn that spawns, and that is not covered here either: `run()` below subscribes
// in its own turn, mimicking that call rather than exercising it. `pty-session.test.ts` is the test
// that goes through `Pty.create`, and it fails unpatched under load.
const SESSIONS = 30
const ptyTest = process.platform === "win32" ? test.skip : test
// The descriptor count below reads /proc, which is Linux's alone.
const fdTest = process.platform === "linux" ? test : test.skip

const run = (command: string) =>
  new Promise<{ exitCode?: number; output: string }>((resolve) => {
    const proc = spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cwd: "/tmp", env: { TERM: "xterm" } })
    let output = ""
    let settled = false
    const settle = (exitCode?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, output })
    }
    const timer = setTimeout(() => settle(), 5000)
    // Subscribed in the turn that spawned, which is where `Pty.create` subscribes and the last point
    // at which a subscription is early enough.
    proc.onData((chunk) => {
      output += chunk
    })
    proc.onExit((event) => settle(event.exitCode))
  })

describe("pty spawn", () => {
  ptyTest(
    "reports the exit and the output of a process that finishes before the spawn returns",
    async () => {
      const runs = []
      for (let i = 0; i < SESSIONS; i++) runs.push(await run("echo hello; exit 7"))
      // Output first: it was the more frequent of the two losses, so it is the more sensitive guard.
      expect(runs.filter((x) => !x.output.includes("hello")).length).toBe(0)
      expect(runs.filter((x) => x.exitCode !== 7).length).toBe(0)
    },
    60_000,
  )

  fdTest(
    "releases the pty of a session that ended on its own",
    async () => {
      // `kill()` was the only path that closed the handle, so a terminal left to exit by itself
      // leaked its pty — four descriptors a session, measured, with nothing left able to close them.
      // Unlike the batch above this is deterministic: the leak is every session, not a race, so this
      // is the guard for the patch's second hunk and it cannot pass on a quiet machine.
      // The first spawn opens the library's own descriptors, so it is not counted.
      await run("exit 0")
      const open = () => fs.readdirSync("/proc/self/fd").length
      const before = open()
      for (let i = 0; i < 20; i++) await run("exit 0")
      expect(open()).toBeLessThanOrEqual(before + 4)
    },
    60_000,
  )
})
