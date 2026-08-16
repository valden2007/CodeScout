"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));

// ../src/llm-client.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var GroqProvider = class {
  constructor(apiKey, model, fetcher = fetch) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetcher = fetcher;
  }
  lastRequestAt = 0;
  async review(systemPrompt, userPrompt) {
    const wait = 2e3 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetcher("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message ?? `Groq request failed with ${response.status}`);
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("Groq returned an empty response");
        return content;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(2 ** attempt * 1e3);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("LLM request failed");
  }
};
function createProvider(provider, apiKey, model) {
  if (provider.toLowerCase() !== "groq") throw new Error(`Unsupported provider: ${provider}`);
  return new GroqProvider(apiKey, model);
}

// ../src/line-numbering.ts
var HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function numberPatch(patch) {
  let newLine = 0;
  return patch.split("\n").map((line) => {
    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      newLine = Number(hunk[1]);
      return line;
    }
    if (newLine === 0 || line.startsWith("\\")) return line;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const numbered = `${newLine} | ${line}`;
      newLine += 1;
      return numbered;
    }
    if (line.startsWith(" ")) {
      const numbered = `${newLine} | ${line}`;
      newLine += 1;
      return numbered;
    }
    if (line.startsWith("-") && !line.startsWith("---")) return line;
    return line;
  }).join("\n");
}

// ../src/prompt-builder.ts
var SYSTEM_PROMPT = `You are a senior software engineer performing a focused pull request review. Identify only actionable defects introduced by the patch. Do not report preferences or pre-existing issues. Prioritize correctness, security, data loss, reliability, and performance.

DO NOT flag:
- Standard ORM ID generation such as cuid() or uuid() as a security issue.
- Missing try-catch in seed or migration files; these are one-off scripts.
- Missing error logging when a .catch() handler handles the error gracefully.
- Next.js singleton patterns such as \`globalThis as unknown as { prisma: PrismaClient }\`.
- Standard Next.js API route structures such as \`export async function GET\` or \`POST\`.
- Next.js middleware patterns.
- Standard Next.js fetch patterns with proper error handling.
- Using .reverse() on small arrays; flag it only when N > 10000 or in a hot path.
- CSRF protection in Next.js apps; it is handled by the Next.js framework.
- Debouncing controlled inputs in React; this is a normal pattern.
- Null checks on NextAuth session.user; the framework guarantees an authenticated session user.
- Null checks on values that TypeScript already guards.
BE LENIENT on:
- console.error in small projects, unless it clearly logs secrets.
- React fetch patterns that include proper .catch() handling.

Report at most 3 issues per file, and include only the most important findings. Precision over recall: if unsure whether something is a real problem, do NOT flag it.
Category accuracy matters: security is ONLY for secrets, injection, authorization or authentication flaws, and unsafe cryptography. Performance is for indexes, caching, N+1 queries, and heavy loops. NEVER label performance or style advice as security. Do NOT suggest database indexes unless the diff clearly shows a query pattern that would be slow without the index. Do NOT flag missing logging libraries in small projects. ONLY flag when you would block a PR merge based on the issue; otherwise do NOT flag it.
Be strict on hardcoded secrets, real bugs, security vulnerabilities, division by zero, and out-of-bounds access. Only mark an issue critical when the severity is truly critical and confidence is at least 0.90; otherwise use medium or low. Seed, ORM, and migration observations should be low or omitted unless there is a concrete defect. Absolute new-file line numbers are printed on the left of each added or context line; use them EXACTLY in your answer. Always return the exact changed code snippet in the code field. Return valid JSON only with this shape: {"issues":[{"file":"string","line":1,"code":"exact code snippet","category":"bug|security|performance|maintainability|docs|style","severity":"low|medium|high|critical","description":"string","suggestion":"string","confidence":0.0}],"summary":"string"}. Line must refer to an absolute new-file line shown on the left when possible. Use an empty issues array when there is no meaningful finding.`;
function buildReviewPrompt(file, patch) {
  return `Review the following changed file from a pull request. The number before each added or context line is the absolute line number in the new file. Use that number exactly for issue.line and copy the relevant code exactly into issue.code.

File: ${file.filename}
Status: ${file.status}
Added lines: ${file.additions}; deleted lines: ${file.deletions}

Numbered patch:
---
${numberPatch(patch)}
---

Return JSON only. Keep descriptions concise and explain why the issue matters. Provide a concrete safer suggestion when one is clear.`;
}

