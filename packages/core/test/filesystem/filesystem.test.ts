import { describe, test, expect, spyOn } from "bun:test"
import { Effect, FileSystem } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import path from "path"
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises"
import { realpathSync } from "fs"
import { tmpdir } from "../fixture/tmpdir"

const live = LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))
const { effect: it } = testEffect(live)

describe("FSUtil", () => {
  describe("isDir", () => {
    it(
      "returns true for directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        expect(yield* fs.isDir(tmp)).toBe(true)
      }),
    )

    it(
      "returns false for files",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* filesys.writeFileString(file, "hello")
        expect(yield* fs.isDir(file)).toBe(false)
      }),
    )

    it(
      "returns false for non-existent paths",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        expect(yield* fs.isDir("/tmp/nonexistent-" + Math.random())).toBe(false)
      }),
    )
  })

  describe("isFile", () => {
    it(
      "returns true for files",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "test.txt")
        yield* filesys.writeFileString(file, "hello")
        expect(yield* fs.isFile(file)).toBe(true)
      }),
    )

    it(
      "returns false for directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        expect(yield* fs.isFile(tmp)).toBe(false)
      }),
    )
  })

  describe("readFileStringSafe", () => {
    it(
      "returns file contents when file exists",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "exists.txt")
        yield* filesys.writeFileString(file, "hello")

        const result = yield* fs.readFileStringSafe(file)
        expect(result).toBe("hello")
      }),
    )

    it(
      "returns undefined for missing file (NotFound)",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()

        const result = yield* fs.readFileStringSafe(path.join(tmp, "does-not-exist.txt"))
        expect(result).toBeUndefined()
      }),
    )
  })

  describe("readJson / writeJson", () => {
    it(
      "round-trips JSON data",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "data.json")
        const data = { name: "test", count: 42, nested: { ok: true } }

        yield* fs.writeJson(file, data)
        const result = yield* fs.readJson(file)

        expect(result).toEqual(data)
      }),
    )

    it(
      "fails invalid JSON through the error channel",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "broken.json")
        yield* filesys.writeFileString(file, "{")

        const result = yield* fs.readJson(file).pipe(Effect.catch((error) => Effect.succeed(error)))

        expect(result).toHaveProperty("_tag", "FileSystemError")
      }),
    )
  })

  describe("ensureDir", () => {
    it(
      "creates nested directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const nested = path.join(tmp, "a", "b", "c")

        yield* fs.ensureDir(nested)

        const info = yield* filesys.stat(nested)
        expect(info.type).toBe("Directory")
      }),
    )

    it(
      "is idempotent",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const dir = path.join(tmp, "existing")
        yield* filesys.makeDirectory(dir)

        yield* fs.ensureDir(dir)

        const info = yield* filesys.stat(dir)
        expect(info.type).toBe("Directory")
      }),
    )
  })

  describe("writeWithDirs", () => {
    it(
      "creates parent directories if missing",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "deep", "nested", "file.txt")

        yield* fs.writeWithDirs(file, "hello")

        expect(yield* filesys.readFileString(file)).toBe("hello")
      }),
    )

    it(
      "writes directly when parent exists",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "direct.txt")

        yield* fs.writeWithDirs(file, "world")

        expect(yield* filesys.readFileString(file)).toBe("world")
      }),
    )

    it(
      "writes Uint8Array content",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "binary.bin")
        const content = new Uint8Array([0x00, 0x01, 0x02, 0x03])

        yield* fs.writeWithDirs(file, content)

        const result = yield* filesys.readFile(file)
        expect(new Uint8Array(result)).toEqual(content)
      }),
    )
  })

  describe("findUp", () => {
    it(
      "finds target in start directory",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "target.txt"), "found")

        const result = yield* fs.findUp("target.txt", tmp)
        expect(result).toEqual([path.join(tmp, "target.txt")])
      }),
    )

    it(
      "finds target in parent directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "marker"), "root")
        const child = path.join(tmp, "a", "b")
        yield* filesys.makeDirectory(child, { recursive: true })

        const result = yield* fs.findUp("marker", child, tmp)
        expect(result).toEqual([path.join(tmp, "marker")])
      }),
    )

    it(
      "returns empty array when not found",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const result = yield* fs.findUp("nonexistent", tmp, tmp)
        expect(result).toEqual([])
      }),
    )
  })

  describe("up", () => {
    it(
      "finds multiple targets walking up",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "a.txt"), "a")
        yield* filesys.writeFileString(path.join(tmp, "b.txt"), "b")
        const child = path.join(tmp, "sub")
        yield* filesys.makeDirectory(child)
        yield* filesys.writeFileString(path.join(child, "a.txt"), "a-child")

        const result = yield* fs.up({ targets: ["a.txt", "b.txt"], start: child, stop: tmp })

        expect(result).toContain(path.join(child, "a.txt"))
        expect(result).toContain(path.join(tmp, "a.txt"))
        expect(result).toContain(path.join(tmp, "b.txt"))
      }),
    )
  })

  describe("glob", () => {
    it(
      "finds files matching pattern",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "a.ts"), "a")
        yield* filesys.writeFileString(path.join(tmp, "b.ts"), "b")
        yield* filesys.writeFileString(path.join(tmp, "c.json"), "c")

        const result = yield* fs.glob("*.ts", { cwd: tmp })
        expect(result.sort()).toEqual(["a.ts", "b.ts"])
      }),
    )

    it(
      "supports absolute paths",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "file.txt"), "hello")

        const result = yield* fs.glob("*.txt", { cwd: tmp, absolute: true })
        expect(result).toEqual([path.join(tmp, "file.txt")])
      }),
    )
  })

  describe("globMatch", () => {
    it(
      "matches patterns",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        expect(fs.globMatch("*.ts", "foo.ts")).toBe(true)
        expect(fs.globMatch("*.ts", "foo.json")).toBe(false)
        expect(fs.globMatch("src/**", "src/a/b.ts")).toBe(true)
      }),
    )
  })

  describe("globUp", () => {
    it(
      "finds files walking up directories",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        yield* filesys.writeFileString(path.join(tmp, "root.md"), "root")
        const child = path.join(tmp, "a", "b")
        yield* filesys.makeDirectory(child, { recursive: true })
        yield* filesys.writeFileString(path.join(child, "leaf.md"), "leaf")

        const result = yield* fs.globUp("*.md", child, tmp)
        expect(result).toContain(path.join(child, "leaf.md"))
        expect(result).toContain(path.join(tmp, "root.md"))
      }),
    )
  })

  describe("built-in passthrough", () => {
    it(
      "exists works",
      Effect.gen(function* () {
        yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "exists.txt")
        yield* filesys.writeFileString(file, "yes")

        expect(yield* filesys.exists(file)).toBe(true)
        expect(yield* filesys.exists(file + ".nope")).toBe(false)
      }),
    )

    it(
      "remove works",
      Effect.gen(function* () {
        yield* FSUtil.Service
        const filesys = yield* FileSystem.FileSystem
        const tmp = yield* filesys.makeTempDirectoryScoped()
        const file = path.join(tmp, "delete-me.txt")
        yield* filesys.writeFileString(file, "bye")

        yield* filesys.remove(file)

        expect(yield* filesys.exists(file)).toBe(false)
      }),
    )
  })

  describe("pure helpers", () => {
    test("mimeType returns correct types", () => {
      expect(FSUtil.mimeType("file.json")).toBe("application/json")
      expect(FSUtil.mimeType("image.png")).toBe("image/png")
      expect(FSUtil.mimeType("unknown.qzx")).toBe("application/octet-stream")
    })

    test("contains checks path containment", () => {
      expect(FSUtil.contains("/a/b", "/a/b/c")).toBe(true)
      expect(FSUtil.contains("/a/b", "/a/b")).toBe(true)
      expect(FSUtil.contains("/a/b", "/a/c")).toBe(false)
      expect(FSUtil.contains("/a/b", "/a/bad")).toBe(false)
      if (process.platform === "win32") expect(FSUtil.contains("C:\\a", "D:\\b")).toBe(false)
    })

    test("overlaps detects overlapping paths", () => {
      expect(FSUtil.overlaps("/a/b", "/a/b/c")).toBe(true)
      expect(FSUtil.overlaps("/a/b/c", "/a/b")).toBe(true)
      expect(FSUtil.overlaps("/a", "/b")).toBe(false)
      expect(FSUtil.overlaps("/a/b", "/a/bad")).toBe(false)
      if (process.platform === "win32") expect(FSUtil.overlaps("C:\\a", "D:\\b")).toBe(false)
    })

    // Windows: the JS realpath lstats the drive root, which fails with EPERM in an AppContainer
    test("resolve goes through the native realpath on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const target = path.join(tmp.path, "real")
      await mkdir(target)
      const link = path.join(tmp.path, "link")
      await symlink(target, link, "junction")
      const native = spyOn(realpathSync, "native")
      try {
        expect(FSUtil.resolve(link)).toBe(FSUtil.normalizePath(target))
        expect(native.mock.calls[0]?.[0]).toBe(path.resolve(link))
      } finally {
        native.mockRestore()
      }
    })

    test("resolve falls back to the JS realpath when the native call fails on Windows", async () => {
      if (process.platform !== "win32") return
      await using tmp = await tmpdir()
      const native = spyOn(realpathSync, "native").mockImplementationOnce(() => {
        throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" })
      })
      try {
        expect(FSUtil.resolve(tmp.path)).toBe(FSUtil.normalizePath(tmp.path))
      } finally {
        native.mockRestore()
      }
    })
  })
  // The sweeper's own guards live here as well as in the two skill-discovery suites, because those
  // are in `packages/opencode` and `packages/core` respectively: deleting both guards left a
  // `packages/core` run entirely green, which is the run somebody editing this file will do.
  describe("sweepStale", () => {
    // Derived from `FSUtil.stagingNames` rather than spelled out again: a third copy of the suffix
    // here is part of what let the other two drift unnoticed (#39). With the producer in the loop,
    // renaming a suffix or editing `LEFTOVER` fails this suite instead of quietly retiring the
    // sweep for whichever runtime was edited.
    const leftover = (dir: string, name: string) => FSUtil.stagingNames(path.join(dir, name)).backup

    it(
      "collects a backup whose directory is back in place, through a symlink as well",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const paired = leftover(tmp, "plain")
        const linked = leftover(tmp, "linked")
        yield* Effect.promise(async () => {
          await mkdir(path.join(tmp, "plain"))
          await mkdir(path.join(tmp, "elsewhere"))
          await symlink(path.join(tmp, "elsewhere"), path.join(tmp, "linked"))
          await mkdir(paired)
          await mkdir(linked)
        })
        yield* FSUtil.sweepStale(fs, tmp)
        expect(yield* fs.existsSafe(paired)).toBe(false)
        // A symlink resolving to the directory is the directory, back in place. Judged by kind
        // rather than by resolution, this backup would be immortal: backups have no age test.
        expect(yield* fs.existsSafe(linked)).toBe(false)
      }),
    )

    it(
      "keeps a backup whose name is not a directory, and a leftover that is not one either",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const shadowed = leftover(tmp, "pinned")
        const orphan = leftover(tmp, "gone")
        const fileShaped = leftover(tmp, "kept")
        yield* Effect.promise(async () => {
          // A file where the cached directory would be: not the swap having landed, so its backup
          // may still be the only copy of that skill.
          await writeFile(path.join(tmp, "pinned"), "not a directory")
          await mkdir(path.join(tmp, "kept"))
          await mkdir(shadowed)
          await mkdir(orphan)
          // Right shape, wrong kind: a swap never leaves a file behind, so this is somebody else's.
          await writeFile(fileShaped, "not a directory either")
        })
        yield* FSUtil.sweepStale(fs, tmp)
        expect(yield* fs.isDir(shadowed)).toBe(true)
        expect(yield* fs.isDir(orphan)).toBe(true)
        expect(yield* fs.isFile(fileShaped)).toBe(true)
      }),
    )

    // The staging half of the pattern had no test at all, so `STAGING_MAX_AGE_MS` and the `.tmp-`
    // suffix were both unguarded: the sweep could have stopped collecting staging directories
    // entirely and this suite would not have noticed. Keyed off `stagingNames` for the same reason
    // as the backups above.
    //
    // Staging is judged by age where a backup is judged by its pair, and that asymmetry is the point
    // of the two cases here: a staging directory is made in place rather than moved, so its mtime is
    // its own, while `rename` leaves a backup carrying the age of the content it holds.
    it(
      "collects a staging directory only once it is older than the age that marks it abandoned",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const fresh = FSUtil.stagingNames(path.join(tmp, "downloading")).staging
        const abandoned = FSUtil.stagingNames(path.join(tmp, "gaveup")).staging
        yield* Effect.promise(async () => {
          await mkdir(fresh)
          await mkdir(abandoned)
          // Two hours back, well past the hour that marks a download as given up on. Set rather
          // than waited for, and on the directory itself because that is what the sweep stats.
          const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
          await utimes(abandoned, old, old)
        })
        yield* FSUtil.sweepStale(fs, tmp)
        // No pairing is involved: neither `downloading` nor `gaveup` exists, and a staging
        // directory is collectable without one.
        expect(yield* fs.isDir(fresh)).toBe(true)
        expect(yield* fs.existsSafe(abandoned)).toBe(false)
      }),
    )
  })

  // The swap's two renames were covered through both runtimes' discovery suites and its refusal to
  // promote an incomplete download by nothing at all, which is the half that loses content: a
  // promotion deletes the backup, so the cached copy is gone the moment a partial one takes its
  // place. The two sweeps above are how a staging directory becomes partial without anybody
  // failing a download — a refresh stalled past `STAGING_MAX_AGE_MS` looks abandoned from any
  // process sharing the cache, and `writeWithDirs` makes the directory again for whichever files
  // were still to come (#39).
  describe("swapStaged", () => {
    const skill = (dir: string, text: string) =>
      Effect.promise(async () => {
        await mkdir(path.join(dir, "references"), { recursive: true })
        await writeFile(path.join(dir, "SKILL.md"), text)
        await writeFile(path.join(dir, "references", "guide.md"), `${text} guide`)
      })

    const required = ["SKILL.md", "references/guide.md"]

    it(
      "refuses a download that is missing a file, and leaves the cached copy whole",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const root = path.join(tmp, "deploy")
        const { staging, backup } = FSUtil.stagingNames(root)
        yield* skill(root, "# cached")
        // What is left of a download whose staging directory was collected and then made again by
        // the write of the one file that had not landed yet.
        yield* Effect.promise(async () => {
          await mkdir(staging, { recursive: true })
          await writeFile(path.join(staging, "SKILL.md"), "# fresh")
        })

        // Not `Effect.flip`: with the guard gone the swap succeeds, and flipping a success dies
        // with `Unknown error: undefined` instead of saying that a partial download was promoted.
        const error = yield* FSUtil.swapStaged(fs, root, staging, backup, required).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
        )

        expect(error?.reason._tag).toBe("NotFound")
        // The names, not just a count: a refusal that cannot say which file is missing is the kind
        // of silence that kept this invisible.
        expect(error?.reason.description).toContain("references/guide.md")
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toBe("# cached")
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "references", "guide.md")).text())).toBe(
          "# cached guide",
        )
        // Nothing was moved aside, so there is no backup to recover from either.
        expect(yield* fs.existsSafe(backup)).toBe(false)
      }),
    )

    it(
      "promotes a complete download and deletes the copy it moved aside",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const root = path.join(tmp, "deploy")
        const { staging, backup } = FSUtil.stagingNames(root)
        yield* skill(root, "# cached")
        yield* skill(staging, "# fresh")

        yield* FSUtil.swapStaged(fs, root, staging, backup, required)

        expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toBe("# fresh")
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "references", "guide.md")).text())).toBe(
          "# fresh guide",
        )
        expect(yield* fs.existsSafe(backup)).toBe(false)
        expect(yield* fs.existsSafe(staging)).toBe(false)
      }),
    )

    it(
      "promotes a download with no cached copy to replace",
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        const root = path.join(tmp, "deploy")
        const { staging, backup } = FSUtil.stagingNames(root)
        yield* skill(staging, "# first")

        yield* FSUtil.swapStaged(fs, root, staging, backup, required)

        expect(yield* Effect.promise(() => Bun.file(path.join(root, "SKILL.md")).text())).toBe("# first")
        expect(yield* fs.existsSafe(backup)).toBe(false)
      }),
    )
  })
})
