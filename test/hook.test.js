import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { osc, stateFor, EVENTS } from "../mods/cursor-status/status.mjs";

const SCRIPT = resolve("mods/cursor-status/status.mjs");
const ESC = "\x1b";

// Runs `status.mjs hook <event>` the way Cursor does: payload on stdin.
// The tty is a plain file in a temp folder, so nothing reaches a real terminal.
function hook(event, payload = {}, { inHerdr = true, tty } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cursor-status-hook-"));
  const ttyPath = tty ?? join(dir, "tty");
  const env = { ...process.env, HOME: dir, HERDR_CURSOR_STATUS_TTY: ttyPath };
  delete env.HC_TERMINAL_ID;
  if (inHerdr) env.HC_TERMINAL_ID = "t1";
  const r = spawnSync(process.execPath, [SCRIPT, "hook", event], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  const written = existsSync(ttyPath) ? readFileSync(ttyPath, "utf8") : null;
  return { ...r, written };
}

test("the report is the exact OSC 7501 bytes with app=cursor", () => {
  assert.equal(osc("working"), `${ESC}]7501;state=working:app=cursor${ESC}\\`);
  assert.equal(osc("clear"), `${ESC}]7501;state=clear:app=cursor${ESC}\\`);
});

test("each event maps to its state", () => {
  assert.equal(stateFor("sessionStart", {}), "idle");
  assert.equal(stateFor("beforeSubmitPrompt", {}), "working");
  assert.equal(stateFor("postToolUse", {}), "working");
  assert.equal(stateFor("stop", { status: "completed" }), "idle");
  assert.equal(stateFor("stop", { status: "aborted" }), "idle");
  assert.equal(stateFor("stop", { status: "error" }), "error");
  assert.equal(stateFor("stop", {}), "idle");
  assert.equal(stateFor("sessionEnd", {}), "clear");
  assert.equal(stateFor("beforeShellExecution", {}), null, "permission hooks are never used");
  assert.equal(stateFor("nonsense", {}), null);
});

test("no permission-deciding event is installed", () => {
  for (const e of ["preToolUse", "subagentStart", "beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "beforeTabFileRead"]) {
    assert.ok(!EVENTS.includes(e), e);
  }
});

const CASES = [
  ["sessionStart", {}, "idle"],
  ["beforeSubmitPrompt", { prompt: "hi" }, "working"],
  ["postToolUse", { tool_name: "Shell" }, "working"],
  ["stop", { status: "completed" }, "idle"],
  ["stop", { status: "error" }, "error"],
  ["sessionEnd", { reason: "user_close" }, "clear"],
];

for (const [event, payload, state] of CASES) {
  test(`hook ${event} (${JSON.stringify(payload)}) writes ${state} to the tty and nothing to stdout`, () => {
    const r = hook(event, payload);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "stdout stays empty so Cursor sees no decision");
    assert.equal(r.stderr, "");
    assert.equal(r.written, `${ESC}]7501;state=${state}:app=cursor${ESC}\\`);
  });
}

test("outside a Herdr terminal (no HC_TERMINAL_ID) the hook does nothing", () => {
  for (const [event, payload] of CASES) {
    const r = hook(event, payload, { inHerdr: false });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.written, null, event);
  }
});

test("an unknown event writes nothing and exits 0", () => {
  const r = hook("beforeShellExecution", { command: "rm -rf /" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.written, null);
});

test("a tty that can't be opened is tolerated silently", () => {
  const r = hook("beforeSubmitPrompt", {}, { tty: "/nonexistent-dir/tty" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("malformed or empty stdin still reports and exits 0", () => {
  for (const input of ["", "not json", "[1,2"]) {
    const r = hook("stop", input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.written, `${ESC}]7501;state=idle:app=cursor${ESC}\\`);
  }
});

test("hook without an event exits 0 quietly", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "hook"], { input: "", encoding: "utf8", env: { ...process.env, HC_TERMINAL_ID: "t1", HERDR_CURSOR_STATUS_TTY: "/nonexistent-dir/tty" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
