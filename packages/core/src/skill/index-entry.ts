export * as SkillIndexEntry from "./index-entry"

import path from "path"

// A skills index is a document fetched over the network, and both runtimes turn its `name` and
// `files` into paths under a cache directory and into URLs under the source. `path.join` resolves a
// `..` without complaint and the download creates whatever directories it needs on the way, so these
// are what stands between an index and writing where it likes.
//
// Shared rather than copied because the two runtimes have already drifted apart three times (#39),
// and V1 having been written without them is #38.

export function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

// Every segment is checked decoded as well as raw: `%2e%2e` is `..` by the time the server resolves
// the URL, so a path that looks contained can still fetch from outside the skill's own directory.
export function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !URL.canParse(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    segments.every((segment) => {
      try {
        const decoded = decodeURIComponent(segment)
        return (
          decoded.length > 0 &&
          decoded !== "." &&
          decoded !== ".." &&
          !decoded.includes("/") &&
          !decoded.includes("\\") &&
          !decoded.includes("\0")
        )
      } catch {
        return false
      }
    })
  )
}