// ../src/response-parser.ts
var categories = /* @__PURE__ */ new Set(["bug", "security", "performance", "maintainability", "docs", "style"]);
var severities = /* @__PURE__ */ new Set(["low", "medium", "high", "critical"]);
function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}
function parseReviewResponse(raw, filename) {
  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new Error(`LLM returned malformed JSON for ${filename}`);
  }
  const object = parsed;
  const rawIssues = Array.isArray(object.issues) ? object.issues : [];
  const issues = rawIssues.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item;
    const category = categories.has(value.category) ? value.category : "bug";
    const rawSeverity = severities.has(value.severity) ? value.severity : "medium";
    const description = typeof value.description === "string" ? value.description.trim() : "";
    if (!description) return [];
    const line = typeof value.line === "number" && Number.isFinite(value.line) ? Math.max(1, Math.floor(value.line)) : 1;
    const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? Math.min(1, Math.max(0, value.confidence)) : 0.7;
    const code = typeof value.code === "string" ? value.code.trim() : void 0;
    const suggestion = typeof value.suggestion === "string" ? value.suggestion.trim() : void 0;
    const categoryText = `${description} ${suggestion ?? ""}`;
    const guardedCategory = category === "security" && /index|cache|logging|performance/i.test(categoryText) ? "performance" : category;
    const severity = rawSeverity === "critical" && confidence < 0.9 ? "medium" : rawSeverity;
    return [{ file: filename, line, category: guardedCategory, severity, description, code, suggestion, confidence }];
  });
  return { issues, summary: typeof object.summary === "string" ? object.summary.trim() : "", filesAnalyzed: 1 };
}

// ../src/line-correction.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function correctIssueLine(issue, repoPath) {
  if (!issue.code?.trim()) return issue;
  try {
    const content = (0, import_node_fs.readFileSync)((0, import_node_path.join)(repoPath, issue.file), "utf8");
    const snippet = issue.code.trim();
    const matches = content.split("\n").flatMap((line, index) => line.includes(snippet) ? [index + 1] : []);
    return matches.length === 1 ? { ...issue, line: matches[0] } : issue;
  } catch {
    return issue;
  }
}

