import { NodeFileSystem } from "@effect/platform-node"
import { dirname, isAbsolute, join, relative, resolve as pathResolve, sep } from "path"
import { realpathSync } from "fs"
import * as NFS from "fs/promises"
import { lookup } from "mime-types"
import { Context, Effect, FileSystem, Layer, Option, Schedule, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./util/glob"
import { serviceUse } from "./effect/service-use"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"

export namespace FSUtil {
  export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
      return `Filesystem operation failed: ${this.method}${detail ? `: ${detail}` : ""}`
    }
  }

  export type Error = PlatformError | FileSystemError

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readFileStringSafe: (path: string) => Effect.Effect<string | undefined, Error>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    readonly resolve: (path: string) => Effect.Effect<string>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[], Error>
    readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly glob: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

  export const use = serviceUse(Service)

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const readFileStringSafe = Effect.fn("FileSystem.readFileStringSafe")(function* (path: string) {
        return yield* fs.readFileString(path).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(undefined)),
        )
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await NFS.readdir(dirPath, { withFileTypes: true })
            return entries.map(
              (e): DirEntry => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
              }),
            )
          },
          catch: (cause) => new FileSystemError({ method: "readDirectoryEntries", cause }),
        })
      })

      const resolve = Effect.fn("FileSystem.resolve")(function* (path: string) {
        const resolved = pathResolve(windowsPath(path))
        return yield* fs.realPath(resolved).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(resolved)),
          Effect.orDie,
        )
      })

      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => new FileSystemError({ method: "readJson", cause }),
        })
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = JSON.stringify(data, null, 2)
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true }).pipe(
          // Bun on Windows can throw EEXIST here despite recursive mode.
          // https://github.com/oven-sh/bun/issues/21901
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            (error) => isDir(path).pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
          ),
        )
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })

      const glob = Effect.fn("FileSystem.glob")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: () => Glob.scan(pattern, options),
          catch: (cause) => new FileSystemError({ method: "glob", cause }),
        })
      })

      const findUp = Effect.fn("FileSystem.findUp")(function* (target: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const search = join(current, target)
          if (yield* fs.exists(search)) result.push(search)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
        const result: string[] = []
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            if (yield* fs.exists(search)) result.push(search)
          }
          if (options.stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const globUp = Effect.fn("FileSystem.globUp")(function* (pattern: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const matches = yield* glob(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.catch(() => Effect.succeed([] as string[])),
          )
          result.push(...matches)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        readFileStringSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        resolve,
        readJson,
        writeJson,
        ensureDir,
        writeWithDirs,
        findUp,
        up,
        globUp,
        glob,
        globMatch: Glob.match,
      })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [filesystem] })

  // Windows refuses to rename a directory while anything still holds a handle inside it, and the
  // refusal passes: whatever was reading in there, or the scanner that followed it in, lets go in a
  // moment. Retrying it is the difference between a temp-then-rename swap landing and being thrown
  // away, and it is bounded because a refusal that will not pass has to fail rather than spin.
  const HELD_BASE_DELAY_MS = 25
  const HELD_MAX_DELAY_MS = 250
  const HELD_TIMEOUT_MS = 3_000

  const heldSchedule = Schedule.exponential(HELD_BASE_DELAY_MS, 1.7).pipe(
    Schedule.either(Schedule.spaced(HELD_MAX_DELAY_MS)),
    Schedule.jittered,
    Schedule.while((meta) => meta.elapsed < HELD_TIMEOUT_MS),
  )

  // EPERM is how the refusal arrives and it has no reason of its own: `handleErrnoException` in
  // @effect/platform-node-shared gives EACCES `PermissionDenied` and EBUSY `Busy` and leaves
  // everything else `Unknown`, so the cause's code is what separates a directory that is held from
  // a path that will never be writable. Read off a real one rather than assumed: provoked through
  // `rename` against a directory whose parent was immutable, a kernel EPERM arrives as
  // `reason._tag: "Unknown"` carrying `reason.cause.code: "EPERM"`.
  const held = (error: PlatformError) =>
    error.reason._tag === "Busy" ||
    error.reason._tag === "PermissionDenied" ||
    (error.reason._tag === "Unknown" &&
      typeof error.reason.cause === "object" &&
      error.reason.cause !== null &&
      "code" in error.reason.cause &&
      error.reason.cause.code === "EPERM")

  export const retryWhileHeld = <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
    effect.pipe(Effect.retry({ while: held, schedule: heldSchedule }))

  // A swap that cannot delete what it moved aside leaves `<name>.old-<uuid>` behind, and a refresh
  // that dies mid-download leaves `<name>.tmp-<uuid>`. Both of those deletes are ignored where they
  // happen, for reasons that hold — failing the swap for a refused delete would retry one that has
  // already landed — but nothing then collected them, so every refusal left a full copy of a cached
  // directory on disk for good.
  //
  // Neither kind is recognised by its age, because age does not say what it looks like it says:
  // `rename` leaves the mtime of what it moves alone, so a backup carries the age of the content it
  // holds rather than the moment it was set aside, and anything cached an hour ago would be
  // collectable the instant a refresh moved it. What marks a backup as garbage is `<name>` being
  // back in place. Between the swap's two renames, and after a rollback that was refused in turn,
  // the backup is the only copy of the directory on disk, and it is exactly then that `<name>` is
  // missing — so that case keeps it. Staging directories have no such pairing, but they are made
  // here rather than moved, so their mtime is their own and an hour is far longer than a download.
  const LEFTOVER = /^(.+)\.(old|tmp)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const STAGING_MAX_AGE_MS = 60 * 60 * 1000

  export const sweepStale = (fs: Interface, directory: string) =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => [] as DirEntry[]))
      // Directories on both sides, because the rule is about a swap and a swap only ever moves
      // directories. A plain file at `<name>` is not the cached directory being back in place, and
      // taking it for one deletes a backup that is still the only copy: measured, a file named
      // `deploy` beside `deploy.old-<uuid>` left nothing but the file. Reachable rather than
      // theoretical while V1 discovery writes whatever path a remote index names (#38).
      const directories = new Set(entries.filter((entry) => entry.type === "directory").map((entry) => entry.name))
      const collectable = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          if (entry.type !== "directory") return undefined
          const leftover = LEFTOVER.exec(entry.name)
          if (!leftover) return undefined
          const target = join(directory, entry.name)
          if (leftover[2] === "old") return directories.has(leftover[1]) ? target : undefined
          const stat = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!stat) return undefined
          return Date.now() - Option.getOrElse(stat.mtime, () => new Date()).getTime() > STAGING_MAX_AGE_MS
            ? target
            : undefined
        }),
      )
      const stale = collectable.filter((target): target is string => target !== undefined)
      if (stale.length === 0) return
      yield* Effect.logInfo("sweeping abandoned directories", { directory, count: stale.length })
      // Ignored in turn: the next pass comes round again.
      yield* Effect.forEach(
        stale,
        (target) => fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore),
        {
          discard: true,
        },
      )
    })

  // Pure helpers that don't need Effect (path manipulation, sync operations)
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    const resolved = pathResolve(windowsPath(p))
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }

  export function normalizePathPattern(p: string): string {
    if (process.platform !== "win32") return p
    if (p === "*") return p
    const match = p.match(/^(.*)[\\/]\*$/)
    if (!match) return normalizePath(p)
    const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
    return join(normalizePath(dir), "*")
  }

  export function resolve(p: string): string {
    const resolved = pathResolve(windowsPath(p))
    try {
      return normalizePath(realpathSync(resolved))
    } catch (e: any) {
      if (e?.code === "ENOENT") return normalizePath(resolved)
      throw e
    }
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  export function overlaps(a: string, b: string) {
    return contains(a, b) || contains(b, a)
  }

  export function contains(parent: string, child: string) {
    const result = relative(parent, child)
    return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
  }
}
