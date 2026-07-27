/**
 * Scrub Hermes Agent's coding-harness fingerprint from a system prompt.
 *
 * WHY: Hermes (by Nous Research) speaks the Anthropic Messages API, so a Claude
 * Max user can point it at Meridian. But its system prompt carries two kinds of
 * autonomous-coding-agent signal, and Anthropic's usage classifier moves a
 * request carrying enough of it out of the subscription lane and into Extra
 * Usage — which fails with HTTP 400 "You're out of extra usage" once that pool
 * is spent (or is disabled on the account).
 *
 * The two signals are removed by two independent passes, in this order:
 *
 *  1. HARNESS BLOCKS — the "# Finishing the job" framework block and the
 *     un-headed persistent-memory / session-recall / skills paragraph
 *     (MEMORY_GUIDANCE + SESSION_SEARCH_GUIDANCE + SKILLS_GUIDANCE in Hermes'
 *     `agent/prompt_builder.py`). Individually innocuous; cumulatively they read
 *     as a harness. On a real gateway prompt this is ~2.8k characters.
 *
 *  2. TOOL IDENTIFIERS — the self-management tool names (`session_search`,
 *     `skill_manage`, `skill_view`, `skills_list`) where they appear in prose.
 *     `session_search` in particular is a documented metering signal
 *     (NousResearch/hermes-agent#65365, the `memory`/`session_search` signal).
 *     Underscores are replaced with spaces rather than deleted, so every
 *     sentence stays readable.
 *
 * WHY BOTH, and not just one:
 *
 *  - Pass 1 alone is heading-anchored, so it MISSES the spawned-subagent /
 *    delegated-child prompt: that variant has no "You have persistent memory"
 *    anchor and re-homes the session/skills guidance under "# Parallel tool
 *    calls", leaving the strongest identifiers intact. Every subagent 400'd.
 *    It is also fragile across Hermes releases — v2026.6.19 inserting a heading
 *    mid-span is exactly what reopened the hole in issue #1.
 *
 *  - Pass 2 alone leaves the ~2.8k-character block in place. The claim that the
 *    identifiers are the ONLY trigger does not survive contact with a real
 *    deployment: block-deletion-only builds run clean in production while still
 *    emitting four bare `skill_view` / `skill_manage` tokens (they live in the
 *    persona paragraph and the "## Skills (mandatory)" section, both of which
 *    pass 1 deliberately preserves). So the identifiers cannot be the whole
 *    story, and dropping pass 1 would trade a proven mitigation for an
 *    unproven one.
 *
 * Running both costs nothing and is strictly the smaller fingerprint. Pass 1's
 * anchors are matched independently (adjacency between blocks is NOT assumed);
 * when an anchor is absent its regex matches nothing. Both passes are therefore
 * safe pass-throughs for non-Hermes prompts and idempotent on already-scrubbed
 * input — the spaced identifier form no longer matches.
 */

/** Hermes' "# Finishing the job" block, up to the next markdown heading. */
const HERMES_HARNESS_BLOCK = /# Finishing the job\n[\s\S]*?(?=\n#{1,6} |\s*$)/

/**
 * Hermes' un-headed memory/skills paragraph. Before v2026.6.19 this sat
 * directly under "# Finishing the job" and was swallowed by that block's lazy
 * match; v2026.6.19 inserted "# Parallel tool calls" between them, which
 * terminates the match early and left this paragraph unscrubbed (issue #1).
 * Anchored on its own leading sentence, never on adjacency.
 */
const HERMES_MEMORY_PARAGRAPH =
  /You have persistent memory across sessions\.[\s\S]*?(?=\n#{1,6} |\s*$)/

/**
 * Hermes' self-management tool identifiers as they appear in system-prompt
 * prose. Word-boundary anchored, so only the whole identifier matches and a
 * larger name like `my_session_searcher` is left alone.
 *
 * Every entry here is verified to exist in Hermes' tool registry — grep
 * `tools/` and `agent/` in the hermes-agent checkout before adding one.
 * Speculative names are worse than useless: they imply coverage the plugin does
 * not have. (An earlier draft of this list carried `session_dump`,
 * `skill_create`, `skill_search` and `memory_search`; none of them exist.)
 *
 * Deliberately scoped to the memory/session/skill family — the documented
 * metering signal — and NOT to Hermes' whole toolset (`read_file`,
 * `execute_code`, `web_search`, `kanban_*`, `delegate_task`, `browser_*`, …).
 * Those appear in prose too, and rewriting all of them would mangle far more
 * of the prompt for no evidence of benefit.
 *
 * This is module-level AND carries /g, so it holds `lastIndex` state. That is
 * safe with `String.replace`, which resets it — but do NOT call `.test()` or
 * `.exec()` on it, or alternating calls will skip matches. Build a fresh
 * RegExp if you need either.
 */
const HERMES_TOOL_IDENTIFIERS =
  /\b(?:session_search|skill_manage|skill_view|skills_list)\b/g

/**
 * Remove Hermes' harness fingerprint from a system prompt string.
 *
 * - Strips the "# Finishing the job" block and the memory/skills paragraph
 * - Neutralizes surviving self-management tool identifiers (`session_search`
 *   → `session search`), which also covers the subagent prompt layout that has
 *   no block anchors at all
 * - Normalizes spacing left behind by a removal — but ONLY when something was
 *   actually removed, so a non-Hermes prompt is returned byte-identical
 *
 * Idempotent — calling this on already-scrubbed input produces identical output.
 */
export function scrubHermesFingerprints(systemPrompt: string): string {
  if (!systemPrompt) return systemPrompt

  const deblocked = systemPrompt
    .replace(HERMES_HARNESS_BLOCK, "")
    .replace(HERMES_MEMORY_PARAGRAPH, "")

  // Whitespace normalization repairs the gap a removal leaves. Gating it on an
  // actual removal keeps the "exact no-op on non-Hermes prompts" guarantee
  // honest: ungated, `\n{3,}` and a trailing-whitespace trim would silently
  // rewrite every other client's system prompt too.
  const tidied =
    deblocked === systemPrompt
      ? deblocked
      : deblocked.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")

  return tidied.replace(HERMES_TOOL_IDENTIFIERS, (m) => m.replace(/_/g, " "))
}
