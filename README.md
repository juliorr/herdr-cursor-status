# Cursor Status for Herdr

Cursor Agent CLI (`cursor-agent`) terminals report their status to the
[Herdr](https://herdr.dev) desktop app, so they show in its Agents panel
as working, done or idle, with Cursor's name and icon.

Herdr only lists a terminal as an agent when its program reports a status
with OSC 7501, and `cursor-agent` doesn't
([herdrdev/herdr-app#98](https://github.com/herdrdev/herdr-app/issues/98)).
This add-on fills the gap with Cursor's own hooks, the same way the
workaround in that issue does for Hermes.

## Install

Needs Node 20 or later on your `PATH`, macOS or Linux.

```sh
cp -R mods/cursor-status ~/.config/herdr-app/mods/
node ~/.config/herdr-app/mods/cursor-status/status.mjs install
```

Start a new `cursor-agent` in a Herdr terminal. Check it with:

```sh
node ~/.config/herdr-app/mods/cursor-status/status.mjs doctor
```

## Uninstall

```sh
node ~/.config/herdr-app/mods/cursor-status/status.mjs uninstall
rm -rf ~/.config/herdr-app/mods/cursor-status
```

## What it does

| Cursor hook          | Report to Herdr                            |
| -------------------- | ------------------------------------------ |
| `sessionStart`       | `idle`                                     |
| `beforeSubmitPrompt` | `working`                                  |
| `postToolUse`        | `working`                                  |
| `stop`               | `idle`, or `error` when the turn failed    |
| `sessionEnd`         | `clear` (the terminal stops being an agent) |

Each report is `ESC ]7501;state=<state>:app=cursor ESC \`, written to the
terminal (`/dev/tty`, else the tty of the nearest parent process that has
one). Herdr shows an `idle` after `working` as **done** until you look at
that terminal.

## What it touches

- `~/.cursor/hooks.json`: `install` adds one entry per event above, after
  any hooks you or other tools already have, and changes nothing else.
  The first time it changes the file, your original is copied to
  `~/.cursor/hooks.json.cursor-status-backup` (once; later installs keep it).
  Running `install` again changes nothing. `uninstall` removes only its own
  entries. A `hooks.json` that isn't valid JSON is left alone and reported.
- Nothing else. The hook reads Cursor's payload on stdin, writes the report
  to the terminal and exits 0. It never prints to stdout, never reaches the
  network and does nothing outside a Herdr terminal (no `HC_TERMINAL_ID`).

## Limits

- **No `blocked` state.** Cursor has no hook that fires while it waits for
  you to approve a command. The hooks that come close
  (`beforeShellExecution`, `beforeMCPExecution`, `preToolUse`) take a
  permission decision from their output, and this add-on stays out of
  those so your own approvals are never affected. A terminal waiting on
  you shows as working.
- Hooks are read when `cursor-agent` starts: restart running sessions after
  installing.
- macOS and Linux only (it writes to a Unix tty).
- One report per hook, no progress, no message text.

## Development

```sh
npm test            # node --test, no dependencies
herdr-app check "$PWD/mods/cursor-status"
```

Tests run the script with a temporary `HOME` and point the tty at a file
(`HERDR_CURSOR_STATUS_TTY`), so they never touch your real setup.

## License

MIT
