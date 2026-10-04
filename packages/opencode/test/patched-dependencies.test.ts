import { describe, expect, test } from "bun:test"
import path from "path"

// Bun applies a patch only to the exact `name@version` named in
// `patchedDependencies`. Bumping the dependency without regenerating the patch
// does not fail `bun install`; the patch just stops applying and the runtime
// silently loses whatever the patch fixed. This pins the two together for the
// packages that ship in the CLI.
const root = path.resolve(import.meta.dir, "../../..")
// Every place a patched dependency can land: under each workspace with the isolated layout bun
// uses by default, and at the root under `--linker hoisted`, which CI passes on Windows. Looking
// in only one layout's places makes this report "not installed" under the other, which is how the
// hoisted job found it.
const locations = ["packages/opencode", "packages/core", "."]
const patched = (await Bun.file(path.join(root, "package.json")).json()).patchedDependencies as Record<string, string>

describe("patched dependencies", () => {
  for (const key of Object.keys(patched)) {
    const at = key.lastIndexOf("@")
    const name = key.slice(0, at)
    const version = key.slice(at + 1)

    test(`${key} matches the installed version`, async () => {
      expect(await Bun.file(path.join(root, patched[key])).exists()).toBe(true)
      for (const location of locations) {
        const file = Bun.file(path.join(root, location, "node_modules", name, "package.json"))
        if (!(await file.exists())) continue
        const installed = (await file.json()).version as string
        expect(
          installed,
          `${location}/node_modules resolves ${name}@${installed}; patch is for ${version}`,
        ).toBe(version)
      }
    })
  }

  // A patch that stopped applying is silent, and so is one applied twice — bun can reach that state
  // from a cache entry that was itself patched, which happened in this repository's container while
  // this was being written. The version test above sees neither case.
  //
  // Not generic over all twenty patches, and that is measured rather than assumed: a dozen of them
  // add a bare `//` that their target holds dozens of times, and five add a substantial line their
  // own target already holds elsewhere (`@ai-sdk/xai`, `mistral`, `anthropic`, `amazon-bedrock`,
  // `@modelcontextprotocol/sdk`), so any count-based rule false-alarms on real patches.
  //
  // Both of bun-pty's hunks are counted, because they fail differently and are guarded differently.
  // Without the close, a terminal that exits by itself leaks four descriptors — which
  // `pty-spawn.test.ts` catches deterministically by counting them. Without the deferred read, a pty
  // loses the first output of every terminal and the exit of a short-lived one, and the only
  // behavioural guard for that is a batch whose loss rate depends on the machine's load, so for that
  // hunk this is the guard that cannot pass by luck.
  test("bun-pty's patch is applied exactly once", async () => {
    // Gated on the patch still being declared, so that dropping it — upstream shipping the fix —
    // reads as the patch being gone rather than as a broken install.
    if (!Object.keys(patched).some((key) => key.startsWith("bun-pty@"))) return
    // The close appears once in the pristine file, in `kill()`, and twice once the patch has added
    // its own; three would be the patch applied twice.
    const markers = { "queueMicrotask(() => this._startReadLoop())": 1, "bun_pty_close(this.handle)": 2 }
    let checked = 0
    for (const location of locations) {
      const file = Bun.file(path.join(root, location, "node_modules", "bun-pty", "src", "terminal.ts"))
      if (!(await file.exists())) continue
      checked++
      const text = await file.text()
      for (const [marker, expected] of Object.entries(markers)) {
        expect(
          text.split(marker).length - 1,
          `${location}/node_modules holds a bun-pty with the wrong number of \`${marker}\``,
        ).toBe(expected)
      }
    }
    expect(checked, "bun-pty is not installed in any location this test looks at").toBeGreaterThan(0)
  })
})
