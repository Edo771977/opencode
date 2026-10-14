export * as SessionBudget from "./budget.js"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Agent } from "../../agent.js"
import type { Database } from "../../database/database.js"
import type { SessionSchema } from "../schema.js"
import { SessionMessageTable, SessionTable } from "../sql.js"

/** Marks the one notice an agent gets when its steps move to the small model. */
export const NOTICE_SOURCE = "budget"

export const NOTICE = `Your spending budget for this session has been reached. The rest of your work runs on a smaller, cheaper model. Keep going with the task: finish what you can, and say plainly what is left if something needs the larger model.`

export const STOP_PROMPT = `CRITICAL - SPENDING LIMIT REACHED

The spending limit for this request has been reached. Tools are disabled until the next message. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that the spending limit for this request has been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`

export const declinedPrompt = (reason: string | undefined) =>
  [
    STOP_PROMPT.replace(
      "The spending limit for this request has been reached.",
      "The spending budget has been reached and continuing past it was declined.",
    ),
    ...(reason ? [`The reason given for declining: ${reason}`] : []),
  ].join("\n\n")

export interface Spend {
  /** Everything this agent has spent in the Session. */
  readonly session: number
  /** What it has spent since the person's latest message, the request in hand. */
  readonly request: number
  /** Identifies the request in hand: the sequence of the person's latest message. */
  readonly request_seq: number
  readonly notified: boolean
}

/**
 * A request ends where the person's next message begins, and only there. Runtime-written input —
 * a background result, a continuation after an interrupted stream, this module's own notice — is a
 * synthetic message, so it never opens a request of its own and never hands a run a fresh ceiling.
 * Steps a fork copied from its source were paid for there.
 */
export const spend = (db: Database.Interface["db"], sessionID: SessionSchema.ID, agent: Agent.ID) =>
  db
    .get<{ session: number | null; request: number | null; request_seq: number | null; notified: number | null }>(
      sql`
        WITH latest AS (
          SELECT COALESCE(MAX(seq), -1) AS seq
          FROM ${SessionMessageTable}
          WHERE session_id = ${sessionID} AND type = 'user'
        )
        SELECT
          COALESCE(SUM(CASE WHEN message.type = 'assistant' THEN json_extract(message.data, '$.cost') END), 0) AS session,
          COALESCE(
            SUM(CASE WHEN message.type = 'assistant' AND message.seq > latest.seq THEN json_extract(message.data, '$.cost') END),
            0
          ) AS request,
          latest.seq AS request_seq,
          MAX(CASE WHEN message.type = 'synthetic' THEN 1 ELSE 0 END) AS notified
        FROM latest
        LEFT JOIN ${SessionMessageTable} AS message
          ON message.session_id = ${sessionID}
          AND (
            (message.type = 'assistant' AND json_extract(message.data, '$.agent') = ${agent})
            OR (
              message.type = 'synthetic'
              AND json_extract(message.data, '$.metadata.source') = ${NOTICE_SOURCE}
              AND json_extract(message.data, '$.metadata.agent') = ${agent}
            )
          )
        LEFT JOIN ${SessionTable} AS session ON session.id = message.session_id
        WHERE message.id IS NULL OR session.fork_session_id IS NULL OR message.time_created >= session.time_created
        GROUP BY latest.seq
      `,
    )
    .pipe(
      Effect.orDie,
      Effect.map(
        (row): Spend => ({
          session: row?.session ?? 0,
          request: row?.request ?? 0,
          request_seq: row?.request_seq ?? -1,
          notified: (row?.notified ?? 0) > 0,
        }),
      ),
    )
