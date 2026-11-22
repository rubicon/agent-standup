// Agent Standup's band for Claude Code (a mod: Claude Code's function hooks). In the session you are in, a line above the prompt says when another Claude Code session
// on this computer needs you (an approval, an answer), and a toast says when one needs you or has finished its turn. It reads only the status file each session keeps
// in <config dir>/sessions/<pid>.json (written by Claude Code 2.1.221 and later in the terminal, 2.1.269 elsewhere; mods run from 2.1.294) and asks `ps` whether a waiting session's process still runs. Nothing is sent anywhere.
// On the Claude desktop app, a row for a session of that app opens it, and Next waiting opens the first session the app has waiting for you.
// The whole call, with every session as a character: /agent-standup:open, from the agent-standup plugin (a separate install).
import type { EngineInterface, Register } from 'claude-code'

// What the band shows, kept in the module and not in $.state: $.state needs a "types" contract in plugin.json, which Claude Code before 2.1.29x refuses in a manifest.
// A reload of the module starts them over, and the next look (every 4 s) fills them again.
type Need = { id: string; where: string; what: string; host?: string }   // the session that waits; its folder, name and app; "an approval", "an answer"; the desktop app's id for it
let needs: readonly Need[] = []
let hidden: ReadonlySet<string> = new Set()   // the waits you put away with "Hide": the band stays away until another one comes; one that ends is forgotten, so the same session asking again shows
const keyOf = (n: Need): string => n.id + ':' + n.what
let expanded = false   // "and N more" pressed: every wait is listed, and the band scrolls (the engine's window) once they outgrow its rows; Fewer, or three or fewer waits, closes it

type Status = { pid?: unknown; sessionId?: unknown; status?: unknown; waitingFor?: unknown; cwd?: unknown; name?: unknown; nameSource?: unknown; entrypoint?: unknown; hostSessionId?: unknown }

// "web-shop · release (VS Code)": the folder, the name you gave the session (not the one Claude Code made up), the app it runs in
export const whereOf = (s: Status): string => {
  const cwd = typeof s.cwd === 'string' ? s.cwd : ''
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() || 'A session'
  const named = typeof s.name === 'string' && s.name && s.nameSource !== 'derived' ? ' · ' + s.name : ''
  const app = s.entrypoint === 'claude-vscode' ? ' (VS Code)' : s.entrypoint === 'claude-desktop' ? ' (desktop app)' : ''
  return folder + named + app
}
export const whatOf = (w: unknown): string => (w === 'permission prompt' ? 'an approval' : w === 'input needed' ? 'an answer' : 'you')
// waiting, and not on a dialog the person opened there themselves (/model, /config…): those say "dialog open"
const waits = (s: Status): boolean => s.status === 'waiting' && s.waitingFor !== 'dialog open'
// a session a program started with claude -p (entrypoint sdk-cli): its questions go to that program, and its turns are not yours. An Agent SDK host (sdk-ts, sdk-py: Zed, a home-made app)
// may show its menus to a person, so those are kept (as liveStatus in Agent Standup's server)
const byProgram = (s: Status): boolean => s.entrypoint === 'sdk-cli'

// The desktop app's id for one of its sessions (hostSessionId), checked against the form the app itself accepts in claude://code/continue?session=, since it goes to a command
const HOST_ID = /^local_[A-Za-z0-9-]{1,64}$/
export const hostOf = (s: Status): string | undefined => (s.entrypoint === 'claude-desktop' && typeof s.hostSessionId === 'string' && HOST_ID.test(s.hostSessionId) ? s.hostSessionId : undefined)
// How this computer hands a claude:// link to the desktop app, or undefined where the band does not know (Linux, a hosted server, a Claude Code too old to say)
type Opener = (url: string) => string[]
let opener: Opener | undefined
export const openerFor = (info: { platform?: unknown; isHosted?: unknown } | undefined): Opener | undefined =>
  !info || info.isHosted ? undefined : info.platform === 'macos' ? url => ['open', url] : info.platform === 'windows' ? url => ['cmd', '/c', 'start', '', url] : undefined

