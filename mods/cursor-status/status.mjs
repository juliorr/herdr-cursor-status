#!/usr/bin/env node
// Cursor Status: Cursor Agent CLI terminals report their status to Herdr.
//
// Herdr lists a terminal as an agent only when its program reports a status
// with OSC 7501. cursor-agent doesn't, so Cursor's own hooks
// (~/.cursor/hooks.json) run this script, which writes the report to the
// terminal itself (/dev/tty: the hook's stdout belongs to Cursor).
//
//   status.mjs hook <event>   run by Cursor; payload JSON on stdin
//   status.mjs install        add our hooks to ~/.cursor/hooks.json
//   status.mjs uninstall      take only our hooks out again
//   status.mjs doctor         JSON: are the hooks in, where
//
// The hook never prints to stdout and only uses events that take no
// permission decision, so the person's own approvals are never touched.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, chmodSync, statSync, realpathSync, openSync, writeSync, closeSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The 7501 `app`: the key of Herdr's `cursor` program, so it gets Cursor's name and icon. */
export const APP = "cursor";

/** Cursor events we hook. None of them decides a permission. */
export const EVENTS = ["sessionStart", "beforeSubmitPrompt", "postToolUse", "stop", "sessionEnd"];

/** `ESC ] 7501 ; state=<s>:app=cursor ESC \` */
export const osc = (state) => `\x1b]7501;state=${state}:app=${APP}\x1b\\`;

/**
 * The 7501 state for a Cursor event, or null for one we don't report.
 * `stop` ends a turn: idle (Herdr shows it as done until the person looks),
 * or error when Cursor says the turn failed. `sessionEnd` clears the report.
 */
export function stateFor(event, payload) {
  switch (event) {
    case "sessionStart": return "idle";
    case "beforeSubmitPrompt":
    case "postToolUse": return "working";
    case "stop": return payload?.status === "error" ? "error" : "idle";
    case "sessionEnd": return "clear";
    default: return null;
  }
}

// ── hook ────────────────────────────────────────────────────────────────────

/** Everything on stdin (Cursor's payload), parsed; {} when it isn't JSON. Gives up after 1s. */
function readPayload() {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise((done) => {
    let text = "";
    const finish = () => {
      clearTimeout(timer);
      try { done(JSON.parse(text)); } catch { done({}); }
    };
    const timer = setTimeout(finish, 1000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { text += c; });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

/** Ttys of our ancestors (`ps`), for when the hook runs without a controlling terminal. */
function ancestorTtys() {
  const ttys = [];
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    let out;
    try { out = execFileSync("ps", ["-o", "tty=,ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { break; }
    const [tty, ppid] = out.split(/\s+/);
    if (tty && /\d/.test(tty) && !tty.includes("?")) ttys.push(tty.startsWith("/dev/") ? tty : `/dev/${tty}`);
    pid = Number(ppid);
  }
  return [...new Set(ttys)];
}

function writeTo(path, text, flags) {
  const fd = openSync(path, flags);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/**
 * Writes the report to the terminal. HERDR_CURSOR_STATUS_TTY (tests) names
 * the one file to write instead. Failures are swallowed: a hook never breaks Cursor.
 */
function report(state) {
  const text = osc(state);
  const override = process.env.HERDR_CURSOR_STATUS_TTY;
  if (override) {
    try { writeTo(override, text, "w"); } catch { /* tolerated */ }
    return;
  }
  const flags = constants.O_WRONLY | (constants.O_NOCTTY ?? 0);
  try { writeTo("/dev/tty", text, flags); return; } catch { /* no controlling terminal */ }
  for (const tty of ancestorTtys()) {
    try { writeTo(tty, text, flags); return; } catch { /* next */ }
  }
}

async function hook([event]) {
  const payload = await readPayload();
  if (!process.env.HC_TERMINAL_ID) return;
  const state = stateFor(event, payload);
  if (state) report(state);
}

// ── install ─────────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);
const shq = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
/** The command Cursor runs, before the event name. */
export const hookCommand = (script = SELF) => `node ${shq(script)} hook`;
const isOurs = (h) => typeof h?.command === "string" && /cursor-status[\\/]+status\.mjs'? hook\b/.test(h.command);

/**
 * `~/.cursor/hooks.json` with our hooks added (one per event, after the
 * person's own) or, with `remove`, taken out. Anything else is kept.
 */
export function withHooks(doc, { remove = false, command = hookCommand() } = {}) {
  const out = structuredClone(doc ?? {});
  out.version ??= 1;
  out.hooks ??= {};
  for (const event of EVENTS) {
    const list = (out.hooks[event] ?? []).filter((h) => !isOurs(h));
    if (!remove) list.push({ command: `${command} ${event}`, timeout: 5 });
    if (list.length) out.hooks[event] = list;
    else delete out.hooks[event];
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export const hasHooks = (doc) => EVENTS.every((e) => (doc?.hooks?.[e] ?? []).some(isOurs));

const hooksFile = () => join(process.env.HOME || homedir(), ".cursor", "hooks.json");
const BACKUP = ".cursor-status-backup";

function readJson(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`${path} is not valid JSON; fix it first, Cursor Status won't overwrite it.`); }
}

/**
 * Writes atomically. The first change copies the person's original to
 * `<file>.cursor-status-backup`; later changes keep that copy. A symlink
 * (dotfiles) is written where it points; permissions are kept.
 */
function save(path, text) {
  let target = path;
  try { target = realpathSync(path); } catch { /* not there yet */ }
  mkdirSync(dirname(target), { recursive: true });
  let mode = null;
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === text) return false;
    mode = statSync(target).mode & 0o7777;
    if (!existsSync(path + BACKUP)) copyFileSync(target, path + BACKUP);
  }
  const tmp = `${target}.cursor-status-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  if (mode !== null) chmodSync(tmp, mode);
  renameSync(tmp, target);
  return true;
}

function install(remove = false) {
  const file = hooksFile();
  const doc = readJson(file);
  if (remove && !hasAny(doc)) return void process.stdout.write("Nothing to change.\n");
  const changed = save(file, JSON.stringify(withHooks(doc, { remove }), null, 2) + "\n");
  process.stdout.write(changed ? `${remove ? "Removed from" : "Updated"}: ${file}\n` : "Nothing to change.\n");
}
const hasAny = (doc) => EVENTS.some((e) => (doc?.hooks?.[e] ?? []).some(isOurs));

function doctor() {
  const file = hooksFile();
  let installed = false;
  let error = null;
  try { installed = hasHooks(readJson(file)); } catch (e) { error = e.message; }
  const out = { installed, hooksFile: file, events: EVENTS, app: APP, script: SELF, inHerdr: Boolean(process.env.HC_TERMINAL_ID) };
  if (error) out.error = error;
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

// ── main ────────────────────────────────────────────────────────────────────

const COMMANDS = {
  hook: { run: hook, quiet: true },
  install: { run: () => install() },
  uninstall: { run: () => install(true) },
  doctor: { run: doctor },
};

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const cmd = COMMANDS[name];
  if (!cmd) {
    process.stderr.write(`usage: status.mjs ${Object.keys(COMMANDS).join("|")}\n`);
    process.exit(2);
  }
  try {
    await cmd.run(args);
    if (cmd.quiet) process.exit(0);
  } catch (err) {
    if (cmd.quiet) process.exit(0);
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF)) main();
