import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { scrubHermesFingerprints } from "../scrub"

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", name), "utf-8")

const FIXTURES = {
  // Pre-v2026.6.19: the memory/skills paragraph sits directly under
  // "# Finishing the job".
  "v1 layout": fixture("hermes-system.txt"),
  // v2026.6.19+: a "# Parallel tool calls" heading sits between
  // "# Finishing the job" and the memory/skills paragraph (issue #1).
  "v2026.6.19 layout": fixture("hermes-system-v2026.6.19.txt"),
  // A captured spawned-subagent / delegated-child prompt (sanitized: dummy
  // skills catalog, placeholder paths and task text). NO "persistent memory"
  // anchor, and the session/skills guidance is re-homed under "# Parallel tool
  // calls" — the layout that 400'd every subagent under block deletion alone.
  "subagent layout": fixture("hermes-system-subagent.txt"),
} as const

const HERMES_SUBAGENT = FIXTURES["subagent layout"]

/** Kept in sync with HERMES_TOOL_IDENTIFIERS in ../scrub.ts. */
const IDENTIFIERS = ["session_search", "skill_manage", "skill_view", "skills_list"]

// ---------------------------------------------------------------------------
// Pass 2 — tool-identifier neutralization (covers every layout, incl. subagent)
// ---------------------------------------------------------------------------

describe("scrubHermesFingerprints — tool-identifier neutralization", () => {
  for (const [label, src] of Object.entries(FIXTURES)) {
    test(`${label}: no bare Hermes tool identifier survives`, () => {
      const out = scrubHermesFingerprints(src)
      for (const id of IDENTIFIERS) {
        expect(out).not.toMatch(new RegExp(`\\b${id}\\b`))
      }
      // At least one identifier must actually have been present, or this
      // fixture proves nothing and has drifted away from a real Hermes prompt.
      const present = IDENTIFIERS.filter((id) =>
        new RegExp(`\\b${id}\\b`).test(src),
      )
      expect(present.length).toBeGreaterThan(0)
    })
  }

  test("subagent layout: guidance the block regexes cannot reach is de-fingerprinted", () => {
    // The subagent prompt has no persistent-memory anchor and re-homes the
    // session/skills guidance under "# Parallel tool calls", so pass 1 cannot
    // reach it — this is exactly the guidance that survived block deletion and
    // 400'd every spawned child. Pass 2 is the only thing that fires here.
    expect(HERMES_SUBAGENT).not.toContain("You have persistent memory across sessions")
    const out = scrubHermesFingerprints(HERMES_SUBAGENT)
    expect(out).not.toMatch(/\bsession_search\b/)
    expect(out).not.toMatch(/\bskill_manage\b/)
    // The prose itself survives, just re-spelled.
    expect(out).toContain("references something from a past conversation")
    expect(out).toContain("session search")
  })

  test("neutralization is length-preserving (underscore -> space)", () => {
    // Isolated from pass 1: no block anchors in this string, so only pass 2 runs.
    const s = "Recall with session_search, then save it with skill_manage."
    const out = scrubHermesFingerprints(s)
    expect(out.length).toBe(s.length)
    expect(out).toBe("Recall with session search, then save it with skill manage.")
  })

  test("word-boundary anchored — does not corrupt a larger identifier", () => {
    const s = "call my_session_searcher(x) and note session_search below"
    const out = scrubHermesFingerprints(s)
    expect(out).toContain("my_session_searcher(x)") // untouched substring
    expect(out).toContain("session search") // the standalone token neutralized
  })
})

// ---------------------------------------------------------------------------
// Pass 1 — harness-block removal (the original, production-proven mitigation)
// ---------------------------------------------------------------------------

describe("scrubHermesFingerprints — harness-block removal", () => {
  for (const label of ["v1 layout", "v2026.6.19 layout"] as const) {
    const src = FIXTURES[label]

    test(`${label}: removes the 'Finishing the job' block`, () => {
      const out = scrubHermesFingerprints(src)
      expect(out).not.toContain("# Finishing the job")
      expect(out).not.toContain("NEVER substitute plausible-looking fabricated output")
    })

    test(`${label}: removes the memory/skills paragraph`, () => {
      const out = scrubHermesFingerprints(src)
      expect(out).not.toContain("You have persistent memory across sessions")
      expect(out).not.toContain("patch it immediately with skill")
    })

    test(`${label}: preserves persona, steering and the skills catalog`, () => {
      const out = scrubHermesFingerprints(src)
      expect(out).toContain("You run on Hermes Agent (by Nous Research)")
      expect(out).toContain("## Mid-turn user steering")
      expect(out).toContain("<available_skills>")
    })

    test(`${label}: leaves no triple-newline gap where the block was`, () => {
      expect(scrubHermesFingerprints(src)).not.toContain("\n\n\n")
    })
  }
})

// ---------------------------------------------------------------------------
// Cross-cutting guarantees
// ---------------------------------------------------------------------------

describe("scrubHermesFingerprints — guarantees", () => {
  for (const [label, src] of Object.entries(FIXTURES)) {
    test(`${label}: idempotent — scrubbing twice equals scrubbing once`, () => {
      const once = scrubHermesFingerprints(src)
      expect(scrubHermesFingerprints(once)).toBe(once)
    })
  }

  test("no-op on a prompt with no Hermes fingerprint", () => {
    const plain =
      "You are Claude Code, Anthropic's CLI.\n\n# Tone\nBe concise and direct."
    expect(scrubHermesFingerprints(plain)).toBe(plain)
  })

  test("EXACT no-op — whitespace is not normalized on a non-Hermes prompt", () => {
    // Regression guard: the whitespace cleanup exists to repair the gap a block
    // removal leaves. Ungated, it silently rewrote every other client's system
    // prompt (collapsing blank-line runs, trimming the trailing newline) while
    // the plugin advertised itself as content-scoped and exactly no-op.
    const other = "You are Claude Code.\n\n\n\n# Tone\nBe concise.   \n\n"
    expect(scrubHermesFingerprints(other)).toBe(other)
  })

  test("no-op on empty / falsy input", () => {
    expect(scrubHermesFingerprints("")).toBe("")
  })

  test("stateless across calls — the module-level /g regex leaks no lastIndex", () => {
    // A global regex reused across calls carries lastIndex. String.replace
    // resets it, but pin that: interleave inputs and require every call to
    // match what it produces in isolation.
    const a = "use session_search then skill_manage then skill_view"
    const b = "only one: session_search"
    const aAlone = scrubHermesFingerprints(a)
    const bAlone = scrubHermesFingerprints(b)
    for (let i = 0; i < 3; i++) {
      expect(scrubHermesFingerprints(a)).toBe(aAlone)
      expect(scrubHermesFingerprints(b)).toBe(bAlone)
    }
    expect(aAlone).toBe("use session search then skill manage then skill view")
  })
})
