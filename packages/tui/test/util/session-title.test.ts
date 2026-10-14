import { expect, test } from "bun:test"
import { parseSessionTitle } from "../../src/util/session-title"

test("files a title under the group before its first bar", () => {
  expect(parseSessionTitle("work | fix the build")).toEqual({ group: "Work", displayTitle: "fix the build" })
  expect(parseSessionTitle("ops|rotate keys | again")).toEqual({ group: "Ops", displayTitle: "rotate keys | again" })
})

test("a title without both sides of a bar has no group", () => {
  expect(parseSessionTitle("plain title")).toEqual({ displayTitle: "plain title" })
  expect(parseSessionTitle(" | orphan")).toEqual({ displayTitle: " | orphan" })
  expect(parseSessionTitle("dangling |")).toEqual({ displayTitle: "dangling |" })
})