// ../src/diff-parser.ts
var IGNORED_FILE = /(^|\/)(node_modules|vendor|dist|build|\.next)(\/|$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(min\.(js|css)|map|png|jpe?g|gif|webp|ico|pdf|zip|woff2?)$/i;
function shouldReviewFile(filename) {
  return !IGNORED_FILE.test(filename);
}
function parseUnifiedDiff(diff) {
  const files = [];
  const sections = diff.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const header = section.match(/^a\/(.+?) b\/(.+?)(?:\n|$)/);
    if (!header) continue;
    const filename = header[2];
    if (!shouldReviewFile(filename)) continue;
    if (!section.match(/^\+\+\+ b\/.+$/m)) continue;
    const lines = section.split("\n");
    const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    files.push({ filename, status: section.includes("new file mode") ? "added" : section.includes("deleted file mode") ? "removed" : "modified", additions, deletions, patch: section.trim() });
  }
  return files;
}
function splitPatch(patch, maxCharacters = 45e3) {
  if (patch.length <= maxCharacters) return [patch];
  const lines = patch.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxCharacters) {
      chunks.push(current);
      current = "";
    }
    current += `${line}
`;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ../src/tui/DiffReader.ts
var import_node_child_process = require("node:child_process");
var import_node_fs2 = require("node:fs");
function validateGitPath(repoPath) {
  if (!(0, import_node_fs2.existsSync)(repoPath)) return `\u041F\u0443\u0442\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D: "${repoPath}". \u041F\u0440\u043E\u0432\u0435\u0440\u044C \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 --path.`;
  try {
    (0, import_node_child_process.execFileSync)("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return void 0;
  } catch {
    return `\u041F\u0443\u0442\u044C "${repoPath}" \u043D\u0435 \u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F Git-\u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u0435\u043C. \u0423\u043A\u0430\u0436\u0438 \u043F\u0430\u043F\u043A\u0443 \u0441 .git \u0447\u0435\u0440\u0435\u0437 --path.`;
  }
}
function runGit(args, cwd) {
  try {
    return (0, import_node_child_process.execFileSync)("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`Unable to read git diff in "${cwd}". Make sure the path is a Git repository with at least one commit.`);
  }
}
function parseGitDiff(diff) {
  return parseUnifiedDiff(diff);
}
function mergeFiles(files) {
  const merged = /* @__PURE__ */ new Map();
  for (const file of files) {
    const previous = merged.get(file.filename);
    if (!previous) {
      merged.set(file.filename, file);
      continue;
    }
    merged.set(file.filename, {
      ...file,
      additions: previous.additions + file.additions,
      deletions: previous.deletions + file.deletions,
      patch: `${previous.patch}
${file.patch}`
    });
  }
  return [...merged.values()];
}
function readGitDiff(repoPath, options = {}) {
  const validationError = validateGitPath(repoPath);
  if (validationError) throw new Error(validationError);
  runGit(["rev-parse", "--is-inside-work-tree"], repoPath);
  const git = (...args) => runGit(["-c", "color.ui=false", ...args], repoPath);
  if (options.base) return parseGitDiff(git("diff", `${options.base}...HEAD`));
  if (options.lastCommit) return parseGitDiff(git("diff", "HEAD~1"));
  const unstaged = parseGitDiff(git("diff"));
  const staged = parseGitDiff(git("diff", "--cached"));
  return mergeFiles([...unstaged, ...staged]);
}

// src/extension.ts
var MODEL = "llama-3.3-70b-versatile";
function formatIssue(issue) {
  const severity = issue.severity.toUpperCase();
  const location = `${issue.file}:${issue.line}`;
  const code = issue.code ? `
  code: ${issue.code}` : "";
  const suggestion = issue.suggestion ? `
  suggestion: ${issue.suggestion}` : "";
  return `[${severity}] ${issue.category} \xB7 ${location} \xB7 confidence ${Math.round(issue.confidence * 100)}%
  ${issue.description}${code}${suggestion}`;
}
function getWorkspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
async function reviewWorkspace(lastCommit, output) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    throw new Error("\u041E\u0442\u043A\u0440\u043E\u0439 \u043F\u0430\u043F\u043A\u0443 \u0441 Git-\u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u0435\u043C \u0432 VS Code \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438 \u043A\u043E\u043C\u0430\u043D\u0434\u0443.");
  }
  const config = vscode.workspace.getConfiguration("codescout");
  const apiKey = config.get("apiKey")?.trim() || process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D Groq API key. \u0423\u043A\u0430\u0436\u0438 codescout.apiKey \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 VS Code \u0438\u043B\u0438 GROQ_API_KEY \u0432 \u043E\u043A\u0440\u0443\u0436\u0435\u043D\u0438\u0438.");
  }
  const providerName = config.get("provider", "groq");
  const files = readGitDiff(workspaceRoot, { lastCommit });
  if (files.length === 0) return [];
  const provider = createProvider(providerName, apiKey, MODEL);
  const issues = [];
  for (const file of files) {
    for (const chunk of splitPatch(file.patch, 45e3)) {
      const raw = await provider.review(SYSTEM_PROMPT, buildReviewPrompt(file, chunk));
      const parsed = parseReviewResponse(raw, file.filename);
      issues.push(...parsed.issues.map((issue) => correctIssueLine(issue, workspaceRoot)));
    }
  }
  return issues;
}
async function runReview(lastCommit, output) {
  output.clear();
  output.show(true);
  output.appendLine(lastCommit ? "CodeScout: reviewing last commit..." : "CodeScout: reviewing uncommitted changes...");
  try {
    const issues = await reviewWorkspace(lastCommit, output);
    if (issues.length === 0) {
      output.appendLine("No issues found.");
    } else {
      output.appendLine(`${issues.length} issue${issues.length === 1 ? "" : "s"} found:`);
      output.appendLine("");
      for (const issue of issues) output.appendLine(formatIssue(issue));
    }
    void vscode.window.showInformationMessage(`CodeScout: ${issues.length} issues found`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Error: ${message}`);
    void vscode.window.showErrorMessage(`CodeScout: ${message}`);
  }
}
function activate(context) {
  const output = vscode.window.createOutputChannel("CodeScout");
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand("codescout.scanUncommitted", () => runReview(false, output)),
    vscode.commands.registerCommand("codescout.scanLastCommit", () => runReview(true, output))
  );
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
