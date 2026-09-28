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
// What this batch is and is not. Reaching that window needs the child to finish before
// `bun_pty_spawn` returns, so the rate follows how descheduled the parent is: measured unpatched on
// four cores, in batches of 30, idle is 1 lost exit in 150 while three busy cores give 8 lost exits
// and 16 lost outputs in 150. So on an idle machine an unpatched run can pass this, and a first
// version of this comment quoted 7 in 30 as though it were the rate — it was a busy machine's.
// What guards the patch itself is not here but deterministic: `patched-dependencies.test.ts` asserts
// the line this patch adds is present exactly once. This batch proves the effect end to end through
// the real shim, and covers the part no marker can — that `Pty.create` still subscribes early
// enough — on any machine loaded enough to lose one, which CI is.
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
