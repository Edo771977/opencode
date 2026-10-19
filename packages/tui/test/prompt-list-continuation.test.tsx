import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const location = { directory, project: { id: "project", directory, canonical: directory } }

// The prompt maps the textarea's cursor offset to a string index and back, and the offset counts a
// newline as one position, so a list item on a later line is where a wrong mapping shows.
test("a numbered list continues across lines in the prompt", async () => {
  // The draft stash is process-wide, so reruns use a fresh session for an empty composer.
  const sessionID = `ses_list_${crypto.randomUUID()}`
  await using setup = await createAppFixture({
    args: { sessionID },
    fetch: (url) => {
      if (url.pathname === `/api/session/${sessionID}`)
        return json({
          data: {
            id: sessionID,
            projectID: "project",
            title: "List fixture",
            agent: "build",
            model: { providerID: "demo", id: "model" },
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Demo Model"))
  await setup.mockInput.typeText("1. 漢字")
  setup.mockInput.pressEnter({ shift: true })
  await setup.mockInput.typeText("b")
  setup.mockInput.pressEnter({ shift: true })
  await setup.mockInput.typeText("c")
  await setup.waitForFrame((frame) => frame.includes("3. c"))
  // Back to the end of the second item: a newline there opens 3 and renumbers the item after it.
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter({ shift: true })
  await setup.mockInput.typeText("x")
  const frame = await setup.waitForFrame((frame) => frame.includes("4. c"))
  expect(frame).toContain("1. 漢字")
  expect(frame).toContain("2. b")
  expect(frame).toContain("3. x")
})
