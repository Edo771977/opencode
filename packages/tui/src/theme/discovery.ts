import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"

const extensions = new Set([".json", ".jsonc"])

export async function discoverThemes(directories: string[]) {
  const result: Record<string, unknown> = {}
  for (const directory of directories) {
    const themeDirectory = path.join(directory, "themes")
    const entries = await readdir(themeDirectory, { withFileTypes: true }).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
      return Promise.reject(error)
    })
    const files = entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && extensions.has(path.extname(entry.name)))
      .map((entry) => path.join(themeDirectory, entry.name))
      .sort()
    for (const file of files) {
      result[path.basename(file, path.extname(file))] = parseTheme(file, await readFile(file, "utf8"))
    }
  }
  return result
}

// JSONC, so a theme can carry comments and trailing commas. A theme that does not parse names the
// file and the place, rather than failing the whole discovery with a bare syntax error.
function parseTheme(file: string, content: string): unknown {
  const errors: ParseError[] = []
  const theme: unknown = parse(content, errors, { allowTrailingComma: true })
  const error = errors[0]
  if (error) {
    const before = content.slice(0, error.offset)
    const line = before.split("\n").length
    const column = before.length - before.lastIndexOf("\n")
    throw new Error(`Failed to parse theme ${file}:${line}:${column}: ${printParseErrorCode(error.error)}`)
  }
  if (theme === undefined) throw new Error(`Empty theme file: ${file}`)
  return theme
}
