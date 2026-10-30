---
name: context-diet
description: Slims the user's Claude Code startup context (unused MCP servers, unused skill plugins, oversized CLAUDE.md and memory files). Use when the Context Diet mod sends findings, or when the user asks to run a context diet, cut startup tokens, or slim their CLAUDE.md.
---

# Context Diet

The Context Diet mod has already measured everything locally and sent the findings as JSON in the user's message: `startupTokens`, `unusedMcpServers`, `unusedSkillPlugins`, `largeMemoryFiles`, `estimatedSaving`. Work from that JSON.

## Token rules (this skill exists to save tokens, so it must be cheap)

- Do not re-measure, run `/context`, list directories or read files to "double check" the findings.
- Never read a CLAUDE.md or memory file in this conversation. Slimming is done by a subagent (step 4).
- Keep every reply short: one table, one question at a time, no essays.
- If the message has no findings JSON, tell the user to type `/diet` (the mod measures for free) and stop.

## 1. First run: ask three things, once

Check `~/.claude/context-diet/profile.json`. If it exists, use it and skip this step.
Otherwise ask with a single AskUserQuestion call (three questions):
1. How strict? `Light` (only remove what's been unused a long time) / `Balanced` / `Strict` (cut anything unused)
2. Where? `This project only` / `Everywhere`
3. May I slim large CLAUDE.md and memory files (with a backup, after showing you the result)? `Yes` / `No`

Write the answers to `~/.claude/context-diet/profile.json` as `{ "strictness", "scope", "slimMemory", "createdAt" }`.

## 2. Show the menu

One AskUserQuestion call with `multiSelect: true`. One option per finding, biggest first, at most 4 options (merge the small ones into one "Other small items" option). Label each with its saving, for example `context7 MCP server (−9k)`, `data plugin, 10 skills (−4k)`, `Slim CLAUDE.md (−3k est.)`.
Light strictness: pre-select nothing and only offer items whose `lastUsed` is null. Strict: offer everything.
Skip memory items when `slimMemory` is false.

## 3. Apply what the user picked

Before every change, say in one line exactly what you'll run or edit. Prefer disabling over removing; never delete a server's or plugin's configuration.

- **MCP server:** find how it is configured with `claude mcp get <name>` (one call). Then:
  - from a plugin → disable that plugin (`claude plugin disable <plugin>`),
  - scope "This project only" → add the server to `disabledMcpjsonServers` in `.claude/settings.local.json` if it is a project `.mcp.json` server; for a user-scope server, tell the user to toggle it off in `/mcp` for this project (you cannot do it for them),
  - scope "Everywhere" → `claude mcp remove <name> -s <scope>` only after showing the exact command and getting a yes, and print the `claude mcp add ...` line that would restore it.
- **Skill plugin:** `claude plugin disable <name>` (check the exact id with `claude plugin list` first, one call).
- **Large CLAUDE.md / memory file:** go to step 4.

## 4. Slim memory files with a subagent

For each picked memory file, start one Agent (general-purpose) with this task, filling in the path:

> Slim the file at `<path>` so it costs fewer tokens on every request, without losing any rule. Read it fully. Remove duplicated or vague lines, merge overlapping rules, shorten wording. Move long reference sections the model rarely needs (setup guides, long examples, command catalogs) into separate files next to it under `docs/`, and leave a one-line pointer in their place. Do not change meaning. First copy the original to `<path>.bak`. Write the slimmed file. Reply with only: old and new size in characters, and a bullet list of at most 8 changes.

Show the user the subagent's short summary. If they don't like it, restore from the `.bak`.

## 5. Wrap up

One short message:
- what changed, as a two-column table: item, saving,
- the expected new startup (`startupTokens − saving`),
- "Restart Claude Code to see the new startup and the savings counter in the gauge."

Then stop. Do not offer further optimizations in the same turn.
