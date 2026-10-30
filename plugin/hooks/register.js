// Context Diet — a Claude Code mod.
//
// 1. Gauge: a colored line above the prompt with your live limits and context,
//    straight from Claude Code ($.session.usage). No model calls, no tokens.
// 2. Usage log: remembers which MCP servers and skill plugins you actually use.
// 3. Finder: reads the same breakdown /context shows (counted locally) and adds up
//    the startup tokens spent on servers, skills and memory you don't use.
// 4. When it finds enough, a one-line band offers "1 diet / 2 later". Only "1"
//    involves Claude: it hands the findings to the context-diet skill.
// 5. Savings: after a diet, every request that starts lighter adds to the counter.
//
// Mods must spell every API call as $.namespace.method(...) at the call site, so the
// helpers below are pure and the hooks do the calling.

const DAY = 86_400_000
const LEARN_SESSIONS = 3 // sessions to watch before calling a server "unused"
const UNUSED_DAYS = 14
const MIN_SAVING = 3_000 // tokens; below this the band stays quiet
const BIG_MEMORY = 2_500 // a memory file over this is worth slimming
const SNOOZE_DAYS = 3
const MILESTONES = [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000]

// ---- state ----
let limits = [] // [{ kind, percentUsed, resetsAt }]
let ctx = { tokens: undefined, window: 0 }
let startup = null // tokens the window starts with this session, before any messages
let log = { servers: {}, plugins: {}, sessions: 0, since: 0 }
let baseline = null // startup tokens before the first diet
let saved = 0 // tokens saved since the first diet
let lastMilestone = 0
let snoozeUntil = 0
let findings = null // { total, servers, plugins, memory, learning }
let warned = { 80: false, 95: false }
let dirty = false
let dietThisSession = false
const NOISE = 500 // startup estimates wobble a little between sessions

const k = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)))

function untilText(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return 'resetting'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `resets in ${Math.round(h / 24)}d` : h > 0 ? `resets in ${h}h${String(m).padStart(2, '0')}` : `resets in ${m}m`
}

// The gauge as colored pieces: [text, style]. style: claude | success | warning | error | dim | plain
function gaugeParts() {
  const out = []
  const sep = () => out.push(['  ·  ', 'dim'])
  const five = limits.find((l) => l.kind === 'five_hour')
  const week = limits.find((l) => l.kind === 'seven_day')
  const level = (p) => (p >= 95 ? 'error' : p >= 80 ? 'warning' : 'claude')
  out.push(['5h ', 'dim'])
  if (five) {
    const n = Math.max(0, Math.min(10, Math.round(five.percentUsed / 10)))
    out.push(['█'.repeat(n), level(five.percentUsed)], ['░'.repeat(10 - n), 'dim'])
    out.push([` ${Math.round(five.percentUsed)}%`, five.percentUsed >= 80 ? level(five.percentUsed) : 'plain'], [` ${untilText(five.resetsAt)}`, 'dim'])
  } else out.push(['░░░░░░░░░░', 'dim'], [' waiting for the first reply', 'dim'])
  if (week) { sep(); out.push(['week ', 'dim'], [`${Math.round(week.percentUsed)}%`, week.percentUsed >= 80 ? level(week.percentUsed) : 'plain']) }
  if (ctx.window) { sep(); out.push(['ctx ', 'dim'], [`${ctx.tokens === undefined ? '–' : k(ctx.tokens)}`, 'plain'], [`/${k(ctx.window)}`, 'dim']) }
  if (startup !== null) { sep(); out.push(['startup ', 'dim'], [k(startup), 'plain']) }
  if (saved > 0) { sep(); out.push(['saved ', 'dim'], [k(saved), 'success']) }
  return out
}

const STYLE = {
  claude: { color: 'claude', bold: true },
  success: { color: 'success', bold: true },
  warning: { color: 'warning', bold: true },
  error: { color: 'error', bold: true },
  dim: { dimColor: true },
  plain: {},
}

// Takes a usage reading; returns a warning to toast, or null.
function takeUsage(u) {
  if (!u) return null
  if (Array.isArray(u.rateLimits) && u.rateLimits.length) {
    const byKind = new Map(limits.map((l) => [l.kind, l]))
    for (const l of u.rateLimits) byKind.set(l.kind, l)
    limits = [...byKind.values()]
  }
  if (u.context) ctx = { tokens: u.context.tokens, window: u.context.window || ctx.window }
  const five = limits.find((l) => l.kind === 'five_hour')
  if (!five) return null
  for (const level of [95, 80]) if (five.percentUsed < level - 10) warned[level] = false
  for (const level of [95, 80]) {
    if (five.percentUsed >= level && !warned[level]) {
      warned[95] = warned[95] || level === 95
      warned[80] = true
      return `5-hour limit at ${Math.round(five.percentUsed)}% · ${untilText(five.resetsAt)}`
    }
  }
  return null
}

