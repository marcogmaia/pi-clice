const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

// Use the installed Pi loader dependency, but stub Pi registration and clice.
const install = process.env.PI_INSTALL_ROOT || path.join(os.homedir(), ".pi/agent/install");
const version = fs.readFileSync(path.join(install, "current-version"), "utf8").trim();
const modules = path.resolve(install, "releases", version, "node_modules");
const { createJiti } = require(path.join(modules, "jiti"));

function register(t) {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-clice-test-"));
  const root = path.join(outside, "project");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "clice.toml"), "");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const replies = [];
  const calls = [];
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  let active = ["read", "clice_query", "clice_impact"];
  const originalBin = process.env.CLICE_BIN;
  process.env.CLICE_BIN = process.execPath;
  t.after(() => {
    if (originalBin === undefined) delete process.env.CLICE_BIN;
    else process.env.CLICE_BIN = originalBin;
  });
  t.mock.method(childProcess, "spawn", (bin, args, options) => {
    calls.push({ bin, args, options });
    const reply = replies.shift();
    assert.ok(reply, `unexpected spawn: ${args.join(" ")}`);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      child.stderr.end(reply.stderr);
      child.killed = reply.timedOut ?? false;
      child.emit("close", reply.code, reply.timedOut ? "SIGTERM" : null);
    });
    return child;
  });
  const jiti = createJiti(__filename, {
    alias: { typebox: path.join(modules, "typebox", "build", "index.mjs") },
    moduleCache: false,
    fsCache: false,
  });
  jiti("../src/extension.ts").default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools() { return active; },
    setActiveTools(names) { active = names; },
  });
  return {
    replies, calls, commands, root, outside,
    start(cwd) {
      events.get("session_start")({}, { cwd });
      return active;
    },
    call(name, params, signal) {
      return tools.get(name).execute("test", params, signal, undefined, { cwd: root });
    },
  };
}

function text(result) {
  return result.content[0].text;
}

const outline = { question: "document-symbols", target: "src/file with spaces.cpp" };
const impact = { kind: "file-deps", target: "src/file with spaces.cpp", direction: "includes", depth: 0 };
const stale = ["src/file with spaces.cpp"];

test("active tools are kept in Clice workspaces and hidden elsewhere", (t) => {
  const api = register(t);
  assert.deepEqual(api.start(path.join(api.root, "src")), ["read", "clice_query", "clice_impact"]);
  assert.deepEqual(api.start(api.outside), ["read"]);
  assert.equal(api.commands.has("clice"), true);
  assert.equal(api.calls.length, 0);
});

test("both tools retry an empty stale answer once and preserve argv boundaries", async (t) => {
  const api = register(t);
  api.replies.push(
    { code: 0, body: { result: { symbols: [] }, stale } },
    { code: 0, body: { result: { symbols: [] }, stale: [] } },
    { code: 0, body: { result: { includes: [] }, stale } },
    { code: 0, body: { result: { includes: [{ path: "src/header.h", depth: 1 }] } } },
  );
  const query = await api.call("clice_query", outline);
  const deps = await api.call("clice_impact", impact);
  assert.match(text(query), /index refreshed/);
  assert.match(text(deps), /src\/header\.h/);
  assert.equal(deps.details.refreshed, true);
  const { root } = api;
  assert.deepEqual(api.calls.map(({ args }) => args), [
    ["query", "document-symbols", outline.target, "--workspace", root],
    ["query", "document-symbols", outline.target, "--workspace", root, "--fresh"],
    ["query", "file-deps", impact.target, "--direction", "includes", "--depth", "0", "--workspace", root],
    ["query", "file-deps", impact.target, "--direction", "includes", "--depth", "0", "--workspace", root, "--fresh"],
  ]);
});

