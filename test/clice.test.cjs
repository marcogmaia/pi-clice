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

function loadExtension() {
  const jiti = createJiti(__filename, {
    alias: { typebox: path.join(modules, "typebox", "build", "index.mjs") },
    moduleCache: false,
    fsCache: false,
  });
  return jiti("../src/extension.ts");
}

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
  let active = ["read", "clice_query", "clice_impact", "clice_modularize"];
  const originalBin = process.env.CLICE_BIN;
  process.env.CLICE_BIN = process.execPath;
  t.after(() => {
    if (originalBin === undefined) delete process.env.CLICE_BIN;
    else process.env.CLICE_BIN = originalBin;
  });
  t.mock.method(childProcess, "spawn", (bin, args, options) => {
    const existedAtSpawn = args.map((arg) => fs.existsSync(path.resolve(options.cwd, arg)));
    calls.push({ bin, args, options, existedAtSpawn });
    const reply = replies.shift();
    assert.ok(reply, `unexpected spawn: ${args.join(" ")}`);
    if (reply.throwError) throw reply.throwError;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(async () => {
      await reply.beforeClose?.(child);
      child.stdout.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
      child.stderr.end(reply.stderr);
      child.killed = reply.timedOut ?? false;
      child.emit("close", reply.code, reply.timedOut ? "SIGTERM" : null);
    });
    return child;
  });
  loadExtension().default({
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { events.set(name, handler); },
    getActiveTools() { return active; },
    setActiveTools(names) { active = names; },
  });
  return {
    replies, calls, commands, tools, root, outside,
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

const analysisPositionals = [
  ["overview", {}, []],
  ["edge", { target: "src/main", to: "src/lib" }, ["edge", "src/main", "src/lib"]],
  ["module", { target: "src/main" }, ["module", "src/main"]],
  ["file", { target: "src/file with spaces.cpp" }, ["file", "src/file with spaces.cpp"]],
  ["interface", {}, ["interface"]],
  ["interface", { target: "src/lib" }, ["interface", "src/lib"]],
  ["obstacles", {}, ["obstacles"]],
  ["macros", {}, ["macros"]],
  ["impact", {}, ["impact"]],
];

test("analysis argv follows the flag matrix and preserves positional and value boundaries", () => {
  const { checkAnalysisRequest, buildAnalysisArgs } = loadExtension();
  const common = {
    scope: ["src/**", "some dir/**"], moves: ["a.h=lib"], merges: ["lib+core"],
    entityMoves: ["fun=lib/a.h"], dirDepth: 0, partition: "a partition.json",
    std: "std/libc++", configuration: "debug", limit: 0, fresh: "always", includeExternal: true,
  };
  for (const [view, params, positionals] of analysisPositionals) {
    const request = { ...common, ...params, view };
    const acceptsAnnotations = ["overview", "file", "impact"].includes(view);
    if (acceptsAnnotations) Object.assign(request, { annotations: ["a.json", "b.json"], churnSince: "" });
    assert.equal(checkAnalysisRequest(request), null);
    assert.deepEqual(buildAnalysisArgs(request, "/project root"), [
      "analyze", "modules", ...positionals, "--scope", "src/**", "--scope", "some dir/**",
      "--move", "a.h=lib", "--merge", "lib+core", "--move-entity", "fun=lib/a.h", "--dir-depth", "0",
      "--partition", "a partition.json", "--std", "std/libc++", "--configuration", "debug",
      ...(view === "overview" ? ["--limit", "0"] : []),
      ...(acceptsAnnotations ? ["--annotation", "a.json", "--annotation", "b.json", "--churn-since", ""] : []),
      "--workspace", "/project root",
    ]);
  }
  assert.deepEqual(buildAnalysisArgs({}, "/project"), ["analyze", "modules", "--workspace", "/project"]);
});

test("analysis validates required positionals, rejected flags and dash-prefixed values", () => {
  const { checkAnalysisRequest } = loadExtension();
  for (const [view, params] of analysisPositionals) {
    const rule = (key) => checkAnalysisRequest({ ...params, view, [key]: "x" });
    if (!["edge", "module", "file", "interface"].includes(view)) assert.match(rule("target"), /does not accept target/);
    if (view !== "edge") assert.match(rule("to"), /does not accept to/);
    if (["edge", "module", "file"].includes(view)) {
      assert.match(checkAnalysisRequest({ view, to: params.to }), /needs target/);
    }
    if (!["overview", "file", "impact"].includes(view)) {
      for (const [key, value] of [["annotations", []], ["churnSince", ""]]) {
        assert.match(checkAnalysisRequest({ ...params, view, [key]: value }), /does not accept/);
      }
    }
  }
  assert.match(checkAnalysisRequest({ view: "edge", target: "lib" }), /needs to/);
  for (const key of ["target", "to", "partition", "std", "configuration"]) {
    assert.match(checkAnalysisRequest({ view: "edge", target: "lib", to: "app", [key]: "--fresh" }), /may not start/);
  }
  for (const key of ["scope", "moves", "merges", "entityMoves", "annotations"]) {
    assert.match(checkAnalysisRequest({ [key]: ["--fresh"] }), /may not start/);
  }
  assert.match(checkAnalysisRequest({ churnSince: "--fresh" }), /may not start/);
});

test("analysis parser accepts a bare array and flags unreadable output", () => {
  const { parseAnalysis } = loadExtension();
  assert.deepEqual(parseAnalysis({ code: 0, stdout: "[]" }), { data: [] });
  for (const stdout of ["", "text", "null", "3", "true", '"text"']) {
    const parsed = parseAnalysis({ code: 0, stdout });
    assert.equal(parsed.parseFailed, true);
    assert.match(parsed.error, /^unreadable clice output/);
  }
  assert.deepEqual(parseAnalysis({ code: 1, stdout: '{"error":"bad glob","stale":["a.h"]}' }), {
    error: "bad glob", stale: ["a.h"],
  });
});

// Reduced fixtures: captured values where available; synthetic rows fill out
// documented shapes. These are not complete CLI captures.
const fixtureCost = { path: "src/zwiz/bot/bot_controller.h", baseline: 17, partitioned: 87, churn: 69, internal: false };
const overviewFixture = {
  files: 590,
  modules: [
    { name: "src/zwiz/gui", headers: 2, sources: 4, lines: 935, layer: 5 },
    { name: "out/vcpkg_installed/x64-windows/include/entt/signal", headers: 1, sources: 0, lines: 42, layer: 2 },
    { name: "src/zwiz/gui/hud", headers: 19, sources: 18, lines: 8122, layer: 4 },
  ],
  edges: [{ interfaceEntities: 12 }, { interfaceEntities: 6 }],
  cycles: [
    { modules: ["out/gtest", "out/gtest/internal"], cut: [{ from: "out/gtest/internal", to: "out/gtest", entities: 6 }] },
    { modules: ["src/zwiz/gui", "src/zwiz/gui/hud"], cut: [{ from: "src/zwiz/gui/hud", to: "src/zwiz/gui", entities: 12 }] },
  ],
  cyclicModules: 4, partitionCycles: [], internalHeaders: 27,
  deepestChain: ["src/zwiz/gui", "src/zwiz/gui/hud", "src/zwiz/bot + src/zwiz/bot/bt",
    "out/vcpkg_installed/x64-windows/include/entt/signal", "out/vcpkg_installed/x64-windows/include/entt/container",
    "out/vcpkg_installed/x64-windows/include/entt/core"],
  totals: { baseline: 14984, partitioned: 58480 },
  hotspots: [fixtureCost],
  moves: [{ path: "src/zwiz_hook/vcpkg_installed/x86-windows-static/include/gtest/gtest.h",
    from: "out/gtest", to: "src/zwiz_hook/tests", with: [], entities: 16 }],
  splits: [{ path: "out/SDL3/SDL_video.h", parts: [{ count: 4 }, { count: 1 }, { count: 4 }] }],
  obstacles: { variantHeaders: 10, contextMacros: 12, borrowedMacros: 17, internalUses: 27,
    crossModuleRedeclarations: 444, foreignDeclarations: 5, splitDefinitions: 1, duplicateDefinitions: 1111,
    configuringMacros: 0, implicitProviders: 5, specializations: 18 },
};

test("overview golden: comprehension and both rebuild numbers lead", () => {
  const { renderOverview } = loadExtension();
  const output = renderOverview(process.cwd(), overviewFixture, {});
  assert.equal(output, [
    "modules 3  (2 in-project, 1 outside the project)  files 590  edges 2",
    "crossings   2 edges, 18 interface entities",
    "cycles      4 modules in a cycle, 0 inside a single module",
    "            src/zwiz/gui <-> src/zwiz/gui/hud  cut src/zwiz/gui/hud -> src/zwiz/gui (12 entities)  (+1 outside the project)",
    `chain       6 deep: ${overviewFixture.deepestChain.join(" > ")}`,
    "shape       27 internal headers, 1 split candidates, 1 move candidates",
    "cost        rebuild units 14984 today -> 58480 if grouped by folder   (x3.9 worse)",
    "---------------------------------------------------------------------",
    "layer 5  src/zwiz/gui  h2  s4  935 lines",
    "layer 4  src/zwiz/gui/hud  h19  s18  8122 lines",
    "(+1 outside the project)",
    "hotspots (limit 20)",
    "  src/zwiz/bot/bot_controller.h  17 -> 87 rebuild units  69 commits",
    "moves (1)",
    "(+1 outside the project)",
    "splits (1)",
    "(+1 outside the project)",
    "obstacles  1111 duplicateDefinitions, 444 crossModuleRedeclarations, 27 internalUses, 18 specializations, " +
      "17 borrowedMacros, 12 contextMacros, 10 variantHeaders, 5 foreignDeclarations, 5 implicitProviders, 1 splitDefinitions",
  ].join("\n"));
  assert.ok(output.length < 24_000);
  assert.doesNotMatch(output, /layer 2|out\/gtest|SDL_video/);
  const all = renderOverview(process.cwd(), overviewFixture, { includeExternal: true });
  assert.match(all, /layer 2  out\/vcpkg_installed/);
  assert.match(all, /out\/SDL3\/SDL_video\.h  3 groups \(4 \/ 1 \/ 4 entities by consumer\)/);
  const fullCycles = renderOverview(process.cwd(), {
    ...overviewFixture, cycles: Array(6).fill(overviewFixture.cycles[1]),
  }, {});
  const top = fullCycles.split("\n").slice(0, 10).join("\n");
  assert.match(top, /crossings/);
  assert.match(top, /cycles/);
  assert.match(top, /14984.*58480/);
  assert.match(top, /\(\+1 hidden\)/);
});

test("overview drops splits, moves, hotspots in order and preserves obstacles", () => {
  const { renderOverview } = loadExtension();
  const longPath = "src/" + "x".repeat(9_000);
  const data = {
    ...overviewFixture,
    splits: [{ path: longPath, parts: [{ count: 1 }] }],
    moves: [{ path: longPath, from: "src/a", to: "src/b", with: [], entities: 1 }],
    hotspots: [{ ...fixtureCost, path: longPath }],
  };
  for (const [budget, shown] of [[23_999, [true, true, false]], [12_000, [true, false, false]], [4_000, [false, false, false]]]) {
    const output = renderOverview(process.cwd(), data, {}, budget);
    assert.ok(output.length <= budget);
    assert.deepEqual([/^hotspots /m, /^moves /m, /^splits /m].map((pattern) => pattern.test(output)), shown);
    assert.match(output, /obstacles  1111 duplicateDefinitions/);
    assert.match(output, /\(sections omitted to fit; narrow with scope or a lower limit\)$/);
  }
});

const entityNames = (count) => Array.from({ length: count }, (_, i) => `entity${i}`);
const bot = "src/zwiz/bot";
const hud = "src/zwiz/gui/hud";
const wrapper = { module: "src/lib", imports: ["src/core"],
  entries: [{ file: "src/lib/lib.h", names: ["Library"], include: "lib/lib.h" }],
  exports: [{ name: "Library", file: "src/lib/lib.h", used: true, form: "type" }],
  textual: [], sharedLocals: [], macros: [], reads: [] };

const rendererGoldens = [
  ["edge", "renderEdgeView", { from: bot, to: hud, entities: [
    { entity: "Widget", owner: `${hud}/widget.h`, users: [`${bot}/bot.cpp:7`] },
    { entity: "Hud", owner: `${hud}/hud.h`, users: [`${bot}/bot.cpp:5`, `${bot}/bot.cpp:6`, `${bot}/bot.cpp:8`] },
  ] }, [
    `${bot} -> ${hud}  (${bot} names ${hud}'s entities)`,
    `Hud  ${hud}/hud.h  3 uses  ${bot}/bot.cpp:5, ${bot}/bot.cpp:6 (+1 hidden)`,
    `Widget  ${hud}/widget.h  1 uses  ${bot}/bot.cpp:7`,
  ]],
  ["module", "renderModuleView", { name: bot, groups: [{
    consumers: ["src/zwiz", `${bot}/bt`, `${bot}/tests`, "src/zwiz/gui", hud],
    headers: entityNames(16).map((name) => `${bot}/${name}.h`), dependsOn: [],
  }], internalHeaders: [`${bot}/local.h`, `${bot}/detail.h`], files: [
    { path: fixtureCost.path, source: false, uses: [{ module: hud, entities: 95 }], usedBy: [{ module: "src/zwiz", entities: 5 }] },
  ] }, [
    `5 consumers: ${entityNames(8).map((name) => `${bot}/${name}.h`).join(", ")} (+8 hidden)  (src/zwiz, ${bot}/bt, ${bot}/tests, src/zwiz/gui, ${hud})`,
    `internal headers: ${bot}/local.h, ${bot}/detail.h`,
    `${fixtureCost.path}  uses: ${hud}(95)  used by: src/zwiz(5)`,
  ]],
  ["file", "renderFileView", { path: fixtureCost.path, module: bot, source: false,
    affinity: [{ module: hud, entities: 95 }, { module: "src/zwiz", entities: 52 }, { module: bot, entities: 170 }],
    uses: [{ module: "src/zwiz", entities: entityNames(52) }, { module: bot, entities: entityNames(140) }],
    usedBy: [{ module: "src/zwiz", entities: entityNames(5) }, { module: hud, entities: entityNames(95) }],
    annotations: [{ name: "churn", unit: "commits", value: 69 }],
  }, [
    `${fixtureCost.path}   in ${bot}   (header)`,
    `uses          ${bot} 140, src/zwiz 52`,
    `used by       src/zwiz, ${hud}`,
    `affinity      ${bot} 170 (54%), ${hud} 95 (30%), src/zwiz 52 (16%)`,
    "annotations  churn 69 commits",
  ]],
  ["impact", "renderModuleImpact", [
    { path: "src/other.h", baseline: 100, partitioned: 90, churn: 0, internal: true }, fixtureCost,
  ], [`${fixtureCost.path}  17 -> 87  (+70)`, "src/other.h  100 -> 90  (-10) [internal]"]],
  ["interface", "renderInterface", [wrapper, { ...wrapper, module: "src/empty", imports: [], entries: [] }], [
    "src/lib", "imports (1): src/core", "entries (1)", "  Library  <lib/lib.h>", "exports 1", "textual (0)",
    "shared locals (0)", "macros (0)", "reads (0)", "1 module(s) with no entries or imports",
  ]],
  ["obstacles", "renderObstacles", {
    duplicateDefinitions: [{}, {}, {}],
    internalUses: [{ entity: "helper", owner: "src/owner.h", reason: "internal linkage" }],
    implicitProviders: [{ path: "src/provider.h", specializes: ["Template", "Trait"] }],
  }, [
    "duplicateDefinitions (3)", "implicitProviders (1)", "  src/provider.h  specializes: Template, Trait",
    "internalUses (1)", "  helper  src/owner.h  internal linkage",
  ]],
  ["macros", "renderMacros", [], ["0 crossing macro(s)"]],
];

for (const [view, method, fixture, lines] of rendererGoldens) {
  test(`${view} golden`, () => {
    const output = loadExtension()[method](process.cwd(), fixture, {});
    assert.equal(output, lines.join("\n"));
    assert.ok(output.length < 24_000);
  });
}

test("file view pluralizes capped module lists without losing the hidden count", () => {
  const { renderFileView } = loadExtension();
  const fixture = rendererGoldens.find(([view]) => view === "file")[2];
  for (const hidden of [1, 2]) {
    const affinity = Array.from({ length: 5 + hidden }, (_, i) => ({ module: `src/module${i}`, entities: 1 }));
    const output = renderFileView(process.cwd(), { ...fixture, affinity }, {});
    const row = output.split("\n").find((line) => line.startsWith("affinity"));
    assert.ok(row.endsWith(`(+${hidden} ${hidden === 1 ? "module" : "modules"}) (+${hidden} hidden)`));
    assert.doesNotMatch(row, /src\/module5/);
  }
});

test("module analysis keeps overflow counts and does not infer macro fields", () => {
  const { renderMacros, renderModuleImpact, renderInterface } = loadExtension();
  const macros = Array(7).fill({ "arbitrary key": [1, { anotherKey: "value" }] });
  assert.equal(renderMacros(process.cwd(), macros, {}), [
    "7 crossing macro(s)", ...Array(5).fill('  "arbitrary key"=[1,{"anotherKey":"value"}]'), "(+2 hidden)",
  ].join("\n"));
  assert.equal(renderMacros(process.cwd(), macros, { limit: 6 }).split("\n").at(-1), "(+1 hidden)");
  const long = renderModuleImpact(process.cwd(), Array.from({ length: 40 }, (_, i) => ({
    ...fixtureCost, path: `src/${i}${"x".repeat(1_000)}.h`,
  })), {});
  assert.ok(long.length < 24_000);
  assert.match(long, /\n\(\+17 hidden\)$/);
  const iface = renderInterface(process.cwd(), [{ ...wrapper,
    imports: [...entityNames(6), "out/system"], entries: Array(16).fill(wrapper.entries[0]),
  }], {});
  assert.match(iface, /imports \(7\): .* \(\+1 outside the project\) \(\+1 hidden\)/);
  assert.match(iface, /\n\(\+1 hidden\)\nexports/);
});

const outline = { question: "document-symbols", target: "src/file with spaces.cpp" };
const impact = { kind: "file-deps", target: "src/file with spaces.cpp", direction: "includes", depth: 0 };
const stale = ["src/file with spaces.cpp"];

test("active tools are kept in Clice workspaces and hidden elsewhere", (t) => {
  const api = register(t);
  assert.deepEqual(api.start(path.join(api.root, "src")), ["read", "clice_query", "clice_impact", "clice_modularize"]);
  assert.deepEqual([...api.tools.keys()], ["clice_query", "clice_impact", "clice_modularize"]);
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

test("registered modularize dispatches every view without forwarding --fresh", async (t) => {
  const api = register(t);
  const tool = api.tools.get("clice_modularize");
  assert.deepEqual(Object.keys(tool.parameters.properties), [
    "view", "target", "to", "scope", "dirDepth", "partition", "std", "moves", "merges", "entityMoves",
    "annotations", "churnSince", "limit", "configuration", "includeExternal", "fresh",
  ]);
  assert.equal(tool.parameters.additionalProperties, false);
  for (const [view, params, positionals] of analysisPositionals) {
    const golden = rendererGoldens.find(([name]) => name === view);
    api.replies.push({ code: 0, body: golden ? golden[2] : overviewFixture });
    const result = await api.call("clice_modularize", { view, ...params });
    assert.equal(result.isError, false, text(result));
    assert.equal(result.details.refreshed, false);
    if (golden) assert.equal(text(result), golden[3].join("\n"));
    assert.ok(text(result).length < 24_000);
    assert.deepEqual(api.calls.at(-1).args, ["analyze", "modules", ...positionals, "--workspace", api.root]);
  }
  const costRows = rendererGoldens.find(([name]) => name === "impact")[2];
  api.replies.push({ code: 0, body: costRows });
  const limited = await api.call("clice_modularize", { view: "impact", limit: 1 });
  assert.equal(text(limited), `${fixtureCost.path}  17 -> 87  (+70)\n(+1 hidden)`);
  assert.ok(!api.calls.at(-1).args.includes("--limit"));
});

test("overview labels a custom hypothesis and counts cycle records", async (t) => {
  const api = register(t);
  const hypothesis = { moves: ["src/zwiz/bot/bt/healer_node.h=src/zwiz/bot"] };
  const body = { ...overviewFixture, partitionCycles: [{}, {}], totals: { baseline: 14984, partitioned: 58308 } };
  api.replies.push({ code: 0, body });
  const result = await api.call("clice_modularize", hypothesis);
  assert.equal(result.isError, false);
  assert.match(text(result), /14984 today -> 58308 with the proposed partition/);
  assert.match(text(result), /4 modules in a cycle, 2 inside a single module/);
  assert.doesNotMatch(text(result), /grouped by folder/);
  assert.deepEqual(api.calls[0].args, ["analyze", "modules", "--move", hypothesis.moves[0], "--workspace", api.root]);

  const { renderOverview } = loadExtension();
  for (const request of [{ partition: "custom.json" }, { merges: ["a+b"] }, { entityMoves: ["Type=src/type.h"] }]) {
    assert.match(renderOverview(api.root, body, request), /58308 with the proposed partition/);
  }
});

test("obstacles distinguishes an unknown envelope from an empty obstacle list", async (t) => {
  const api = register(t);
  for (const body of [{ result: { variantHeaders: [{}] } }, { variantHeaders: 1 }, { variantHeaders: [{}] }, { variantHeaders: [] }]) {
    api.replies.push({ code: 0, body });
  }
  const call = () => api.call("clice_modularize", { view: "obstacles" });
  for (let i = 0; i < 2; i++) {
    const malformed = await call();
    assert.equal(malformed.isError, true);
    assert.match(text(malformed), /^unreadable clice output/);
    assert.doesNotMatch(text(malformed), /No obstacles/);
  }
  const positive = await call();
  assert.equal(positive.isError, false);
  assert.equal(text(positive), "variantHeaders (1)");
  const empty = await call();
  assert.equal(empty.isError, false);
  assert.equal(text(empty), "No obstacles");
});

test("unsupported modularize parameters fail before refresh or analysis", async (t) => {
  const api = register(t);
  for (const params of [
    { view: "module", target: "src/lib", annotations: [{}] },
    { view: "edge", target: "--workspace", to: "src/lib" },
    { view: "edge", target: "src/lib", to: "--fresh" },
    { view: "file", target: "src/lib/library.h", to: "src/lib" },
    { target: "src/lib" },
  ]) {
    const result = await api.call("clice_modularize", { fresh: "always", ...params });
    assert.equal(result.isError, true);
  }
  assert.equal(api.calls.length, 0);
});

test("inline modularize inputs live through the spawn and only owned files are removed", async (t) => {
  const api = register(t);
  const partition = { modules: [{ name: "lib", files: ["src/**"] }] };
  const annotation = { name: "compile_time", unit: "s", values: { "src/a.cpp": 1.5 } };
  const provided = "existing annotation.json";
  const providedPath = path.join(api.root, provided);
  fs.writeFileSync(providedPath, "{}");
  function checkInputs() {
    const { args, existedAtSpawn } = api.calls.at(-1);
    const partitionAt = args.indexOf("--partition") + 1;
    const annotationAt = args.indexOf("--annotation") + 1;
    const owned = [partitionAt, annotationAt, annotationAt + 4].map((index) => {
      assert.equal(existedAtSpawn[index], true);
      assert.equal(path.dirname(args[index]), os.tmpdir());
      assert.equal(path.extname(args[index]), ".json");
      return args[index];
    });
    assert.equal(new Set(owned).size, 3);
    assert.equal(args[annotationAt + 2], provided);
    assert.equal(existedAtSpawn[annotationAt + 2], true);
    return owned;
  }
  const params = { partition, annotations: [annotation, provided, annotation] };
  api.replies.push({ code: 0, body: overviewFixture, beforeClose() {
    assert.deepEqual(checkInputs().map((file) => JSON.parse(fs.readFileSync(file, "utf8"))),
      [partition, annotation, annotation]);
  } });
  assert.equal((await api.call("clice_modularize", params)).isError, false);
  for (const file of checkInputs()) assert.equal(fs.existsSync(file), false);
  api.replies.push({ throwError: new Error("simulated spawn failure") });
  const threw = await api.call("clice_modularize", params);
  assert.equal(threw.isError, true);
  assert.match(text(threw), /simulated spawn failure/);
  for (const file of checkInputs()) assert.equal(fs.existsSync(file), false);
  const controller = new AbortController();
  let filesExistBeforeClose;
  api.replies.push({ code: null, body: "", async beforeClose(child) {
    controller.abort();
    child.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    // Let the rejection reach executeModularize if it does not wait for close.
    await new Promise(setImmediate);
    filesExistBeforeClose = checkInputs().map((file) => fs.existsSync(file));
  } });
  const cancelled = await api.call("clice_modularize", params, controller.signal);
  assert.equal(text(cancelled), "Cancelled");
  assert.deepEqual(filesExistBeforeClose, [true, true, true]);
  for (const file of checkInputs()) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(providedPath), true);
});

test("modularize freshness proxies once, defaults off, and warns after a failed refresh", async (t) => {
  const api = register(t);
  const plain = { code: 0, body: overviewFixture };
  api.replies.push(
    { code: 0, body: { result: { files: [] } } }, plain,
    plain, plain,
    { code: 2, body: { error: "cannot refresh the index" } }, plain,
  );
  const refreshed = await api.call("clice_modularize", { fresh: "always" });
  const off = await api.call("clice_modularize", { fresh: "off" });
  const auto = await api.call("clice_modularize", { fresh: "auto" });
  const failed = await api.call("clice_modularize", { fresh: "always" });
  assert.equal(refreshed.details.refreshed, true);
  assert.equal(off.details.refreshed, false);
  assert.equal(auto.details.refreshed, false);
  assert.equal(text(off), text(auto));
  assert.doesNotMatch(text(off), /fresh|saved copy|stale/);
  assert.equal(failed.isError, false);
  assert.equal(failed.details.refreshed, false);
  assert.match(text(failed), /\nwarning: index refresh failed \(cannot refresh the index\)\.$/);
  const proxy = ["query", "project-files", "--fresh", "--workspace", api.root];
  const analysis = ["analyze", "modules", "--workspace", api.root];
  assert.deepEqual(api.calls.map(({ args }) => args), [proxy, analysis, analysis, analysis, proxy, analysis]);
});

test("modularize distinguishes negative, exit 2, older CLI and unreadable output", async (t) => {
  const api = register(t);
  const stalePath = path.join(api.root, "src", "owner.h");
  api.replies.push(
    { code: 1, body: { error: "unknown module", stale: [stalePath] } },
    { code: 1, body: { error: "unknown file" } },
    { code: 1, body: { error: "bad glob" } },
    { code: 2, body: { error: "no index", stale: [stalePath] } },
    { code: 2, body: { error: "unknown subcommand 'analyze'" } },
    { code: 0, body: "clice version 0.9.0" },
    { code: 0, body: "" },
    { code: 0, body: "x".repeat(400) },
  );
  const module = await api.call("clice_modularize", { view: "module", target: "lib" });
  assert.equal(module.isError, false);
  assert.equal(text(module), "clice: unknown module\nHint: module names come from view: overview.\nstale: 1 index unit(s) missing: src/owner.h");
  const file = await api.call("clice_modularize", { view: "file", target: "src/owner.h" });
  assert.equal(file.isError, false);
  assert.match(text(file), /Hint: pass a path relative to the project root/);
  const glob = await api.call("clice_modularize", { scope: ["["] });
  assert.equal(glob.isError, false);
  assert.equal(text(glob), "clice: bad glob");
  const index = await api.call("clice_modularize", {});
  assert.equal(index.isError, true);
  assert.match(text(index), /clice index/);
  assert.ok(text(index).includes(process.execPath));
  assert.match(text(index), /stale:.*src\/owner.h/);
  const older = await api.call("clice_modularize", {});
  assert.equal(older.isError, true);
  assert.match(text(older), /too old for analyze modules.*clice version 0\.9\.0/);
  assert.deepEqual(api.calls.at(-1).args, ["--version"]);
  const empty = await api.call("clice_modularize", {});
  assert.equal(empty.isError, true);
  assert.equal(text(empty), "unreadable clice output");
  const unreadable = await api.call("clice_modularize", {});
  assert.equal(unreadable.isError, true);
  assert.equal(text(unreadable), `unreadable clice output: ${"x".repeat(300)}`);
  for (const result of [module, file, glob, index, older, empty, unreadable]) {
    assert.doesNotMatch(text(result), /refresh first|--fresh/);
  }
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