// Startup = everything the window holds before the conversation itself.
function startupOf(b) {
  let sum = 0
  for (const c of b.categories || []) {
    if (c.kind !== 'used') continue
    if (/message/i.test(c.name)) continue
    sum += c.tokens || 0
  }
  return sum
}

const isUnused = (when, now) => !when || now - when > UNUSED_DAYS * DAY

function find(b, force) {
  const now = Date.now()
  const learning = log.sessions < LEARN_SESSIONS && !force
  const servers = new Map()
  for (const t of b.mcpTools || []) {
    if (!t.isLoaded) continue
    servers.set(t.serverName, (servers.get(t.serverName) || 0) + (t.tokens || 0))
  }
  const plugins = new Map()
  for (const s of (b.skills && b.skills.skillFrontmatter) || []) {
    if (!s.pluginName) continue
    const p = plugins.get(s.pluginName) || { tokens: 0, skills: 0 }
    p.tokens += s.tokens || 0
    p.skills += 1
    plugins.set(s.pluginName, p)
  }
  const out = { total: 0, servers: [], plugins: [], memory: [], learning }
  if (!learning) {
    for (const [name, tokens] of servers) {
      if (isUnused(log.servers[name], now)) out.servers.push({ name, tokens, lastUsed: log.servers[name] || null })
    }
    for (const [name, p] of plugins) {
      if (name === 'context-diet') continue
      if (isUnused(log.plugins[name], now)) out.plugins.push({ name, tokens: p.tokens, skills: p.skills, lastUsed: log.plugins[name] || null })
    }
  }
  for (const m of b.memoryFiles || []) {
    if ((m.tokens || 0) >= BIG_MEMORY) out.memory.push({ path: m.path, type: m.type, tokens: m.tokens, estimatedSaving: Math.round(m.tokens * 0.4) })
  }
  out.servers.sort((a, c) => c.tokens - a.tokens)
  out.plugins.sort((a, c) => c.tokens - a.tokens)
  out.total = out.servers.reduce((s, x) => s + x.tokens, 0) + out.plugins.reduce((s, x) => s + x.tokens, 0) + out.memory.reduce((s, x) => s + x.estimatedSaving, 0)
  return out
}

// Reads a usage answer that carries a breakdown. Returns true when this set the baseline.
function takeBreakdown(u, force) {
  const b = u && u.context && u.context.breakdown
  if (!b) return false
  startup = startupOf(b)
  findings = find(b, force)
  return false
}

function remember(kind, name) {
  if (!name) return
  log[kind][name] = Date.now()
  dirty = true
}

// Adds to the savings counter; returns a milestone message to toast, or null.
function addSaved(n) {
  if (!(n > 0)) return null
  saved += n
  dirty = true
  const hit = MILESTONES.filter((m) => saved >= m && m > lastMilestone).pop()
  if (!hit) return null
  lastMilestone = hit
  return `Context Diet: ${k(hit)} tokens saved so far 🎉`
}

function dietPrompt() {
  const f = findings
  const data = {
    startupTokens: startup,
    baselineTokens: baseline,
    unusedMcpServers: f.servers,
    unusedSkillPlugins: f.plugins,
    largeMemoryFiles: f.memory,
    estimatedSaving: f.total,
    unusedMeans: log.sessions < LEARN_SESSIONS ? `not used in the ${log.sessions} session(s) watched so far` : `not used in the last ${UNUSED_DAYS} days`,
  }
  return 'Use the context-diet skill. The Context Diet mod measured my startup context and found this:\n```json\n' + JSON.stringify(data) + '\n```'
}