test("negative answers and empty results without stale evidence give a hint, not a retry", async (t) => {
  const api = register(t);
  api.replies.push(
    { code: 1, body: { error: "symbol not found", stale: [] } },
    { code: 0, body: { result: { includes: [] } } },
    { code: 0, body: { result: { includes: [] }, stale } },
  );
  const query = await api.call("clice_query", { question: "definition", target: "[some symbol]" });
  const deps = await api.call("clice_impact", impact);
  const disabled = await api.call("clice_impact", { ...impact, fresh: "off" });
  assert.equal(query.isError, false);
  assert.match(text(query), /New or renamed code/);
  assert.match(text(deps), /Check the source with rg/);
  assert.match(text(disabled), /records were withheld/);
  assert.equal(api.calls[0].args[2], "some symbol");
  assert.equal(api.calls.length, 3);
});

test("failed retry keeps the original stale answer; malformed and forced failures are errors", async (t) => {
  const api = register(t);
  api.replies.push(
    { code: 0, body: { result: { symbols: [] }, stale } },
    { code: 2, body: { error: "bad index" } },
    { code: 1, body: {} },
    { code: 2, body: { error: "no index" } },
  );
  const retry = await api.call("clice_query", outline);
  const malformed = await api.call("clice_impact", impact);
  const forced = await api.call("clice_impact", { ...impact, fresh: "always" });
  assert.equal(retry.isError, false);
  assert.equal(retry.details.refreshed, false);
  assert.match(text(retry), /index refresh failed \(bad index\)/);
  assert.match(text(retry), /records were withheld/);
  assert.equal(malformed.isError, true);
  assert.equal(forced.isError, true);
  assert.doesNotMatch(text(forced), /index refreshed|answer is stale/);
});

test("a module-only impact result is not empty even if files are stale", async (t) => {
  const api = register(t);
  api.replies.push({
    code: 0,
    body: { result: { directDependents: [], transitiveDependents: [], affectedModules: ["example"] }, stale },
  });
  const result = await api.call("clice_impact", { kind: "impact-analysis", target: impact.target });
  assert.match(text(result), /affected modules: example/);
  assert.match(text(result), /records were withheld/);
  assert.equal(api.calls.length, 1);
});

test("timeout and cancellation do not look like negative answers", async (t) => {
  const api = register(t);
  api.replies.push({ code: null, body: "partial stdout", timedOut: true });
  const timedOut = await api.call("clice_query", outline);
  const cancelled = await api.call("clice_impact", impact, AbortSignal.abort());
  assert.equal(timedOut.isError, true);
  assert.match(text(timedOut), /timed out after 120 seconds/);
  assert.equal(cancelled.isError, true);
  assert.equal(text(cancelled), "Cancelled");
  assert.equal(api.calls.length, 1);
});

test("impact counts external paths without suggesting an unsupported flag", async (t) => {
  const api = register(t);
  api.replies.push({ code: 0, body: { result: { files: [{ path: "out/header.h" }] } } });
  const result = await api.call("clice_impact", { kind: "project-files" });
  assert.match(text(result), /1 outside the project/);
  assert.doesNotMatch(text(result), /out\/header\.h|includeExternal/);
});

test("/clice reports cache schema and shows diagnostics for unrecognized stats", async (t) => {
  const api = register(t);
  const notices = [];
  const ctx = { cwd: api.root, ui: { notify: (message) => notices.push(message) } };
  api.replies.push(
    { code: 0, body: "clice 1.0\n" },
    { code: 0, body: "Index cache: d:/project/.clice/cache/v15/index/default\r\nTranslation units: 2\r\nGlobal symbols: 12\r\n" },
    { code: 0, body: "clice 1.0\n" },
    { code: 0, body: "New stats format\n" },
  );
  await api.commands.get("clice").handler("", ctx);
  await api.commands.get("clice").handler("", ctx);
  assert.match(notices[0], /2 TUs \/ 12 symbols.*cache\/v15\/index\/default/);
  assert.match(notices[1], /index stats format unrecognized: New stats format/);
});