// The processes that still run, of those asked about. A session that crashed leaves its file behind, saying what it was doing then.
const alive = async ($: EngineInterface, pids: readonly number[]): Promise<Set<number>> => {
  if (!pids.length) return new Set()
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['ps', '-o', 'pid=', '-p', pids.join(',')], { timeoutMs: 5000 })
    // ps exits 1 with nothing on stderr when none of them runs. Any other failure is a ps that cannot answer (Git for Windows, BusyBox: no -o): every file is taken at its word
    if (exitCode !== 0 && (exitCode !== 1 || stderr.trim())) return new Set(pids)
    return new Set(stdout.split(/\s+/).filter(Boolean).map(Number))
  } catch {
    return new Set(pids)   // no ps (Windows): every file is taken at its word
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      opener = openerFor(await $.session.info())
    } catch {
      opener = undefined   // a Claude Code that cannot say where it runs: no row is clickable
    }
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '') + '/.claude'
    const dir = config.replace(/[\\/]+$/, '') + '/sessions'
    let before = new Map<string, string>()   // session id → what it was doing at the last look; nothing is announced at the first look
    let first = true
    let looks = 0, applied = 0   // looks overlap when ps is slow: one that ends after a newer one has been applied is dropped, so the band never goes back in time

    const look = async () => {
      const mine = ++looks
      const self = await $.session.id()   // read at every look: /clear and resume go on under another id, and no session.start fires for it
      let names: string[] = []
      try {
        names = (await $.fs.list(dir)).filter(f => f.kind === 'file' && /^\d+\.json$/.test(f.name)).map(f => f.name)
      } catch {
        names = []   // no such folder: a Claude Code that writes no status, or none has run yet
      }
      const rows: Status[] = []
      for (const n of names) {
        try {
          const s = JSON.parse(await $.fs.read(dir + '/' + n)) as Status
          if (s && typeof s.sessionId === 'string' && s.sessionId !== self && !byProgram(s)) rows.push(s)
        } catch {
          // a file being written, or not one of Claude Code's: skipped
        }
      }
      const pids = rows.filter(waits).map(s => Number(s.pid)).filter(p => Number.isInteger(p) && p > 0)
      const live = await alive($, pids)
      if (mine < applied) return
      applied = mine
      const list: Need[] = rows.filter(s => waits(s) && live.has(Number(s.pid))).map(s => ({ id: String(s.sessionId), where: whereOf(s), what: whatOf(s.waitingFor), host: hostOf(s) }))
      const keys = new Set(list.map(keyOf))
      if ([...hidden].some(k => !keys.has(k))) hidden = new Set([...hidden].filter(k => keys.has(k)))
      if (list.length <= 3) expanded = false
      if (JSON.stringify(needs) !== JSON.stringify(list)) {
        needs = list
        $.ui.invalidate('ui.render')
      }

      const now = new Map(rows.map(s => [String(s.sessionId), waits(s) ? 'waiting' : String(s.status)]))
      if (!first) {
        for (const s of rows) {
          const was = before.get(String(s.sessionId)), is = now.get(String(s.sessionId))
          if (is === 'waiting' && was !== 'waiting' && live.has(Number(s.pid))) $.ui.toast(`✋ ${whereOf(s)} needs ${whatOf(s.waitingFor)}`)
          else if (is === 'idle' && was === 'busy') $.ui.toast(`✓ ${whereOf(s)} has finished: your turn there`)
        }
      }
      before = now
      first = false
    }

    await look().catch(() => undefined)
    $.clock.every(4000, () => {
      look().catch(() => undefined)
    })
    return started
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = needs
    if (e.props.hasSurvey || !list.some(n => !hidden.has(keyOf(n)))) return next(e)
    const below = await next(e)   // what the other mods and the engine draw there stays, under the band
    const { Box, Button, Text } = $.ui.resolve(e)
    const open = e.surface === 'desktop' ? opener : undefined   // the desktop app's links are opened from its own window only
    const go = (url: string) => {
      if (open) $.process.run(open(url), { timeoutMs: 5000 }).catch(() => undefined)
    }
    const shown = expanded ? list : list.slice(0, 3)
    const controls = (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Agent Standup</Text>
        {open ? <Button key="next" label="Next waiting" plain onPress={() => go('claude://code/needs-input')} /> : null}
        {expanded ? (
          <Button
            key="fewer"
            label="Fewer"
            plain
            onPress={() => {
              expanded = false
              $.ui.invalidate('ui.render')
            }}
          />
        ) : null}
        <Button
          key="hide"
          label="Hide"
          plain
          onPress={() => {
            hidden = new Set(list.map(keyOf))
            expanded = false
            $.ui.invalidate('ui.render')
          }}
        />
      </Box>
    )
    return (
      <Box flexDirection="column">
        {expanded ? controls : null}
        {shown.map(n => {
          const row = (
            <Text wrap="truncate-end">
              ✋ <Text bold>{n.where}</Text> <Text dimColor>needs {n.what}</Text>
            </Text>
          )
          return open && n.host ? (
            <Button key={'open:' + n.id} plain onPress={() => go('claude://code/continue?session=' + n.host)}>
              {row}
            </Button>
          ) : (
            <Box key={n.id}>{row}</Box>
          )
        })}
        {!expanded && list.length > 3 ? (
          <Button
            key="more"
            plain
            onPress={() => {
              expanded = true
              $.ui.invalidate('ui.render')
            }}
          >
            <Text dimColor>and {list.length - 3} more</Text>
          </Button>
        ) : null}
        {expanded ? null : controls}
        {below}
      </Box>
    )
  })
}
