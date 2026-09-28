import { describe, expect, test } from "bun:test"
import path from "path"

// Bun applies a patch only to the exact `name@version` named in
// `patchedDependencies`. Bumping the dependency without regenerating the patch
// does not fail `bun install`; the patch just stops applying and the runtime
// silently loses whatever the patch fixed. This pins the two together for the
// packages that ship in the CLI.
const root = path.resolve(import.meta.dir, "../../..")
const workspaces = ["packages/opencode", "packages/core"]
const patched = (await Bun.file(path.join(root, "package.json")).json()).patchedDependencies as Record<string, string>

describe("patched dependencies", () => {
  for (const key of Object.keys(patched)) {
    const at = key.lastIndexOf("@")
    const name = key.slice(0, at)
    const version = key.slice(at + 1)

    test(`${key} matches the installed version`, async () => {
      expect(await Bun.file(path.join(root, patched[key])).exists()).toBe(true)
      for (const workspace of workspaces) {
        const file = Bun.file(path.join(root, workspace, "node_modules", name, "package.json"))
        if (!(await file.exists())) continue
        const installed = (await file.json()).version as string
        expect(installed, `${workspace} resolves ${name}@${installed}; patch is for ${version}`).toBe(version)
      }
    })
  }

  // A patch that stopped applying is silent; so is one applied twice, which bun can reach from a
  // cache entry that was itself patched — it happened in a container while this was being written.
  // The version test above sees neither case. This one is not generic on purpose: several of the
  // AI-SDK patches add lines that already appear elsewhere in their target, so counting them would
  // be a false alarm waiting to happen. bun-pty is where a second copy does damage — two read loops
  // over one handle, both reaching the close the patch added — and where nothing else can see it,
  // because duplicated output still satisfies the behavioural test in `packages/core`. It doubles as
  // the only direct evidence that this patch is live at all, rather than inferred from a test that
  // fails by loss rate.
  test("bun-pty's patch is applied exactly once", async () => {
    const marker = "queueMicrotask(() => this._startReadLoop())"
    let checked = 0
    for (const workspace of workspaces) {
      const file = Bun.file(path.join(root, workspace, "node_modules", "bun-pty", "src", "terminal.ts"))
      if (!(await file.exists())) continue
      checked++
      expect(
        (await file.text()).split(marker).length - 1,
        `${workspace} resolves a bun-pty that is not patched once`,
      ).toBe(1)
    }
    expect(checked, "bun-pty is not installed in any workspace this test looks at").toBeGreaterThan(0)
  })
})
