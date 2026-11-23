/**
 * clice: C/C++ semantic queries from pi.
 *
 * Registers `clice_query` and `clice_impact`, backed by the clice CLI, which
 * answers from a persisted compile-accurate project index -- no language
 * server, no buffer sync. A `/clice` command prints binary, root and index
 * status.
 *
 * Install the package with `pi install <package path>`. The tools are active
 * by default in workspaces with a Clice config or compilation database.
 * Binary resolution: `CLICE_BIN`, then PATH, then a Clice editor extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- constants

const kQuestions = [
  "symbol-search",
  "definition",
  "references",
  "call-graph",
  "type-hierarchy",
  "implementation",
  "read-symbol",
  "document-symbols",
  "counterparts",
] as const;

const kImpactKinds = ["impact-analysis", "file-deps", "project-files"] as const;

const kFreshModes = ["auto", "always", "off"] as const;

/** Result arrays per question, used to tell an empty answer from a real one. */
const kListFields = {
  "symbol-search": ["symbols"],
  references: ["references"],
  "call-graph": ["callers", "callees"],
  "type-hierarchy": ["supertypes", "subtypes"],
  implementation: ["implementations"],
  counterparts: ["candidates"],
  "document-symbols": ["symbols"],
  "impact-analysis": ["directDependents", "transitiveDependents", "affectedModules"],
  "file-deps": ["includes", "includers"],
  "project-files": ["files"],
} as const;

type Question = (typeof kQuestions)[number] | (typeof kImpactKinds)[number];
type ListQuestion = keyof typeof kListFields;

const kMaxItems = 40;
const kMaxChars = 24_000;
const kMaxCodeChars = 20_000;
const kMaxStdoutChars = 8 * 1024 * 1024;
const kTimeoutMs = 120_000;

// -------------------------------------------------------------------- types

interface SymbolRef {
  name: string;
  kind?: string;
  signature?: string | null;
  container?: string | null;
  file?: string;
  line?: number;
  symbol?: string;
  documentation?: string | null;
}

interface SourceSpan {
  file: string;
  startLine: number;
  endLine: number;
  text?: string;
}

interface ReferenceItem {
  file: string;
  line: number;
  context?: string | null;
  function?: string | null;
}

interface CliceAnswer {
  result?: any;
  error?: string;
  candidates?: SymbolRef[];
  stale?: string[];
  /** The stdout was not a clice answer at all, so nothing was asked successfully. */
  parseFailed?: boolean;
}

interface CliceRun {
  answer: CliceAnswer;
  code: number;
  refreshed: boolean;
  refreshError?: string;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

// -------------------------------------------------------- binary resolution

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function versionsOf(dirName: string): number[] {
  const match = /clice-io\.clice-([0-9.]+)/.exec(dirName);
  if (!match) return [0];
  return match[1].split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left: number[], right: number[]): number {
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function editorExtensionRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".windsurf", "extensions"),
  ];
  return roots.filter((root) => isDir(root));
}

