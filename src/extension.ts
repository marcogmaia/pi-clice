/**
 * clice: C/C++ semantic queries from pi.
 *
 * Registers `clice_query`, `clice_impact` and `clice_modularize`, backed by the clice CLI, which
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
import { randomUUID } from "node:crypto";
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
const kModuleViews = ["overview", "edge", "module", "file", "interface", "obstacles", "macros", "impact"] as const;
type ModuleView = (typeof kModuleViews)[number];

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

interface ProcessOptions {
  waitForCloseOnAbort?: boolean;
}

function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  options?: ProcessOptions,
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
    let abortError: Error | undefined;
    child.on("error", (error) => {
      // Analysis owns input files that the child may still have open on AbortError.
      if (options?.waitForCloseOnAbort && signal?.aborted && error.name === "AbortError") {
        abortError = error;
      } else {
        reject(error);
      }
    });
    child.on("close", (code, exitSignal) => {
      if (abortError) {
        reject(abortError);
      } else if (code === null) {
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
  options?: ProcessOptions,
): Promise<ProcessResult> {
  try {
    return await runProcess(bin, args, cwd, signal, options);
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

// --------------------------------------------------------- module analysis

interface AnalysisRequest {
  view?: ModuleView;
  target?: string;
  to?: string;
  scope?: string[];
  dirDepth?: number;
  partition?: string | object;
  std?: string;
  moves?: string[];
  merges?: string[];
  entityMoves?: string[];
  annotations?: (string | object)[];
  churnSince?: string;
  limit?: number;
  configuration?: string;
  includeExternal?: boolean;
  fresh?: (typeof kFreshModes)[number];
}

interface ResolvedAnalysisRequest extends Omit<AnalysisRequest, "partition" | "annotations"> {
  partition?: string;
  annotations?: string[];
}

interface AnalysisAnswer {
  data?: unknown;
  error?: string;
  stale?: string[];
  parseFailed?: boolean;
}

class JsonInputWriteError extends Error {
  constructor(readonly file: string, cause: unknown) {
    super("Could not write temporary analysis input", { cause });
  }
}

function writeJsonInput(value: string | object): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  const file = path.join(os.tmpdir(), `pi-clice-${randomUUID()}.json`);
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, json);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new JsonInputWriteError(file, error);
  }
  return file;
}

function resolveInputs(request: AnalysisRequest, paths: string[] = []) {
  const resolve = (value: string | object) => {
    try {
      const file = writeJsonInput(value);
      if (typeof value !== "string") paths.push(file);
      return file;
    } catch (error) {
      // Hand any owned, partially written file to the same disposer.
      if (error instanceof JsonInputWriteError) paths.push(error.file);
      throw error;
    }
  };
  const resolved: ResolvedAnalysisRequest = {
    ...request,
    partition: request.partition === undefined ? undefined : resolve(request.partition),
    annotations: request.annotations?.map(resolve),
  };
  return { request: resolved, paths };
}

const kAnalysisRepeatedFlags = {
  scope: "--scope", moves: "--move", merges: "--merge", entityMoves: "--move-entity",
} as const;
const kAnalysisPathFlags = {
  partition: "--partition", std: "--std", configuration: "--configuration",
} as const;
const kAnalysisDirections = {
  overview: [], edge: ["target", "to"], module: ["target"], file: ["target"],
  interface: ["target"], obstacles: [], macros: [], impact: [],
} as const satisfies Record<ModuleView, readonly ("target" | "to")[]>;

function acceptsAnnotations(view: ModuleView): boolean {
  return view === "overview" || view === "file" || view === "impact";
}

export function buildAnalysisArgs(request: ResolvedAnalysisRequest, root: string): string[] {
  const view = request.view ?? "overview";
  const args = ["analyze", "modules"];
  if (view !== "overview") args.push(view);
  const flag = (name: string, value: string | number | undefined) => {
    if (value !== undefined) args.push(name, String(value));
  };
  for (const key of kAnalysisDirections[view]) {
    if (request[key] !== undefined) args.push(request[key]);
  }
  for (const key of Object.keys(kAnalysisRepeatedFlags) as (keyof typeof kAnalysisRepeatedFlags)[]) {
    for (const value of request[key] ?? []) flag(kAnalysisRepeatedFlags[key], value);
  }
  flag("--dir-depth", request.dirDepth);
  for (const key of Object.keys(kAnalysisPathFlags) as (keyof typeof kAnalysisPathFlags)[]) {
    flag(kAnalysisPathFlags[key], request[key]);
  }
  if (view === "overview") flag("--limit", request.limit);
  if (acceptsAnnotations(view)) {
    for (const file of request.annotations ?? []) flag("--annotation", file);
    flag("--churn-since", request.churnSince);
  }
  args.push("--workspace", root);
  return args;
}

export function checkAnalysisRequest(request: AnalysisRequest): string | null {
  const view = request.view ?? "overview";
  if (!kModuleViews.includes(view)) return `Unknown module analysis view: ${view}.`;
  for (const key of ["target", "to"] as const) {
    const value = request[key];
    if (!(kAnalysisDirections[view] as readonly string[]).includes(key)) {
      if (value !== undefined) return `view: ${view} does not accept ${key}.`;
    } else if (view !== "interface" || value !== undefined) {
      if (!value?.trim()) return `view: ${view} needs ${key}.`;
    }
  }
  if (!acceptsAnnotations(view)) {
    for (const key of ["annotations", "churnSince"] as const) {
      if (request[key] !== undefined) return `view: ${view} does not accept ${key}.`;
    }
  }
  for (const key of ["dirDepth", "limit"] as const) {
    if (badCount(request[key])) return `${key} must be a whole number, 0 or more.`;
  }
  for (const [key, values] of Object.entries({
    target: [request.target], to: [request.to], partition: [request.partition], std: [request.std],
    configuration: [request.configuration], churnSince: [request.churnSince],
    scope: request.scope, moves: request.moves, merges: request.merges,
    entityMoves: request.entityMoves, annotations: request.annotations,
  })) {
    if (values?.some((value) => typeof value === "string" && value.trimStart().startsWith("-"))) {
      return `${key} values may not start with \`-\`.`;
    }
  }
  return null;
}

export function parseAnalysis(result: ProcessResult): AnalysisAnswer {
  const text = result.stdout.trim();
  const unreadable = () => ({
    error: `unreadable clice output${text ? `: ${text.slice(0, 300)}` : ""}`,
    parseFailed: true,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable();
  }
  if (!parsed || typeof parsed !== "object") return unreadable();
  const { error, stale } = parsed as { error?: unknown; stale?: unknown };
  const stalePaths = Array.isArray(stale) ? stale.filter((file): file is string => typeof file === "string") : undefined;
  if (typeof error === "string" && error.length > 0) return { error, stale: stalePaths };
  if (result.code !== 0) return { ...unreadable(), stale: stalePaths };
  return { data: parsed };
}

function runAnalysis(bin: string, args: string[], root: string, signal?: AbortSignal): Promise<ProcessResult> {
  return safeRun(bin, args, root, signal, { waitForCloseOnAbort: true });
}

async function cliceModularizeFresh(
  bin: string, root: string, fresh: AnalysisRequest["fresh"], signal?: AbortSignal,
): Promise<string | undefined> {
  if (fresh !== "always") return;
  const result = await safeRun(bin, ["query", "project-files", "--fresh", "--workspace", root], root, signal);
  const answer = parseAnswer(result);
  if (result.code === 0 && !answer.parseFailed) return;
  return answer.error ?? `clice exited with code ${result.code}`;
}

// ---------------------------------------------------- module analysis text

const kAnalysisBudget = kMaxChars - 1;
const kOmittedSections = "(sections omitted to fit; narrow with scope or a lower limit)";
const kObstacleKeys = [
  "variantHeaders", "contextMacros", "borrowedMacros", "internalUses",
  "crossModuleRedeclarations", "foreignDeclarations", "splitDefinitions", "duplicateDefinitions",
  "configuringMacros", "implicitProviders", "specializations",
] as const;
type ObstacleKey = (typeof kObstacleKeys)[number];

interface ModuleCost {
  path: string;
  baseline: number;
  partitioned: number;
  churn: number;
  internal: boolean;
}

interface ModuleEntry {
  name: string;
  headers: number;
  sources: number;
  lines: number;
  layer: number;
}

interface OverviewAnswer {
  files: number;
  modules: ModuleEntry[];
  edges: { interfaceEntities: number }[];
  cycles: { modules: string[]; cut: { from: string; to: string; entities: number }[] }[];
  cyclicModules: number;
  partitionCycles: object[];
  internalHeaders: number;
  deepestChain: string[];
  totals: { baseline: number; partitioned: number };
  hotspots: ModuleCost[];
  moves: { path: string; from: string; to: string; with: string[]; entities: number }[];
  splits: { path: string; parts: { count: number }[] }[];
  obstacles: Partial<Record<ObstacleKey, number>>;
}

interface AnalysisBlock {
  rows: string[];
  hidden: number;
  outside: number;
  format: (rows: string[], tail: string[]) => string;
  section?: "splits" | "moves" | "hotspots";
}

function analysisExternal(root: string, request: AnalysisRequest, value: string): boolean {
  return !request.includeExternal && (isExternalPath(root, value) ||
    relativeToRoot(root, value).split("/").some((segment) => segment === "build" || /^\..+/.test(segment)));
}

function analysisRows<T>(
  items: readonly T[], cap: number, render: (item: T) => string,
  external: (item: T) => boolean = () => false,
  format: AnalysisBlock["format"] = (rows, tail) => [...rows, ...tail].join("\n"),
): AnalysisBlock {
  const visible = items.filter((item) => !external(item));
  const shown = visible.slice(0, cap);
  return { rows: shown.map(render), hidden: visible.length - shown.length, outside: items.length - visible.length, format };
}

function analysisLine(line: string): AnalysisBlock {
  return analysisRows([line], 1, (value) => value);
}

function renderAnalysisBlock(block: AnalysisBlock, count = block.rows.length): string {
  const hidden = block.hidden + block.rows.length - count;
  const tail = [];
  if (block.outside) tail.push(`(+${block.outside} outside the project)`);
  if (hidden) tail.push(`(+${hidden} hidden)`);
  return block.format(block.rows.slice(0, count), tail);
}

function fitAnalysisBlocks(blocks: AnalysisBlock[], budget: number): string {
  const entries = blocks.map((block) => ({ block, text: renderAnalysisBlock(block) }));
  let note = "";
  const join = () => [...entries.map(({ text }) => text), note].filter(Boolean).join("\n");
  for (const section of ["splits", "moves", "hotspots"] as const) {
    if (join().length <= budget) break;
    const index = entries.findIndex(({ block }) => block.section === section);
    if (index !== -1) {
      entries.splice(index, 1);
      note = kOmittedSections;
    }
  }
  // Preserve whole records. Shed tails from the bottom, retaining the count on each list.
  for (let i = entries.length - 1; i >= 0 && join().length > budget; i--) {
    const entry = entries[i];
    if (!entry.block.rows.length) continue;
    let low = 0;
    let high = entry.block.rows.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      entry.text = renderAnalysisBlock(entry.block, mid);
      if (join().length <= budget) low = mid;
      else high = mid - 1;
    }
    entry.text = renderAnalysisBlock(entry.block, low);
  }
  return join();
}

function pct(part: number, whole: number): number {
  return whole ? Math.round(100 * part / whole) : 0;
}

function ratio(partitioned: number, baseline: number): string {
  if (partitioned === baseline) return "x1.0 unchanged";
  if (baseline === 0) return "ratio unavailable (zero baseline)";
  return `x${(partitioned / baseline).toFixed(1)} ${partitioned > baseline ? "worse" : "cheaper"}`;
}

function moduleLine(root: string, entry: ModuleEntry): string {
  return `layer ${entry.layer}  ${relativeToRoot(root, entry.name)}  h${entry.headers}  s${entry.sources}  ${entry.lines} lines`;
}

function orderedObstacles<T>(obstacles: Partial<Record<ObstacleKey, T>>, count: (value: T) => number) {
  return kObstacleKeys.flatMap((key) => {
    const value = obstacles[key];
    return value === undefined || !count(value) ? [] : [{ key, value, count: count(value) }];
  }).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function renderOverview(
  root: string, data: OverviewAnswer, request: AnalysisRequest, budget = kAnalysisBudget,
): string {
  const limit = request.limit ?? 20;
  const rel = (file: string) => relativeToRoot(root, file);
  const outside = (file: string) => analysisExternal(root, request, file);
  const inProject = data.modules.filter(({ name }) => !analysisExternal(root, {}, name)).length;
  const moduleSummary = `modules ${data.modules.length}  (${inProject} in-project, ${data.modules.length - inProject} outside the project)`;
  const cycleRows = analysisRows(data.cycles, 5, ({ modules, cut }) => {
    const cuts = cut.map(({ from, to, entities }) => `cut ${rel(from)} -> ${rel(to)} (${entities} entities)`);
    return `            ${modules.map(rel).join(" <-> ")}${cuts.length ? `  ${cuts.join(", ")}` : ""}`;
  }, ({ modules, cut }) => modules.some(outside) || cut.some(({ from, to }) => outside(from) || outside(to)));
  const layers = analysisRows([...data.modules].sort((a, b) => b.layer - a.layer || b.lines - a.lines), 12,
    (entry) => moduleLine(root, entry), ({ name }) => outside(name));
  const section = <T>(
    name: NonNullable<AnalysisBlock["section"]>, items: T[], render: (item: T) => string,
    external: (item: T) => boolean,
  ): AnalysisBlock => ({
    ...analysisRows(items, limit, (item) => `  ${render(item)}`, external,
      (rows, tail) => [`${name} (${name === "hotspots" ? `limit ${limit}` : items.length})`, ...rows, ...tail].join("\n")),
    section: name,
  });
  const hotspots = [...data.hotspots].sort((a, b) => b.churn * b.partitioned - a.churn * a.partitioned);
  const { baseline, partitioned } = data.totals;
  const proposed = request.partition !== undefined || Boolean(
    request.moves?.length || request.merges?.length || request.entityMoves?.length,
  );
  const costLabel = proposed ? "with the proposed partition" : "if grouped by folder";
  const cycleHeading = `cycles      ${data.cyclicModules} modules in a cycle, ${data.partitionCycles.length} inside a single module`;
  cycleRows.format = (rows, tail) => {
    const details = [...rows];
    // Fit all five rows without pushing cost past line 10.
    const head = details.length === 5 ? `${cycleHeading}  ${details.shift()!.trimStart()}` : cycleHeading;
    const lines = [head, ...details];
    if (tail.length) lines[lines.length - 1] += `  ${tail.join(" ")}`;
    return lines.join("\n");
  };
  return fitAnalysisBlocks([
    analysisLine(`${moduleSummary}  files ${data.files}  edges ${data.edges.length}`),
    analysisLine(`crossings   ${data.edges.length} edges, ${data.edges.reduce((sum, edge) => sum + edge.interfaceEntities, 0)} interface entities`),
    cycleRows,
    analysisRows(data.deepestChain, Infinity, (step) => step, () => false, (rows, tail) =>
      `chain       ${data.deepestChain.length} deep: ${[rows.join(" > "), ...tail].filter(Boolean).join(" ")}`),
    analysisLine(`shape       ${data.internalHeaders} internal headers, ${data.splits.length} split candidates, ${data.moves.length} move candidates`),
    analysisLine(`cost        rebuild units ${baseline} today -> ${partitioned} ${costLabel}   (${ratio(partitioned, baseline)})`),
    analysisLine("---------------------------------------------------------------------"),
    layers,
    section("hotspots", hotspots,
      (item) => `${rel(item.path)}  ${item.baseline} -> ${item.partitioned} rebuild units  ${item.churn} commits`,
      (item) => outside(item.path)),
    section("moves", data.moves,
      (item) => `${rel(item.path)}  from ${rel(item.from)} to ${rel(item.to)}  +${item.with.length} files, ${item.entities} entities`,
      (item) => [item.path, item.from, item.to].some(outside)),
    section("splits", data.splits,
      (item) => `${rel(item.path)}  ${item.parts.length} groups (${item.parts.map(({ count }) => count).join(" / ")} entities by consumer)`,
      (item) => outside(item.path)),
    analysisLine(`obstacles  ${orderedObstacles(data.obstacles, (value) => value).map(({ key, count }) => `${count} ${key}`).join(", ")}`.trimEnd()),
  ], budget);
}

interface ModuleLinks<T> {
  module: string;
  entities: T;
}

interface ModuleAnswer {
  name: string;
  files: { path: string; source: boolean; uses: ModuleLinks<number>[]; usedBy: ModuleLinks<number>[] }[];
  groups: { consumers: string[]; headers: string[]; dependsOn: string[] }[];
  internalHeaders: string[];
}

interface ModuleFileAnswer {
  path: string;
  module: string;
  source: boolean;
  annotations: { name: string; unit: string; value: number }[];
  uses: ModuleLinks<string[]>[];
  usedBy: ModuleLinks<string[]>[];
  affinity: ModuleLinks<number>[];
}

interface EdgeAnswer {
  from: string;
  to: string;
  entities: { entity: string; owner: string; users: string[] }[];
}

interface InterfaceAnswer {
  module: string;
  imports: string[];
  entries: { file: string; names: string[]; include: string }[];
  exports: unknown[];
  textual: unknown[];
  sharedLocals: unknown[];
  macros: unknown[];
  reads: unknown[];
}

type ObstacleAnswer = Partial<Record<ObstacleKey, unknown[]>> & {
  internalUses?: { entity: string; owner: string; reason: string }[];
  implicitProviders?: { path: string; specializes: string[] }[];
};

function inlineAnalysis(rows: string[], tail: string[]): string {
  return [rows.join(", "), ...tail].filter(Boolean).join(" ");
}

function analysisNames(root: string, request: AnalysisRequest, items: string[], cap = Infinity): string {
  return renderAnalysisBlock(analysisRows(items, cap, (item) => relativeToRoot(root, item),
    (item) => analysisExternal(root, request, item), inlineAnalysis));
}

export function renderModuleView(
  root: string, data: ModuleAnswer, request: AnalysisRequest, budget = kAnalysisBudget,
): string {
  const outside = (file: string) => analysisExternal(root, request, file);
  const links = (items: ModuleLinks<number>[]) => renderAnalysisBlock(analysisRows(items, Infinity,
    ({ module, entities }) => `${relativeToRoot(root, module)}(${entities})`, ({ module }) => outside(module), inlineAnalysis));
  return fitAnalysisBlocks([
    analysisRows(data.groups, Infinity, ({ consumers, headers }) =>
      `${consumers.length} consumers: ${analysisNames(root, request, headers, 8)}  (${analysisNames(root, request, consumers)})`),
    analysisRows(data.internalHeaders, Infinity, (file) => relativeToRoot(root, file), outside,
      (rows, tail) => `internal headers: ${inlineAnalysis(rows, tail) || "none"}`),
    analysisRows(data.files, 40, (file) =>
      `${relativeToRoot(root, file.path)}  uses: ${links(file.uses) || "none"}  used by: ${links(file.usedBy) || "none"}`,
    ({ path }) => outside(path)),
  ], budget);
}

export function renderFileView(
  root: string, data: ModuleFileAnswer, request: AnalysisRequest, budget = kAnalysisBudget,
): string {
  const rel = (file: string) => relativeToRoot(root, file);
  const total = data.affinity.reduce((sum, { entities }) => sum + entities, 0);
  const moduleList = <T>(
    label: string, items: ModuleLinks<T>[], render: (item: ModuleLinks<T>) => string,
  ): AnalysisBlock => {
    const block = analysisRows(items, 5, render, ({ module }) => analysisExternal(root, request, module));
    block.format = (rows, tail) => {
      const hidden = block.hidden + block.rows.length - rows.length;
      const more = hidden ? [`(+${hidden} module${hidden === 1 ? "" : "s"})`] : [];
      return `${label}${inlineAnalysis(rows, [...more, ...tail]) || "none"}`;
    };
    return block;
  };
  const uses = [...data.uses].sort((a, b) => b.entities.length - a.entities.length);
  const affinity = [...data.affinity].sort((a, b) => b.entities - a.entities);
  return fitAnalysisBlocks([
    analysisLine(`${rel(data.path)}   in ${rel(data.module)}   (${data.source ? "source" : "header"})`),
    moduleList("uses          ", uses, ({ module, entities }) => `${rel(module)} ${entities.length}`),
    moduleList("used by       ", data.usedBy, ({ module }) => rel(module)),
    moduleList("affinity      ", affinity, ({ module, entities }) => `${rel(module)} ${entities} (${pct(entities, total)}%)`),
    analysisRows(data.annotations, Infinity, ({ name, value, unit }) => `${name} ${value} ${unit}`.trimEnd(),
      () => false, (rows, tail) => `annotations  ${inlineAnalysis(rows, tail) || "none"}`),
  ], budget);
}

export function renderEdgeView(
  root: string, data: EdgeAnswer, request: AnalysisRequest, budget = kAnalysisBudget,
): string {
  const rel = (file: string) => relativeToRoot(root, file);
  const site = (value: string) => /^(.*)(:\d+)$/.exec(value);
  const entities = [...data.entities].sort((a, b) => b.users.length - a.users.length);
  return fitAnalysisBlocks([
    analysisLine(`${rel(data.from)} -> ${rel(data.to)}  (${rel(data.from)} names ${rel(data.to)}'s entities)`),
    analysisRows(entities, 40, ({ entity, owner, users }) => {
      const sites = renderAnalysisBlock(analysisRows(users, 2, (value) => {
        const match = site(value);
        return match ? `${rel(match[1])}${match[2]}` : rel(value);
      }, (value) => analysisExternal(root, request, site(value)?.[1] ?? value), inlineAnalysis));
      return `${entity}  ${rel(owner)}  ${users.length} uses${sites ? `  ${sites}` : ""}`;
    }, ({ owner }) => analysisExternal(root, request, owner)),
  ], budget);
}

export function renderInterface(
  root: string, data: InterfaceAnswer[], request: AnalysisRequest, budget = kAnalysisBudget,
): string {
  const outside = (file: string) => analysisExternal(root, request, file);
  const renderModule = (item: InterfaceAnswer) => {
    const imports = analysisNames(root, request, item.imports, 5);
    const entries = renderAnalysisBlock(analysisRows(item.entries, 15, ({ names, include }) => {
      const spelling = /^[<"]/.test(include) ? include : `<${include}>`;
      return `  ${names.join(", ")}  ${spelling}`;
    }, ({ file }) => outside(file)));
    return [
      relativeToRoot(root, item.module),
      `imports (${item.imports.length})${imports ? `: ${imports}` : ""}`,
      `entries (${item.entries.length})`, entries, `exports ${item.exports.length}`, `textual (${item.textual.length})`,
      `shared locals (${item.sharedLocals.length})`, `macros (${item.macros.length})`, `reads (${item.reads.length})`,
    ].filter(Boolean).join("\n");
  };
  let empty = 0;
  const substantive = data.filter((item) => {
    if (item.entries.length || item.imports.length || outside(item.module)) return true;
    empty++;
    return false;
  });
  // Empty modules described by the summary do not consume the detail cap.
  const blocks = [analysisRows(substantive, 12, renderModule, ({ module }) => outside(module))];
  if (empty) blocks.push(analysisLine(`${empty} module(s) with no entries or imports`));
  if (!data.length) blocks.push(analysisLine("0 modules"));
  return fitAnalysisBlocks(blocks, budget);
}

export function renderObstacles(
  root: string, data: ObstacleAnswer, request: AnalysisRequest, budget = kAnalysisBudget,
): string {
  const keys = kObstacleKeys.filter((key) => Object.hasOwn(data, key));
  if (!keys.length || keys.some((key) => !Array.isArray(data[key]))) {
    throw new TypeError("Expected obstacle arrays");
  }
  const limit = request.limit ?? 20;
  const outside = (file: string) => analysisExternal(root, request, file);
  const rel = (file: string) => relativeToRoot(root, file);
  const blocks = orderedObstacles(data, (items) => items.length).map(({ key, count }) => {
    const title = `${key} (${count})`;
    const format: AnalysisBlock["format"] = (rows, tail) => [title, ...rows, ...tail].join("\n");
    if (key === "internalUses") {
      return analysisRows(data.internalUses!, limit, ({ entity, owner, reason }) => `  ${entity}  ${rel(owner)}  ${reason}`,
        ({ owner }) => outside(owner), format);
    }
    if (key === "implicitProviders") {
      return analysisRows(data.implicitProviders!, limit, ({ path, specializes }) => `  ${rel(path)}  specializes: ${specializes.join(", ")}`,
        ({ path }) => outside(path), format);
    }
    return analysisLine(title);
  });
  return fitAnalysisBlocks(blocks.length ? blocks : [analysisLine("No obstacles")], budget);
}

export function renderMacros(root: string, data: unknown[], request: AnalysisRequest, budget = kAnalysisBudget): string {
  const summaryValue = (value: unknown): unknown => {
    // Treat only unmistakable absolute paths as paths, without guessing macro keys.
    if (typeof value === "string" && (path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value))) {
      return analysisExternal(root, request, value) ? "(+1 outside the project)" : relativeToRoot(root, value);
    }
    if (Array.isArray(value)) return value.map(summaryValue);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, summaryValue(child)]));
    }
    return value;
  };
  return fitAnalysisBlocks([
    analysisLine(`${data.length} crossing macro(s)`),
    analysisRows(data, request.limit ?? 5, (item) => {
      if (!item || typeof item !== "object") return `  ${JSON.stringify(summaryValue(item))}`;
      const fields = Object.entries(item).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(summaryValue(value))}`);
      return `  ${fields.length ? fields.join(", ") : JSON.stringify(item)}`;
    }),
  ], budget);
}

export function renderModuleImpact(
  root: string, data: ModuleCost[], request: AnalysisRequest, budget = kAnalysisBudget,
): string {
  const delta = ({ baseline, partitioned }: ModuleCost) => partitioned - baseline;
  const items = [...data].sort((a, b) => delta(b) - delta(a));
  return fitAnalysisBlocks([
    analysisRows(items, Math.min(request.limit ?? 40, 40), (item) => {
      const difference = delta(item);
      return `${relativeToRoot(root, item.path)}  ${item.baseline} -> ${item.partitioned}  (${difference >= 0 ? "+" : ""}${difference})${item.internal ? " [internal]" : ""}`;
    }, ({ path }) => analysisExternal(root, request, path)),
    ...(items.length ? [] : [analysisLine("0 files")]),
  ], budget);
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

function diagnosticText(value: string, max = 500): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length <= max ? text : `${text.slice(0, max)} (+${text.length - max} characters hidden)`;
}

function renderAnalysisData(root: string, data: unknown, request: AnalysisRequest, budget: number): string {
  const view = request.view ?? "overview";
  if (view === "impact" || view === "interface" || view === "macros") {
    if (!Array.isArray(data)) throw new TypeError("Expected an analysis array");
    if (view === "impact") return renderModuleImpact(root, data, request, budget);
    if (view === "interface") return renderInterface(root, data, request, budget);
    return renderMacros(root, data, request, budget);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("Expected an analysis object");
  switch (view) {
    case "overview": return renderOverview(root, data as OverviewAnswer, request, budget);
    case "edge": return renderEdgeView(root, data as EdgeAnswer, request, budget);
    case "module": return renderModuleView(root, data as ModuleAnswer, request, budget);
    case "file": return renderFileView(root, data as ModuleFileAnswer, request, budget);
    case "obstacles": return renderObstacles(root, data as ObstacleAnswer, request, budget);
  }
}

async function executeModularize(cwd: string, request: AnalysisRequest, signal?: AbortSignal) {
  if (signal?.aborted) return fail("Cancelled");
  const issue = checkAnalysisRequest(request);
  if (issue) return fail(diagnosticText(issue));
  const bin = resolveBinary();
  if (!bin) return fail(missingBinaryText());
  const root = findWorkspaceRoot(cwd) ?? path.resolve(cwd);
  const view = request.view ?? "overview";
  const paths: string[] = [];
  try {
    try {
      const { request: resolved } = resolveInputs(request, paths);
      const refreshError = await cliceModularizeFresh(bin, root, request.fresh, signal);
      if (signal?.aborted) return fail("Cancelled");
      const result = await runAnalysis(bin, buildAnalysisArgs(resolved, root), root, signal);
      if (signal?.aborted) return fail("Cancelled");
      const answer = parseAnalysis(result);
      const warning = refreshError ? `\nwarning: index refresh failed (${diagnosticText(refreshError)}).` : "";
      const budget = kAnalysisBudget - warning.length;
      const stale = answer.stale ?? [];
      const details = { view, root, code: result.code, refreshed: request.fresh === "always" && !refreshError, stale };
      const respond = (body: string, isError: boolean) => ({
        content: [{ type: "text" as const, text: body + warning }], details, isError,
      });
      if (!answer.error && result.code === 0) {
        try {
          return respond(renderAnalysisData(root, answer.data, request, budget), false);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          return respond(`unreadable clice output: ${result.stdout.slice(0, 300)}`, true);
        }
      }
      const message = answer.error ?? `clice exited with code ${result.code}`;
      const isNegative = result.code === 1 && !answer.parseFailed;
      const blocks: AnalysisBlock[] = [];
      if (result.code === 2 && /unknown subcommand/i.test(`${message}\n${result.stderr.slice(0, 500)}`)) {
        const version = await safeRun(bin, ["--version"], root, signal);
        if (signal?.aborted) return fail("Cancelled");
        const detected = /clice-io\.clice-[0-9.]+/.exec(bin)?.[0];
        const label = (version.code === 0 && diagnosticText(version.stdout, 120)) || detected || "version unknown";
        blocks.push(analysisLine(`This clice binary is too old for analyze modules (${label}): ${diagnosticText(bin)}.`));
      } else if (answer.parseFailed) {
        const reason = result.code === -1 && result.stderr ? ` (${diagnosticText(result.stderr)})` : "";
        blocks.push(analysisLine(`${message}${reason}`));
      } else {
        blocks.push(analysisLine(`clice: ${diagnosticText(message)}`));
        if (isNegative) {
          if (view === "module" || view === "edge" || view === "interface") {
            blocks.push(analysisLine("Hint: module names come from view: overview."));
          } else if (view === "file") {
            blocks.push(analysisLine("Hint: pass a path relative to the project root."));
          }
        } else if (result.code === 2) {
          blocks.push(analysisLine(`Check the configuration and index; use clice index with the resolved binary: ${diagnosticText(bin)}.`));
        }
      }
      if (stale.length) {
        blocks.push(analysisRows(stale, Infinity, (file) => relativeToRoot(root, file),
          (file) => analysisExternal(root, request, file),
          (rows, tail) => `stale: ${stale.length} index unit(s) missing: ${inlineAnalysis(rows, tail)}`));
      }
      return respond(fitAnalysisBlocks(blocks, budget), !isNegative);
    } finally {
      let cleanupError: unknown;
      for (const file of paths) {
        try {
          fs.rmSync(file, { force: true });
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError) throw cleanupError;
    }
  } catch (error) {
    return fail(`clice module analysis failed: ${diagnosticText(error instanceof Error ? error.message : String(error))}`);
  }
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

const modularizePromptSnippet =
  "Survey a C++ project's module shape: crossings, cycles, split and move candidates, rebuild cost";
const modularizePromptGuidelines = [
  "Start with clice_modularize view overview: it prints what it costs to understand the project and what a rebuild costs today versus grouped by folder. If the second number is higher, do not propose that grouping.",
  "Test a structure before editing anything: pass partition, moves, merges or entityMoves and the answer measures the hypothetical. No file changes.",
  "Drill with view module (each group is a line the folder splits along), view file (affinity ranks modules by total coupling with the file, in both directions) and view edge (the entities that cut a cycle).",
  "clice_modularize never writes. Turning code into importable modules is a separate, destructive step a person runs; clear view obstacles first.",
  'After editing sources, pass fresh: "always" - analyses read a saved copy of the project.',
];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (findWorkspaceRoot(ctx.cwd)) return;
    const active = pi.getActiveTools();
    const remaining = active.filter((name) => name !== "clice_query" && name !== "clice_impact" && name !== "clice_modularize");
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

  const jsonInput = Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())]);
  pi.registerTool({
    name: "clice_modularize",
    label: "clice Modularize Analysis",
    description: "Analyze C++ module boundaries and hypothetical partitions with clice: Reads a saved index; never writes and never runs `clice modularize`.",
    promptSnippet: modularizePromptSnippet,
    promptGuidelines: modularizePromptGuidelines,
    parameters: Type.Object({
      view: Type.Optional(enumField(kModuleViews, "Module analysis view (default overview).")),
      target: Type.Optional(Type.String({ description: "Module name for edge and module, path for file, optional module for interface; rejected otherwise." })),
      to: Type.Optional(Type.String({ description: "Required for edge only: the module whose entities target names." })),
      scope: Type.Optional(Type.Array(Type.String(), { description: "Globs relative to the workspace root." })),
      dirDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Default module directory depth; 0 means the whole directory (default)." })),
      partition: Type.Optional(jsonInput),
      std: Type.Optional(Type.String({ description: "libc++ module sources directory." })),
      moves: Type.Optional(Type.Array(Type.String(), { description: "Hypothetical <path>=<module> assignments." })),
      merges: Type.Optional(Type.Array(Type.String(), { description: "Hypothetical <module>+<module>[+...] merges." })),
      entityMoves: Type.Optional(Type.Array(Type.String(), { description: "Hypothetical <locator>=<header> moves." })),
      annotations: Type.Optional(Type.Array(jsonInput, { description: "Annotation file paths or inline objects; overview, file and impact only." })),
      churnSince: Type.Optional(Type.String({ description: "git log --since value; empty disables churn. Overview, file and impact only." })),
      limit: Type.Optional(Type.Integer({ minimum: 0, description: "Cap overview candidates (default 20) or detail for impact, obstacles and macros." })),
      configuration: Type.Optional(Type.String({ description: "Build configuration tag." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Show external paths in lists rather than only counting them (default false)." })),
      fresh: Type.Optional(enumField(kFreshModes, '"off" (default) and "auto" read the saved index; "always" re-reads changed files first.')),
    }, { additionalProperties: false }),
    execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeModularize(ctx.cwd, params, signal);
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