const passThrough = async ($, e, next) => { if (!next.called) return next(e) }

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'diet', description: 'Context Diet: review what your startup context spends, and slim it' })
    const savedLog = await $.store.get('log')
    if (savedLog && savedLog.servers) log = savedLog
    if (!log.since) log.since = Date.now()
    log.sessions = (log.sessions || 0) + 1
    dirty = true
    const b = await $.store.get('dietBaseline')
    if (typeof b === 'number') baseline = b
    const s = await $.store.get('savings')
    if (s && typeof s.saved === 'number') { saved = s.saved; lastMilestone = s.lastMilestone || 0 }
    const z = await $.store.get('snoozeUntil')
    if (typeof z === 'number') snoozeUntil = z
    try { takeUsage(await $.session.usage()) } catch { /* not ready yet */ }
    $.ui.invalidate('ui.render')
    $.clock.every(30_000, async () => {
      $.ui.invalidate('ui.render')
      if (!dirty) return
      dirty = false
      await $.store.set('log', log)
      await $.store.set('savings', { saved, lastMilestone })
    })
    void (async () => {
      try {
        if (takeBreakdown(await $.session.usage({ breakdown: 'summary' }), false)) await $.store.set('baseline', baseline)
        $.ui.invalidate('ui.render')
      } catch { /* no breakdown before the first reply; turn.complete retries */ }
    })()
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const warning = takeUsage(e)
    if (warning) $.ui.toast(warning)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (findings === null) {
      try {
        if (takeBreakdown(await $.session.usage({ breakdown: 'summary' }), false)) await $.store.set('baseline', baseline)
        $.ui.invalidate('ui.render')
      } catch { /* try again next turn */ }
    }
    $.ui.invalidate('ui.render')
    if (dirty) {
      dirty = false
      await $.store.set('log', log)
      await $.store.set('savings', { saved, lastMilestone })
    }
    return next(e)
  })

  // Every request re-sends the startup context, so each one after a diet saves the difference.
  on('turn.step', async function* ($, e, next) {
    if (baseline !== null && startup !== null && baseline - startup > NOISE) {
      const milestone = addSaved(baseline - startup)
      if (milestone) $.ui.toast(milestone, { timeoutMs: 6000 })
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool || '')
    const mcp = /^mcp__(.+?)__/.exec(tool)
    if (mcp) remember('servers', mcp[1])
    if (tool === 'Skill' && typeof e.skill === 'string' && e.skill.includes(':')) remember('plugins', e.skill.split(':')[0])
    return next(e)
  }).catch(passThrough)

  on('skill.prompt', async ($, e, next) => {
    if (e.pluginName) remember('plugins', e.pluginName)
    return next(e)
  }).catch(passThrough)

  on('command.run', { command: 'diet' }, async ($) => {
    try {
      if (takeBreakdown(await $.session.usage({ breakdown: 'summary' }), true)) await $.store.set('baseline', baseline)
    } catch { /* handled below */ }
    if (!findings) return { text: 'Context Diet: no breakdown yet. Send one message, then try /diet again.' }
    if (findings.total < 1) return { text: `Context Diet: nothing to trim. Startup is ${k(startup)} tokens, and you use all of it.` }
    if (baseline === null) { baseline = startup; await $.store.set('dietBaseline', baseline) }
    dietThisSession = true
    $.ui.invalidate('ui.render')
    // A command can't start a turn while it runs, so hand the findings over just after it returns.
    const text = dietPrompt()
    $.clock.after(50, () => { void $.prompt.submit({ text, asUser: true }) })
    return { text: `Context Diet: startup is ${k(startup)}, ~${k(findings.total)} of it unused. Handing the details to Claude…` }
  })

  on('session.end', async ($, e, next) => {
    if (dirty) {
      dirty = false
      await $.store.set('log', log)
      await $.store.set('savings', { saved, lastMilestone })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    try {
      const { Box, Text, Button } = $.ui.resolve(e)
      const rows = theirs ? [theirs] : []
      const showBand = !dietThisSession && findings && !findings.learning && findings.total >= MIN_SAVING && Date.now() > snoozeUntil && !(e.props && e.props.isWorking)
      if (showBand) {
        const top = [...findings.servers, ...findings.plugins][0]
        const hint = top ? ` (${top.name} alone is ${k(top.tokens)})` : ''
        rows.push(Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ color: 'warning', children: [`Context Diet: startup is ${k(startup)}, ~${k(findings.total)} of it you don't use${hint}`] }),
            Button({
              key: 'diet', label: 'diet', hotkey: '1', plain: true,
              onPress: async () => {
                if (baseline === null) { baseline = startup; await $.store.set('dietBaseline', baseline) }
                dietThisSession = true
                $.ui.invalidate('ui.render')
                const text = dietPrompt()
                $.clock.after(50, () => { void $.prompt.submit({ text, asUser: true }) })
              },
            }),
            Button({
              key: 'later', label: 'later', hotkey: '2', plain: true, dimColor: true,
              onPress: async () => {
                snoozeUntil = Date.now() + SNOOZE_DAYS * DAY
                await $.store.set('snoozeUntil', snoozeUntil)
                $.ui.invalidate('ui.render')
              },
            }),
          ],
        }))
      }
      rows.push(Box({
        flexDirection: 'row',
        children: gaugeParts().map(([t, st]) => Text({ ...STYLE[st], children: [t] })),
      }))
      return rows.length === 1 ? rows[0] : Box({ flexDirection: 'column', children: rows })
    } catch {
      return theirs
    }
  })
}
