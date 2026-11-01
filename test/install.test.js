import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withHooks, hasHooks, EVENTS } from "../mods/cursor-status/status.mjs";

const SCRIPT = resolve("mods/cursor-status/status.mjs");
const CMD = `node '${SCRIPT}' hook`;
const theirs = { command: "~/bin/notify.sh", timeout: 10 };

function home() {
  const dir = mkdtempSync(join(tmpdir(), "cursor-status-home-"));
  mkdirSync(join(dir, ".cursor"));
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: dir }, encoding: "utf8" });
const hooksFile = (dir) => join(dir, ".cursor", "hooks.json");
const backupFile = (dir) => join(dir, ".cursor", "hooks.json.cursor-status-backup");
const read = (dir) => JSON.parse(readFileSync(hooksFile(dir), "utf8"));

test("withHooks adds one entry per event beside foreign ones, idempotently", () => {
  const before = { version: 1, hooks: { stop: [theirs], afterAgentResponse: [theirs] } };
  const once = withHooks(before, { command: CMD });
  const twice = withHooks(once, { command: CMD });
  assert.deepEqual(twice, once);
  assert.ok(hasHooks(once));
  for (const e of EVENTS) assert.equal(once.hooks[e].filter((h) => h.command.includes("status.mjs")).length, 1, e);
  assert.deepEqual(once.hooks.stop[0], theirs, "foreign hooks keep their place");
  assert.deepEqual(once.hooks.afterAgentResponse, [theirs]);
  assert.equal(once.hooks.stop.at(-1).command, `${CMD} stop`);
  assert.deepEqual(before.hooks.stop, [theirs], "input not mutated");
});

test("withHooks remove takes out only ours", () => {
  const before = { version: 1, hooks: { stop: [theirs] } };
  assert.deepEqual(withHooks(withHooks(before, { command: CMD }), { remove: true }), before);
  assert.deepEqual(withHooks(withHooks({}, { command: CMD }), { remove: true }), { version: 1 });
  assert.ok(!hasHooks(before));
});

test("an older install at another path is replaced, not duplicated", () => {
  const old = withHooks({}, { command: "node '/old/place/cursor-status/status.mjs' hook" });
  const now = withHooks(old, { command: CMD });
  assert.equal(now.hooks.stop.length, 1);
  assert.equal(now.hooks.stop[0].command, `${CMD} stop`);
});

test("install creates hooks.json when missing, without a backup", () => {
  const dir = home();
  const r = run(dir, "install");
  assert.equal(r.status, 0, r.stderr);
  const doc = read(dir);
  assert.equal(doc.version, 1);
  assert.ok(hasHooks(doc));
  assert.ok(!existsSync(backupFile(dir)));
});

test("install keeps foreign hooks, backs up once, and is idempotent", () => {
  const dir = home();
  const original = JSON.stringify({ version: 1, hooks: { stop: [theirs], beforeShellExecution: [theirs] } }, null, 2) + "\n";
  writeFileSync(hooksFile(dir), original);
  assert.equal(run(dir, "install").status, 0);
  const first = readFileSync(hooksFile(dir), "utf8");
  assert.equal(readFileSync(backupFile(dir), "utf8"), original);
  const doc = JSON.parse(first);
  assert.deepEqual(doc.hooks.stop[0], theirs);
  assert.deepEqual(doc.hooks.beforeShellExecution, [theirs], "permission hooks untouched");
  const again = run(dir, "install");
  assert.equal(again.status, 0);
  assert.match(again.stdout, /Nothing to change/);
  assert.equal(readFileSync(hooksFile(dir), "utf8"), first);
  // A later change keeps the first backup.
  writeFileSync(hooksFile(dir), JSON.stringify({ version: 1, hooks: { stop: [theirs] } }));
  assert.equal(run(dir, "install").status, 0);
  assert.equal(readFileSync(backupFile(dir), "utf8"), original);
});

test("uninstall removes only our entries", () => {
  const dir = home();
  const doc = { version: 1, hooks: { stop: [theirs], sessionStart: [theirs] } };
  writeFileSync(hooksFile(dir), JSON.stringify(doc));
  run(dir, "install");
  const r = run(dir, "uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(read(dir), doc);
  assert.match(run(dir, "uninstall").stdout, /Nothing to change/);
});

test("uninstall with no hooks.json changes nothing", () => {
  const dir = home();
  const r = run(dir, "uninstall");
  assert.equal(r.status, 0);
  assert.ok(!existsSync(hooksFile(dir)));
});

test("a malformed hooks.json is refused and left as it is", () => {
  const dir = home();
  writeFileSync(hooksFile(dir), "{ not json");
  for (const cmd of ["install", "uninstall"]) {
    const r = run(dir, cmd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(hooksFile(dir), "utf8"), "{ not json");
  }
  assert.ok(!existsSync(backupFile(dir)));
});

test("an empty hooks.json is treated as empty", () => {
  const dir = home();
  writeFileSync(hooksFile(dir), "");
  assert.equal(run(dir, "install").status, 0);
  assert.ok(hasHooks(read(dir)));
});

test("doctor reports whether the hooks are in", () => {
  const dir = home();
  let report = JSON.parse(run(dir, "doctor").stdout);
  assert.equal(report.installed, false);
  run(dir, "install");
  report = JSON.parse(run(dir, "doctor").stdout);
  assert.equal(report.installed, true);
  assert.equal(report.hooksFile, hooksFile(dir));
  assert.deepEqual(report.events, EVENTS);
});
