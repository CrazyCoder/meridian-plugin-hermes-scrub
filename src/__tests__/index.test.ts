import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "../index"
import type { RequestContext } from "../types"

const HERMES_SYSTEM = readFileSync(
  join(import.meta.dir, "fixtures", "hermes-system.txt"),
  "utf-8",
)

function ctx(systemContext?: string): RequestContext {
  return { adapter: "pi", systemContext, metadata: {} }
}

describe("hermes-scrub plugin", () => {
  test("declares the expected plugin metadata", () => {
    expect(plugin.name).toBe("hermes-scrub")
    expect(typeof plugin.version).toBe("string")
    // Content-scoped, not adapter-scoped — must run on every adapter
    // (Hermes traffic currently routes through the pi/default adapter).
    expect(plugin.adapters).toBeUndefined()
    expect(typeof plugin.onRequest).toBe("function")
  })

  test("onRequest removes the harness block and neutralizes surviving identifiers", () => {
    const result = plugin.onRequest!(ctx(HERMES_SYSTEM))
    // Pass 1 — the harness block (and the memory paragraph inside it) is gone.
    expect(result.systemContext).not.toContain("# Finishing the job")
    expect(result.systemContext).not.toContain("You have persistent memory across sessions")
    // Pass 2 — identifiers that pass 1 deliberately preserves (persona
    // paragraph, "## Skills (mandatory)") no longer leak in snake_case form.
    expect(result.systemContext).not.toMatch(/\bskill_view\b/)
    expect(result.systemContext).not.toMatch(/\bskill_manage\b/)
    expect(result.systemContext).toContain("skill view(name=")
    // The persona itself is untouched.
    expect(result.systemContext).toContain("You run on Hermes Agent (by Nous Research)")
  })

  test("onRequest returns the same context object when there is no systemContext", () => {
    const input = ctx(undefined)
    expect(plugin.onRequest!(input)).toBe(input)
  })

  test("onRequest returns the same context object when nothing is scrubbed", () => {
    const input = ctx("You are Claude Code.\n\n# Tone\nBe concise.")
    expect(plugin.onRequest!(input)).toBe(input)
  })
})