function binaryInExtensionRoot(root: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  const dirs = entries
    .filter((name) => name.startsWith("clice-io.clice-"))
    .sort((left, right) => compareVersions(versionsOf(left), versionsOf(right)));
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const names = ["clice.exe", "clice"];
    for (const name of names) {
      const candidate = path.join(root, dirs[i], "clice", "bin", name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function binaryOnPath(): string | null {
  const suffixes = process.platform === "win32" ? [".exe"] : [""];
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of entries) {
    if (!entry) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(entry, `clice${suffix}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveBinary(): string | null {
  const configured = process.env.CLICE_BIN;
  if (configured && isFile(configured)) return configured;
  const fromPath = binaryOnPath();
  if (fromPath) return fromPath;
  for (const root of editorExtensionRoots()) {
    const found = binaryInExtensionRoot(root);
    if (found) return found;
  }
  return null;
}

// ------------------------------------------------------ workspace discovery

const kProjectMarkers = [
  "clice.toml",
  path.join(".clice", "config.toml"),
  "compile_commands.json",
  path.join("build", "compile_commands.json"),
];

function findWorkspaceRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    const hit = kProjectMarkers.some((marker) => fs.existsSync(path.join(dir, marker)));
    if (hit) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// --------------------------------------------------------------- executing

function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      signal,
      timeout: kTimeoutMs,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let clipped = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > kMaxStdoutChars) {
        clipped = true;
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk.slice(0, Math.max(0, kMaxChars - stderr.length));
    });
    child.on("error", reject);
    child.on("close", (code, exitSignal) => {
      if (code === null) {
        const reason = child.killed && !signal?.aborted
          ? `timed out after ${kTimeoutMs / 1000} seconds`
          : `terminated (${exitSignal ?? "unknown signal"})`;
        resolve({ code: -1, stdout: "", stderr: `clice ${reason}` });
      } else if (clipped) {
        resolve({ code: -1, stdout: "", stderr: `clice output exceeded ${kMaxStdoutChars} characters` });
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function parseAnswer(result: ProcessResult): CliceAnswer {
  const text = result.stdout.trim();
  if (!text) {
    const reason = result.stderr.trim() || `clice exited with code ${result.code}`;
    return { error: reason, parseFailed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `unreadable clice output: ${text.slice(0, 300)}`, parseFailed: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `unexpected clice output: ${text.slice(0, 300)}`, parseFailed: true };
  }
  const answer = parsed as CliceAnswer;
  if (validAnswer(answer, result.code)) return answer;
  return { error: `unexpected clice answer (exit ${result.code}): ${text.slice(0, 300)}`, parseFailed: true };
}

function validAnswer(answer: CliceAnswer, code: number): boolean {
  if (answer.stale !== undefined &&
      (!Array.isArray(answer.stale) || !answer.stale.every((file) => typeof file === "string"))) {
    return false;
  }
  if (code !== 0) {
    return typeof answer.error === "string" && answer.error.length > 0 && answer.result == null;
  }
  return answer.error == null && Boolean(answer.result &&
    typeof answer.result === "object" && !Array.isArray(answer.result));
}

// ---------------------------------------------------------- freshness logic

function listItems<T>(answer: CliceAnswer, field: string): T[] {
  const value = answer.result?.[field];
  return Array.isArray(value) ? value : [];
}

function answerIsEmpty(question: Question, answer: CliceAnswer): boolean {
  if (!answer.result || !Object.hasOwn(kListFields, question)) return false;
  const fields = kListFields[question as ListQuestion];
  return fields.some((field) => Array.isArray(answer.result[field])) &&
    fields.every((field) => listItems(answer, field).length === 0);
}

function needsRefresh(question: Question, answer: CliceAnswer): boolean {
  return Boolean(answer.error) || answerIsEmpty(question, answer);
}

async function safeRun(
  bin: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  try {
    return await runProcess(bin, args, cwd, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: -1, stdout: "", stderr: `could not run clice: ${message}` };
  }
}

function refreshedRun(forced: ProcessResult): CliceRun {
  const answer = parseAnswer(forced);
  const usable = !answer.parseFailed && (forced.code === 0 || forced.code === 1);
  if (usable) return { answer, code: forced.code, refreshed: true };
  const reason = answer.error ?? `clice exited with code ${forced.code}`;
  return { answer, code: forced.code, refreshed: false, refreshError: reason };
}

async function askClice(
  bin: string,
  root: string,
  question: Question,
  args: string[],
  fresh: (typeof kFreshModes)[number],
  signal?: AbortSignal,
): Promise<CliceRun> {
  if (fresh === "always") {
    return refreshedRun(await safeRun(bin, [...args, "--fresh"], root, signal));
  }
  const plain = await safeRun(bin, args, root, signal);
  const answer = parseAnswer(plain);
  const stale = answer.stale ?? [];
  if (signal?.aborted || fresh === "off" || stale.length === 0) {
    return { answer, code: plain.code, refreshed: false };
  }
  if (!needsRefresh(question, answer)) {
    return { answer, code: plain.code, refreshed: false };
  }
  const retried = refreshedRun(await safeRun(bin, [...args, "--fresh"], root, signal));
  if (retried.refreshed) return retried;
  return {
    answer,
    code: plain.code,
    refreshed: false,
    refreshError: retried.refreshError,
  };
}

function answerIsError(run: CliceRun): boolean {
  if (run.answer.parseFailed) return true;
  return run.code !== 0 && run.code !== 1;
}

// ------------------------------------------------------- path and locators

function relativeToRoot(root: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
    return abs.replace(/\\/g, "/");
  }
  return rel || ".";
}

const kExternalSegments = new Set([".clice", ".venv", "out", "vcpkg_installed"]);

function isExternalPath(root: string, file?: string): boolean {
  if (!file) return false;
  const rel = relativeToRoot(root, file).toLowerCase();
  if (rel.startsWith("/") || /^[a-z]:\//.test(rel)) return true;
  if (rel === ".." || rel.startsWith("../")) return true;
  return rel.split("/").some((segment) => kExternalSegments.has(segment));
}

function shortenSymbol(root: string, symbol?: string): string {
  if (!symbol) return "";
  const space = symbol.indexOf(" ");
  if (space < 0) return symbol;
  const rest = symbol.slice(space + 1);
  if (!rest.startsWith("path:")) return symbol;
  return `${symbol.slice(0, space)} path:${relativeToRoot(root, rest.slice("path:".length))}`;
}

function symbolLine(root: string, item: SymbolRef): string {
  const kind = item.kind ?? "?";
  const name = item.container ? `${item.container}::${item.name}` : item.name;
  const signature = item.signature ?? "";
  const where = item.file ? `${relativeToRoot(root, item.file)}:${item.line ?? 0}` : "?";
  const locator = shortenSymbol(root, item.symbol);
  const suffix = locator ? `  [${locator}]` : "";
  return `- ${where}  ${kind} ${name}${signature}${suffix}`;
}

function shortText(value?: string | null, max = 120): string {
  return (value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function capItems<T>(items: T[]): { shown: T[]; hidden: number } {
  if (items.length <= kMaxItems) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, kMaxItems), hidden: items.length - kMaxItems };
}

function keepLocal<T extends { file?: string }>(
  root: string,
  items: T[],
  includeExternal: boolean,
): T[] {
  if (includeExternal) return items;
  return items.filter((item) => !isExternalPath(root, item.file));
}

function fitBody(body: string, budget: number): string {
  if (body.length <= budget) return body;
  const keep = Math.max(0, budget - 40);
  return `${body.slice(0, keep)}\n... (${body.length - keep} chars truncated)`;
}

function staleNote(
  root: string,
  answer: CliceAnswer,
  refreshed: boolean,
  refreshError?: string,
): string {
  const stale = answer.stale ?? [];
  const parts: string[] = [];
  if (refreshError) {
    parts.push(`\nwarning: index refresh failed (${shortText(refreshError, 500)}).`);
  } else if (refreshed) {
    parts.push("\n(index refreshed before answering)");
  }
  if (stale.length > 0) {
    const shown = stale.slice(0, 5).map((file) => relativeToRoot(root, file).slice(0, 300));
    const more = stale.length > shown.length ? ` (+${stale.length - shown.length} more)` : "";
    parts.push(
      `\nnote: ${stale.length} file(s) changed since the index was built, so their records` +
        ` were withheld: ${shown.join(", ")}${more}. Retry with fresh: "always".`,
    );
  }
  return parts.join("");
}

function listTail(hidden: number, filtered: number, canIncludeExternal = true): string[] {
  const lines: string[] = [];
  if (hidden > 0) lines.push(`... ${hidden} more`);
  if (filtered > 0) {
    const hint = canIncludeExternal ? " (includeExternal: true to show)" : "";
    lines.push(`... ${filtered} outside the project${hint}`);
  }
  return lines;
}

// ------------------------------------------------------------- answer text

function renderSymbolSearch(root: string, answer: CliceAnswer, includeExternal: boolean): string {
  const items = listItems<SymbolRef>(answer, kListFields["symbol-search"][0]);
  const local = keepLocal(root, items, includeExternal);
  const { shown, hidden } = capItems(local);
  const lines = [`${items.length} symbol(s)`].concat(shown.map((item) => symbolLine(root, item)));
  return lines.concat(listTail(hidden, items.length - local.length)).join("\n");
}

function renderDefinition(root: string, answer: CliceAnswer): string {
  const item = answer.result as SymbolRef & { definition?: SourceSpan; otherDefinitions?: SourceSpan[] };
  const head = item.container ? `${item.container}::${item.name}` : item.name;
  const lines = [`${item.kind ?? "?"} ${head}`];
  if (item.documentation) lines.push("", item.documentation.trim());
  const span = item.definition;
  if (span) {
    lines.push("", `${relativeToRoot(root, span.file)}:${span.startLine}-${span.endLine}`);
    if (span.text) lines.push("```cpp", span.text, "```");
  }
  for (const other of item.otherDefinitions ?? []) {
    lines.push("", `also defined at ${relativeToRoot(root, other.file)}:${other.startLine}`);
  }
  const locator = shortenSymbol(root, item.symbol);
  if (locator) lines.push("", `symbol: ${locator}`);
  return lines.join("\n");
}

function renderReferences(root: string, answer: CliceAnswer, includeExternal: boolean): string {
  const items = listItems<ReferenceItem>(answer, kListFields.references[0]);
  const local = keepLocal(root, items, includeExternal);
  const { shown, hidden } = capItems(local);
  const lines = [`${items.length} reference(s)`];
  for (const item of shown) {
    const where = `${relativeToRoot(root, item.file)}:${item.line}`;
    const context = shortText(item.context, 100);
    const owner = item.function ? `  in ${item.function}` : "";
    lines.push(`- ${where}  ${context}${owner}`);
  }
  return lines.concat(listTail(hidden, items.length - local.length)).join("\n");
}

function renderCallGraph(root: string, answer: CliceAnswer, includeExternal: boolean): string {
  const result = answer.result ?? {};
  const rootItem: SymbolRef | undefined = result.root;
  const lines = rootItem ? [`root: ${symbolLine(root, rootItem).slice(2)}`] : [];
  const groups = kListFields["call-graph"].map(
    (field) => [field, listItems<SymbolRef>(answer, field)] as const,
  );
  const filled = groups.filter(([, items]) => items.length > 0);
  for (const [label, items] of filled.length > 0 ? filled : groups) {
    const local = keepLocal(root, items, includeExternal);
    const { shown, hidden } = capItems(local);
    lines.push("", `${label} (${items.length}):`);
    lines.push(...shown.map((item) => symbolLine(root, item)));
    lines.push(...listTail(hidden, items.length - local.length));
  }
  return lines.join("\n");
}

function renderHierarchy(
  root: string,
  answer: CliceAnswer,
  fields: readonly string[],
  includeExternal: boolean,
): string {
  const rootItem: SymbolRef | undefined = answer.result?.root;
  const lines = rootItem ? [`root: ${symbolLine(root, rootItem).slice(2)}`] : [];
  for (const field of fields) {
    const items = listItems<SymbolRef>(answer, field);
    const local = keepLocal(root, items, includeExternal);
    const { shown, hidden } = capItems(local);
    lines.push("", `${field} (${items.length}):`);
    lines.push(...shown.map((item) => symbolLine(root, item)));
    lines.push(...listTail(hidden, items.length - local.length));
  }
  return lines.join("\n");
}

function renderOutline(root: string, answer: CliceAnswer): string {
  const items = listItems<SymbolRef & { startLine?: number; endLine?: number }>(
    answer, kListFields["document-symbols"][0],
  );
  const { shown, hidden } = capItems(items);
  const lines = [`${items.length} symbol(s)`];
  for (const item of shown) {
    const span = `${item.startLine ?? 0}-${item.endLine ?? 0}`;
    const locator = shortenSymbol(root, item.symbol);
    lines.push(`- ${span}  ${item.kind ?? "?"} ${item.name}${locator ? `  [${locator}]` : ""}`);
  }
  lines.push(...listTail(hidden, 0));
  return lines.join("\n");
}

function renderReadSymbol(root: string, answer: CliceAnswer): string {
  const item = answer.result as SymbolRef & { startLine?: number; endLine?: number; text?: string };
  const head = item.container ? `${item.container}::${item.name}` : item.name;
  const lines = [`${item.kind ?? "?"} ${head}${item.signature ?? ""}`];
  if (item.file) {
    lines.push(`${relativeToRoot(root, item.file)}:${item.startLine ?? 0}-${item.endLine ?? 0}`);
  }
  if (item.documentation) lines.push("", item.documentation.trim());
  const text = (item.text ?? "").slice(0, kMaxCodeChars);
  if (text) lines.push("", "```cpp", text, "```");
  const clipped = (item.text ?? "").length - text.length;
  if (clipped > 0) lines.push(`(body clipped: ${clipped} more characters)`);
  return lines.join("\n");
}

function renderCounterparts(root: string, answer: CliceAnswer): string {
  const result = answer.result ?? {};
  const candidates = listItems<{ path: string; reasons?: string[] }>(answer, kListFields.counterparts[0]);
  const preferred: string | null = result.preferred ?? null;
  const lines = [`${candidates.length} counterpart(s)`];
  for (const candidate of candidates) {
    const mark = preferred && candidate.path === preferred ? " (preferred)" : "";
    const reasons = (candidate.reasons ?? []).join("; ");
    lines.push(`- ${relativeToRoot(root, candidate.path)}${mark}${reasons ? `  ${reasons}` : ""}`);
  }
  return lines.join("\n");
}

function renderError(root: string, answer: CliceAnswer, includeExternal: boolean): string {
  const lines = [`clice: ${answer.error}`];
  const candidates = answer.candidates ?? [];
  if (candidates.length === 0) return lines.join("\n");
  const local = keepLocal(root, candidates, includeExternal);
  const shown = (local.length > 0 ? local : candidates).slice(0, 10);
  lines.push("", "candidates:");
  for (const candidate of shown) lines.push(symbolLine(root, candidate));
  return lines.join("\n");
}

function renderQueryAnswer(
  root: string,
  question: string,
  answer: CliceAnswer,
  includeExternal: boolean,
): string {
  if (answer.error) return renderError(root, answer, includeExternal);
  switch (question) {
    case "symbol-search":
      return renderSymbolSearch(root, answer, includeExternal);
    case "definition":
      return renderDefinition(root, answer);
    case "references":
      return renderReferences(root, answer, includeExternal);
    case "call-graph":
      return renderCallGraph(root, answer, includeExternal);
    case "type-hierarchy":
    case "implementation":
      return renderHierarchy(root, answer, kListFields[question], includeExternal);
    case "read-symbol":
      return renderReadSymbol(root, answer);
    case "document-symbols":
      return renderOutline(root, answer);
    case "counterparts":
      return renderCounterparts(root, answer);
    default:
      return JSON.stringify(answer.result ?? answer, null, 1);
  }
}

// ------------------------------------------------------------ impact text

function renderFileList(root: string, label: string, files: string[]): string[] {
  const local = files.filter((file) => !isExternalPath(root, file));
  const { shown, hidden } = capItems(local);
  const lines = [`${label} (${files.length}): ${shown.map((file) => relativeToRoot(root, file)).join(", ")}`];
  if (shown.length === 0) lines[0] = `${label} (${files.length})`;
  lines.push(...listTail(hidden, files.length - local.length, false));
  return lines;
}

function renderImpact(root: string, answer: CliceAnswer): string {
  const [direct, transitive, affected] = kListFields["impact-analysis"];
  const lines = renderFileList(root, "direct dependents", listItems<string>(answer, direct));
  lines.push(...renderFileList(root, "transitive dependents", listItems<string>(answer, transitive)));
  const modules = listItems<string>(answer, affected);
  if (modules.length > 0) lines.push(`affected modules: ${modules.join(", ")}`);
  return lines.join("\n");
}

function renderDeps(root: string, answer: CliceAnswer): string[] {
  const lines: string[] = [];
  for (const field of kListFields["file-deps"]) {
    const items = listItems<{ path: string; depth?: number }>(answer, field);
    const local = items.filter((item) => !isExternalPath(root, item.path));
    const external = items.length - local.length;
    const { shown, hidden } = capItems(local);
    lines.push(`${field} (${items.length}, ${external} outside the project)`);
    for (const item of shown) {
      lines.push(`- ${relativeToRoot(root, item.path)}${item.depth ? `  depth ${item.depth}` : ""}`);
    }
    lines.push(...listTail(hidden, 0));
  }
  return lines;
}

function renderProjectFiles(root: string, answer: CliceAnswer): string {
  const entries = listItems<{ path?: string }>(answer, kListFields["project-files"][0]);
  const paths = entries
    .map((entry) => entry.path ?? "")
    .filter((file) => file.length > 0);
  const local = paths.filter((file) => !isExternalPath(root, file));
  const { shown, hidden } = capItems(local);
  const lines = [`${paths.length} file(s)`].concat(shown.map((file) => relativeToRoot(root, file)));
  return lines.concat(listTail(hidden, paths.length - local.length, false)).join("\n");
}

function renderImpactAnswer(root: string, kind: string, answer: CliceAnswer): string {
  if (answer.error) return renderError(root, answer, false);
  if (kind === "impact-analysis") return renderImpact(root, answer);
  if (kind === "file-deps") return renderDeps(root, answer).join("\n");
  return renderProjectFiles(root, answer);
}

// ------------------------------------------------------------------- setup

/** A string enum JSON Schema that keeps its literal union in Static. */
function enumField<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

function cleanTarget(raw: string): string {
  const trimmed = raw.trim();
  const bracketed = /^\[(.*)\]$/.exec(trimmed);
  return (bracketed ? bracketed[1] : trimmed).trim();
}

function targetIssue(target: string): string | null {
  if (target.startsWith("-")) {
    return "a target may not start with `-`; use a qualified name or a workspace-relative path prefixed with `./`.";
  }
  return null;
}

function badCount(value: unknown): boolean {
  if (value === undefined) return false;
  return typeof value !== "number" || !Number.isInteger(value) || value < 0;
}

function missingBinaryText(): string {
  return (
    "clice binary not found. Install the clice editor extension, put `clice` on PATH, " +
    "or set CLICE_BIN to the executable."
  );
}

function fail(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text },
    isError: true,
  };
}

interface ToolRequest {
  question: Question;
  target?: string;
  direction?: string;
  limit?: number;
  depth?: number;
  filter?: string;
  includeExternal?: boolean;
  fresh?: (typeof kFreshModes)[number];
}

function buildQueryArgs(request: ToolRequest, target: string, root: string): string[] {
  const { question, limit, depth, direction, filter } = request;
  const args = ["query", question];
  if (target) args.push(target);
  if (question === "symbol-search" && limit !== undefined) args.push("--limit", String(limit));
  if ((question === "call-graph" || question === "file-deps") && direction) {
    args.push("--direction", direction);
  }
  if (question === "file-deps" && depth !== undefined) args.push("--depth", String(depth));
  if (question === "project-files" && filter) args.push("--filter", filter);
  args.push("--workspace", root);
  return args;
}

function isImpactQuestion(question: Question): question is (typeof kImpactKinds)[number] {
  return kImpactKinds.some((kind) => question === kind);
}

function checkRequest(request: ToolRequest, target: string): string | null {
  const { question } = request;
  if (!target && question !== "symbol-search" && question !== "project-files") {
    const suggestion = isImpactQuestion(question) ? "a file path" : querySuggestions(question);
    return `${question} needs a target (${suggestion}).`;
  }
  for (const count of ["limit", "depth"] as const) {
    if (badCount(request[count])) return `${count} must be a whole number, 0 or more.`;
  }
  return targetIssue(target);
}

function noMatchNote(request: ToolRequest, run: CliceRun): string {
  if (run.refreshed || answerIsError(run) || run.answer.stale?.length) return "";
  if (request.question === "symbol-search" && request.limit === 0) return "";
  if (run.answer.error !== "symbol not found" && !answerIsEmpty(request.question, run.answer)) return "";
  return '\nnote: this answer is from the saved index. New or renamed code may be missing without a stale-file warning. Check the source with rg or retry with fresh: "always".';
}

function renderRun(root: string, target: string, request: ToolRequest, run: CliceRun) {
  const { question } = request;
  const body = isImpactQuestion(question)
    ? renderImpactAnswer(root, question, run.answer)
    : renderQueryAnswer(root, question, run.answer, request.includeExternal ?? false);
  const note = staleNote(root, run.answer, run.refreshed, run.refreshError) + noMatchNote(request, run);
  return {
    content: [{ type: "text" as const, text: fitBody(body, kMaxChars - note.length) + note }],
    details: {
      ...(isImpactQuestion(question) ? { kind: question } : { question }),
      target, root, refreshed: run.refreshed, stale: run.answer.stale ?? [], code: run.code,
    },
    isError: answerIsError(run),
  };
}

async function executeRequest(cwd: string, request: ToolRequest, signal?: AbortSignal) {
  if (signal?.aborted) return fail("Cancelled");
  const target = request.question === "project-files" ? "" : cleanTarget(request.target ?? "");
  const issue = checkRequest(request, target);
  if (issue) return fail(issue);
  const bin = resolveBinary();
  if (!bin) return fail(missingBinaryText());
  const root = findWorkspaceRoot(cwd) ?? path.resolve(cwd);
  const args = buildQueryArgs(request, target, root);
  const run = await askClice(bin, root, request.question, args, request.fresh ?? "auto", signal);
  if (signal?.aborted) return fail("Cancelled");
  return renderRun(root, target, request, run);
}

function describeIndex(stats: ProcessResult): string {
  const diagnostics = shortText(stats.stderr || stats.stdout, 500);
  if (stats.code !== 0) {
    return `index unavailable (exit ${stats.code}): ${diagnostics || "no diagnostics"}. ` +
      "Check the workspace and index; set CLICE_BIN to the binary that built it if versions differ.";
  }
  const cache = /^Index cache: (.+)$/m.exec(stats.stdout)?.[1]?.trim();
  const units = /^Translation units: (\d+)/m.exec(stats.stdout)?.[1];
  const symbols = /^Global symbols: (\d+)/m.exec(stats.stdout)?.[1];
  const counts = units || symbols ? `${units ?? "?"} TUs / ${symbols ?? "?"} symbols` : "";
  if (!counts) return `index stats format unrecognized: ${diagnostics || "no output"}`;
  return cache ? `${counts} | cache: ${cache}` : counts;
}

function querySuggestions(question: string): string {
  if (question === "document-symbols" || question === "counterparts") {
    return "a file path, e.g. `src/zwiz_common/game_rva.h`";
  }
  if (question === "symbol-search") {
    return "a name, glob, `ns::Class`, `path:src/dir/`, `kind:function`, or `file.cpp:120`";
  }
  return "a locator: a name, `ns::Class::method`, `file.cpp:120:8`, or a printed `[...]` symbol";
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (findWorkspaceRoot(ctx.cwd)) return;
    const active = pi.getActiveTools();
    const remaining = active.filter((name) => name !== "clice_query" && name !== "clice_impact");
    if (remaining.length !== active.length) pi.setActiveTools(remaining);
  });

  pi.registerTool({
    name: "clice_query",
    label: "clice Query",
    description:
      "Ask clice's compile-accurate C/C++ index questions a text search cannot answer: " +
      "symbol-search, definition, references, call-graph, type-hierarchy, implementation, " +
      "read-symbol, document-symbols, counterparts. Reads a persisted index; no language " +
      "server needed. Answers are workspace-relative and per-project by default.",
    promptSnippet:
      "Query clice's compile-accurate C++ index: symbols, references, call graph, hierarchy, bodies",
    promptGuidelines: [
      "Use clice_query instead of rg for C/C++ symbols: it resolves overloads, macros, templates and types from the real compile command.",
      "clice_query targets are clice locators: a name, a glob, `ns::Class::method`, `path:src/dir/`, `file.cpp:120:8`, or the `[...]` symbol printed by an earlier answer passed back verbatim.",
      "Use clice_query with question call-graph, type-hierarchy or implementation for inheritance and call questions, and question read-symbol to read a function body with its documentation.",
      "If a clice_query answer carries a note about stale files, the index predates the last edit; retry that call with fresh: \"always\" before trusting it.",
      "Use rg for exact text or when clice_query misses code on disk. New or renamed code can be absent with no stale note; use fresh: \"always\" when you need to refresh the index.",
    ],
    parameters: Type.Object({
      question: enumField(
        kQuestions,
        "symbol-search (find by name/glob/path), definition, references, call-graph " +
          "(direction: callers|callees|both), type-hierarchy, implementation, read-symbol, " +
          "document-symbols (file outline), counterparts (header/source pairing).",
      ),
      target: Type.Optional(
        Type.String({
          description:
            "Locator or file the question is about. Omit only for a bare `symbol-search` listing.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 0, description: "symbol-search: at most this many symbols (default 100)." }),
      ),
      direction: Type.Optional(
        enumField(
          ["callers", "callees", "both"] as const,
          "call-graph only: which side of the call graph to list (default both).",
        ),
      ),
      includeExternal: Type.Optional(
        Type.Boolean({
          description:
            "Include SDK, vcpkg and build output results. Default false keeps the project only.",
        }),
      ),
      fresh: Type.Optional(
        enumField(
          kFreshModes,
          'Index freshness: "auto" (default) reindexes only when the answer is empty or ' +
            'negative and files changed, "always" reindexes first, "off" never does.',
        ),
      ),
    }, { additionalProperties: false }),

    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeRequest(ctx.cwd, params, signal);
    },
  });

  pi.registerTool({
    name: "clice_impact",
    label: "clice Impact",
    description:
      "Ask clice what a file change reaches: impact-analysis (includers and affected modules), " +
      "file-deps (include graph, both directions, to a depth), project-files (the build's files). " +
      "Use before editing a shared header to see the rebuild and breakage surface.",
    promptSnippet: "clice rebuild surface: impact-analysis, file-deps, project-files",
    promptGuidelines: [
      "Use clice_impact with kind impact-analysis before changing a widely included header, and kind file-deps to see what a header pulls in or who includes it.",
      "clice_impact lists project files only and counts SDK, vcpkg and build-output files separately; read the counts before assuming a header is self-contained.",
    ],
    parameters: Type.Object({
      kind: enumField(kImpactKinds, "impact-analysis | file-deps | project-files"),
      target: Type.Optional(
        Type.String({
          description: "File path for impact-analysis and file-deps; unused for project-files.",
        }),
      ),
      direction: Type.Optional(
        enumField(
          ["includes", "includers", "both"] as const,
          "file-deps only: which side of the include graph to follow.",
        ),
      ),
      depth: Type.Optional(
        Type.Integer({ minimum: 0, description: "file-deps only: levels to follow, 0 for all (default 1)." }),
      ),
      filter: Type.Optional(
        enumField(
          ["all", "source", "header", "module"] as const,
          "project-files only: which kinds of file to list.",
        ),
      ),
      fresh: Type.Optional(
        enumField(kFreshModes, "Index freshness; same meaning as clice_query."),
      ),
    }, { additionalProperties: false }),

    execute(_toolCallId, { kind, ...params }, signal, _onUpdate, ctx) {
      return executeRequest(ctx.cwd, { ...params, question: kind }, signal);
    },
  });

  pi.registerCommand("clice", {
    description: "Show the clice binary, workspace root and index status",
    handler: async (_args, ctx) => {
      const bin = resolveBinary();
      if (!bin) {
        ctx.ui.notify(missingBinaryText(), "warning");
        return;
      }
      const root = findWorkspaceRoot(ctx.cwd) ?? path.resolve(ctx.cwd);
      const [version, stats] = await Promise.all([
        safeRun(bin, ["--version"], root),
        safeRun(bin, ["index", "stats", "--workspace", root], root),
      ]);
      const label = version.code === 0 ? shortText(version.stdout, 120) : "clice version unknown";
      ctx.ui.notify(
        `${label || "clice"} | ${root.replace(/\\/g, "/")} | ${describeIndex(stats)} | ${bin}`,
        stats.code === 0 ? "info" : "warning",
      );
    },
  });
}
