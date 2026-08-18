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
var vscode2 = __toESM(require("vscode"));

// ../src/providers.ts
var PROVIDERS = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    defaultModel: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey"
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com"
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-4o-mini",
    keyUrl: "https://openrouter.ai/keys"
  },
  github: {
    baseUrl: "https://models.inference.ai.azure.com",
    envKey: "GITHUB_TOKEN",
    defaultModel: "gpt-4o-mini",
    keyUrl: "https://github.com/settings/tokens"
  }
};
function normalizeProvider(provider) {
  const value = provider?.trim().toLowerCase() || "gemini";
  if (value === "custom") return "custom";
  if (value in PROVIDERS) return value;
  throw new Error(`\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 provider: ${provider}. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439 gemini, groq, openrouter, github \u0438\u043B\u0438 custom.`);
}
function resolveApiKey(provider, explicitKey, env2 = process.env) {
  if (explicitKey?.trim()) return explicitKey.trim();
  const normalized = normalizeProvider(provider);
  if (normalized === "custom") return env2.CODESCOUT_API_KEY?.trim();
  return env2[PROVIDERS[normalized].envKey]?.trim();
}
function resolveApiKeyPriority(secretKey, provider, legacySetting, env2 = process.env) {
  return secretKey?.trim() || resolveApiKey(provider, void 0, env2) || legacySetting?.trim() || void 0;
}
function resolveBaseUrl(provider, customBaseUrl) {
  if (customBaseUrl?.trim()) return customBaseUrl.trim().replace(/\/+$/, "");
  const normalized = normalizeProvider(provider);
  if (normalized === "custom") throw new Error("\u0414\u043B\u044F provider custom \u0443\u043A\u0430\u0436\u0438 --base-url \u0438\u043B\u0438 CODESCOUT_BASE_URL.");
  return PROVIDERS[normalized].baseUrl;
}
function defaultModel(provider) {
  const normalized = normalizeProvider(provider);
  return normalized === "custom" ? "" : PROVIDERS[normalized].defaultModel;
}
function keyUrl(provider) {
  const normalized = normalizeProvider(provider);
  return normalized === "custom" ? "https://docs.ollama.com" : PROVIDERS[normalized].keyUrl;
}
function completionUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}
function maskApiKey(key) {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 3) return `\u2022\u2022\u2022${trimmed}`;
  const prefix = trimmed.length >= 7 ? trimmed.slice(0, 4) : "";
  return `${prefix}\u2022\u2022\u2022${trimmed.slice(-3)}`;
}

// ../src/llm-client.ts
var RateLimitError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
  }
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var RETRY_DELAYS_SECONDS = [15, 30, 60];
function parseRetryAfterSeconds(response, message) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  }
  const match = message.match(/try\s+again\s+in\s+(\d+(?:\.\d+)?)\s*s?/i);
  if (match) return Math.ceil(Number.parseFloat(match[1]));
  return void 0;
}
function finalRateLimitMessage(model, waitSeconds) {
  const minutes = Math.max(1, Math.ceil((waitSeconds ?? 60) / 60));
  return `\u26A0\uFE0F \u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u043B\u0438\u043C\u0438\u0442 \u043C\u043E\u0434\u0435\u043B\u0438 ${model}.
\u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 ${minutes} \u043C\u0438\u043D\u0443\u0442 \u0438\u043B\u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0434\u0440\u0443\u0433\u0443\u044E \u043C\u043E\u0434\u0435\u043B\u044C.
\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u043B\u0438\u043C\u0438\u0442: tokens per day`;
}
var OpenAICompatibleProvider = class {
  constructor(apiKey, model, fetcher = fetch, sleeper = sleep, onRetry, baseUrl = "https://api.groq.com/openai/v1") {
    this.apiKey = apiKey;
    this.model = model;
    this.fetcher = fetcher;
    this.sleeper = sleeper;
    this.onRetry = onRetry;
    this.endpoint = completionUrl(baseUrl);
  }
  lastRequestAt = 0;
  endpoint;
  async review(systemPrompt, userPrompt) {
    const wait = 2e3 - (Date.now() - this.lastRequestAt);
    if (wait > 0) await this.sleeper(wait);
    let retryCount = 0;
    let lastRateLimit;
    while (true) {
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetcher(this.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, temperature: 0.1, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] })
        });
        const data = await response.json();
        if (!response.ok) {
          const details = data.error?.message ?? `LLM request failed with ${response.status}`;
          if (response.status === 429) {
            const waitSeconds = parseRetryAfterSeconds(response, details);
            throw new RateLimitError(JSON.stringify({ waitSeconds, details }));
          }
          throw new Error(details);
        }
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("LLM returned an empty response");
        return content;
      } catch (error) {
        if (!(error instanceof RateLimitError)) throw error;
        let parsed = {};
        try {
          parsed = JSON.parse(error.message);
        } catch {
        }
        lastRateLimit = { waitSeconds: parsed.waitSeconds, details: parsed.details ?? "" };
        if (retryCount >= RETRY_DELAYS_SECONDS.length) {
          throw new RateLimitError(finalRateLimitMessage(this.model, lastRateLimit.waitSeconds));
        }
        retryCount += 1;
        const waitSeconds = lastRateLimit.waitSeconds ?? RETRY_DELAYS_SECONDS[retryCount - 1];
        this.onRetry?.({ attempt: retryCount, maxRetries: RETRY_DELAYS_SECONDS.length, waitSeconds });
        await this.sleeper(waitSeconds * 1e3);
      }
    }
  }
};
function createProvider(provider, apiKey, model, onRetry, baseUrl) {
  const normalized = normalizeProvider(provider);
  const resolvedBaseUrl = resolveBaseUrl(normalized, baseUrl);
  return new OpenAICompatibleProvider(apiKey, model, fetch, sleep, onRetry, resolvedBaseUrl);
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

// src/panel.ts
var vscode = __toESM(require("vscode"));

// src/reportHtml.ts
var severityOrder = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function severityLabel(severity) {
  return severity.toUpperCase();
}
function severityEmoji(severity) {
  if (severity === "critical" || severity === "high") return "\u{1F534}";
  if (severity === "medium") return "\u{1F7E1}";
  return "\u{1F7E2}";
}
function severityClass(severity) {
  if (severity === "critical" || severity === "high") return "critical";
  return severity;
}
function issueCard(issue) {
  const severity = severityClass(issue.severity);
  const code = issue.code ? `<pre><code>${escapeHtml(issue.code)}</code></pre>` : "";
  const suggestion = issue.suggestion ? `<div class="suggestion"><span>\u2192</span> ${escapeHtml(issue.suggestion)}</div>` : "";
  return `<article class="issue-card ${severity}">
  <div class="issue-top"><span class="badge ${severity}">${severityEmoji(issue.severity)} ${severityLabel(issue.severity)}</span><span class="category">${escapeHtml(issue.category)}</span><span class="confidence">${Math.round(issue.confidence * 100)}%</span></div>
  <div class="location">${escapeHtml(issue.file)}:${issue.line}</div>
  <div class="description">${escapeHtml(issue.description)}</div>
  ${code}
  ${suggestion}
</article>`;
}
function buildReportHtml(issues, stats, isScanning = false, emptyState = false, statusMessage = "", statusKind = "retry", keyMask = "", keyConfigured = false) {
  const sorted = [...issues].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const grouped = /* @__PURE__ */ new Map();
  for (const issue of sorted) grouped.set(issue.file, [...grouped.get(issue.file) ?? [], issue]);
  const sections = [...grouped.entries()].map(([file, fileIssues]) => `<section class="file-section"><h2>${escapeHtml(file)}</h2>${fileIssues.map(issueCard).join("")}</section>`).join("");
  const body = sections || (emptyState && !keyConfigured ? '<div class="onboarding"><div class="empty-icon">\u{1F44B}</div><h1>\u041F\u0440\u0438\u0432\u0435\u0442! \u042D\u0442\u043E CodeScout</h1><p><strong>\u0428\u0430\u0433 1.</strong> \u041F\u043E\u043B\u0443\u0447\u0438 API-\u043A\u043B\u044E\u0447 Gemini \u0432 <a class="link-button" href="https://aistudio.google.com/apikey" data-command="openKeyLink">\u041E\u0442\u043A\u0440\u044B\u0442\u044C Google AI Studio</a>.</p><p><strong>\u0428\u0430\u0433 2.</strong> \u041D\u0430\u0436\u043C\u0438 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0438\u0436\u0435 \u0438 \u0432\u0441\u0442\u0430\u0432\u044C \u043A\u043B\u044E\u0447.</p><button class="primary-action" type="button" data-command="setApiKey">\u{1F511} \u0412\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u043A\u043B\u044E\u0447</button><p><strong>\u0428\u0430\u0433 3.</strong> \u0413\u043E\u0442\u043E\u0432\u043E \u2014 \u043A\u043D\u043E\u043F\u043A\u0438 \u0432\u044B\u0448\u0435 \u0437\u0430\u0440\u0430\u0431\u043E\u0442\u0430\u044E\u0442.</p></div>' : emptyState ? '<div class="empty"><div class="empty-icon">\u{1F575}\uFE0F</div><strong>CodeScout \u0433\u043E\u0442\u043E\u0432 \u043A \u0440\u0430\u0431\u043E\u0442\u0435</strong><small>\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043E\u0434\u043D\u0443 \u0438\u0437 \u043A\u043D\u043E\u043F\u043E\u043A \u0432\u044B\u0448\u0435, \u0447\u0442\u043E\u0431\u044B \u043D\u0430\u0447\u0430\u0442\u044C \u0440\u0435\u0432\u044C\u044E.</small></div>' : '<div class="empty"><div class="empty-icon">\u2713</div><div>No issues found</div><small>Your changes look clean.</small></div>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 14px 24px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
.header { position: sticky; top: -16px; z-index: 2; margin: -16px -14px 0; padding: 14px 14px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.brand { display: flex; align-items: center; gap: 8px; font-size: 17px; font-weight: 700; letter-spacing: -0.2px; }
.brand-mark { color: var(--vscode-textLink-foreground); }
.key-status { display: flex; align-items: center; gap: 5px; margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 11px; }
.key-status button { width: auto; padding: 2px 5px; font-size: 10px; }
.key-status.ready { color: var(--vscode-testing-iconPassed); }
.key-status.missing { color: var(--vscode-errorForeground); }
.onboarding { padding: 36px 10px; text-align: center; }
.onboarding h1 { margin: 0 0 14px; font-size: 16px; }
.onboarding p { margin: 12px 0; color: var(--vscode-descriptionForeground); }
.link-button { display: inline; width: auto; padding: 0; color: var(--vscode-textLink-foreground); background: transparent; text-decoration: underline; }
.primary-action { width: auto; margin: 4px auto 8px; padding: 8px 14px; text-align: center; }
.actions { display: flex; gap: 6px; margin-top: 12px; flex-direction: column; }
button { width: 100%; padding: 6px 9px; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.65; cursor: default; }
.spinner { display: inline-block; width: 11px; margin-right: 4px; }
.status-banner { margin-top: 10px; padding: 7px 8px; border-left: 3px solid var(--vscode-editorWarning-foreground); border-radius: 3px; color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent); font-size: 12px; }
.status-banner.error { border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
.animated-dots { display: inline-block; width: 16px; overflow: hidden; animation: dots 1.2s steps(4, end) infinite; }
@keyframes dots { 0% { width: 0; } 25% { width: 5px; } 50% { width: 10px; } 75% { width: 15px; } 100% { width: 16px; } }
.stats { margin-top: 9px; color: var(--vscode-descriptionForeground); font-size: 12px; }
.pills { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
.pill, .badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.pill.critical, .badge.critical { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); }
.pill.medium, .badge.medium { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 15%, transparent); }
.pill.low, .badge.low { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 15%, transparent); }
.file-section { margin-top: 18px; }
h2 { margin: 0 0 8px; color: var(--vscode-textLink-foreground); font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.issue-card { margin: 8px 0; padding: 10px 10px 11px; border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-testing-iconPassed); border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
.issue-card.critical { border-left-color: var(--vscode-errorForeground); }
.issue-card.medium { border-left-color: var(--vscode-editorWarning-foreground); }
.issue-top { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.category { color: var(--vscode-descriptionForeground); font-size: 11px; }
.confidence { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
.location { margin: 6px 0; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; overflow-wrap: anywhere; }
.description { margin-top: 5px; }
pre { margin: 9px 0; padding: 8px; overflow-x: auto; border: 1px solid var(--vscode-textBlockQuote-border); border-radius: 3px; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.suggestion { color: var(--vscode-testing-iconPassed); }
.suggestion span { font-weight: 700; }
.empty { padding: 48px 10px; color: var(--vscode-descriptionForeground); text-align: center; }
.empty-icon { margin-bottom: 8px; color: var(--vscode-testing-iconPassed); font-size: 24px; }
.empty small { display: block; margin-top: 5px; }
</style>
</head>
<body>
  <header class="header">
    <div class="brand"><span class="brand-mark">\u{1F575}\uFE0F</span> CodeScout</div>
    <div class="key-status ${keyConfigured ? "ready" : "missing"}">${keyConfigured ? `\u{1F7E2} \u041A\u043B\u044E\u0447: ${escapeHtml(keyMask)} (\u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u043E)` : "\u{1F534} \u041A\u043B\u044E\u0447 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D"} <button type="button" data-command="setApiKey">${keyConfigured ? "\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C" : "\u041D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C"}</button>${keyConfigured ? '<button type="button" data-command="clearApiKey">\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C</button>' : ""}</div>
    ${statusMessage ? `<div class="status-banner ${statusKind}">${escapeHtml(statusMessage)}${statusKind === "retry" ? '<span class="animated-dots">...</span>' : ""}</div>` : ""}
    <div class="actions">
      <button type="button" data-command="scanLastCommit" ${isScanning ? "disabled" : ""}>${isScanning ? '<span class="spinner">\u25CC</span>' : "\u{1F50D}"} Review last commit</button>
      <button type="button" data-command="scanUncommitted" ${isScanning ? "disabled" : ""}>${isScanning ? '<span class="spinner">\u25CC</span>' : "\u{1F4DD}"} Review uncommitted</button>
    </div>
    <div class="stats"><strong>${issues.length} issues</strong> \xB7 ${stats.files} files \xB7 ${stats.seconds.toFixed(1)}s</div>
    <div class="pills"><span class="pill critical">\u{1F534} ${stats.critical}</span><span class="pill medium">\u{1F7E1} ${stats.medium}</span><span class="pill low">\u{1F7E2} ${stats.low}</span></div>
  </header>
  <main>${body}</main>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((element) => {
      element.addEventListener('click', (event) => { event.preventDefault(); vscode.postMessage({ command: element.dataset.command }); });
    });
  </script>
</body>
</html>`;
}
function buildEmptyReportHtml(keyMask = "", keyConfigured = false) {
  return buildReportHtml([], { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 }, false, true, "", "retry", keyMask, keyConfigured);
}

// src/panel.ts
var CodeScoutPanel = class {
  view;
  issues = [];
  stats = { files: 0, seconds: 0, critical: 0, medium: 0, low: 0 };
  hasRun = false;
  scanning = false;
  statusMessage = "";
  statusKind = "retry";
  keyMask = "";
  keyConfigured = false;
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.command === "scanLastCommit") {
        void vscode.commands.executeCommand("codescout.scanLastCommit");
      } else if (message.command === "scanUncommitted") {
        void vscode.commands.executeCommand("codescout.scanUncommitted");
      } else if (message.command === "setApiKey") {
        void vscode.commands.executeCommand("codescout.setApiKey");
      } else if (message.command === "clearApiKey") {
        void vscode.commands.executeCommand("codescout.clearApiKey");
      } else if (message.command === "openKeyLink") {
        void vscode.env.openExternal(vscode.Uri.parse("https://aistudio.google.com/apikey"));
      }
    }, void 0, []);
    this.render();
  }
  setKey(key) {
    this.keyConfigured = Boolean(key?.trim());
    this.keyMask = key ? maskApiKey(key) : "";
    this.render();
  }
  setScanning(scanning) {
    this.scanning = scanning;
    if (scanning) {
      this.statusMessage = "";
      this.statusKind = "retry";
    }
    this.render();
  }
  setRetry(event, model = "model") {
    this.scanning = true;
    this.statusKind = "retry";
    this.statusMessage = `\u23F3 Rate limit \u0443 ${model}, \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 ${event.waitSeconds}\u0441 (\u043F\u043E\u043F\u044B\u0442\u043A\u0430 ${event.attempt}/${event.maxRetries})...`;
    this.render();
  }
  setError(message) {
    this.scanning = false;
    this.hasRun = true;
    this.statusKind = "error";
    this.statusMessage = message;
    this.render();
  }
  update(issues, stats) {
    this.issues = issues;
    this.stats = stats;
    this.hasRun = true;
    this.scanning = false;
    this.statusMessage = "";
    this.statusKind = "retry";
    this.render();
  }
  render() {
    if (!this.view) return;
    this.view.webview.html = this.hasRun || this.scanning ? buildReportHtml(this.issues, this.stats, this.scanning, !this.hasRun, this.statusMessage, this.statusKind, this.keyMask, this.keyConfigured) : buildEmptyReportHtml(this.keyMask, this.keyConfigured);
  }
};

// src/extension.ts
var SECRET_KEY = "codescout.apiKey";
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
  return vscode2.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
function buildStats(issues, filesAnalyzed, durationMs) {
  return {
    files: filesAnalyzed,
    seconds: durationMs / 1e3,
    critical: issues.filter((issue) => issue.severity === "critical" || issue.severity === "high").length,
    medium: issues.filter((issue) => issue.severity === "medium").length,
    low: issues.filter((issue) => issue.severity === "low").length
  };
}
async function resolveExtensionKey(context, providerName, legacySetting) {
  const secret = await context.secrets.get(SECRET_KEY);
  if (secret?.trim()) return secret.trim();
  return resolveApiKeyPriority(void 0, providerName, legacySetting);
}
async function reviewWorkspace(context, lastCommit, onRetry) {
  const startedAt = Date.now();
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) throw new Error("\u041E\u0442\u043A\u0440\u043E\u0439 \u043F\u0430\u043F\u043A\u0443 \u0441 Git-\u0440\u0435\u043F\u043E\u0437\u0438\u0442\u043E\u0440\u0438\u0435\u043C \u0432 VS Code \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438 \u043A\u043E\u043C\u0430\u043D\u0434\u0443.");
  const config = vscode2.workspace.getConfiguration("codescout");
  const providerName = config.get("provider", "gemini");
  const model = config.get("model")?.trim() || defaultModel(providerName);
  const baseUrl = config.get("baseUrl")?.trim() || process.env.CODESCOUT_BASE_URL;
  const apiKey = await resolveExtensionKey(context, providerName, config.get("apiKey"));
  if (!apiKey) {
    throw new Error(`\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D API-\u043A\u043B\u044E\u0447 \u0434\u043B\u044F ${providerName}. \u0423\u043A\u0430\u0436\u0438 codescout.apiKey \u0438\u043B\u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0438 CodeScout: set API key. \u041F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043A\u043B\u044E\u0447: ${keyUrl(providerName)}`);
  }
  const files = readGitDiff(workspaceRoot, { lastCommit });
  if (files.length === 0) return { issues: [], filesAnalyzed: 0, durationMs: Date.now() - startedAt };
  const provider = createProvider(providerName, apiKey, model, (event) => onRetry(event, model), baseUrl);
  const issues = [];
  for (const file of files) {
    for (const chunk of splitPatch(file.patch, 45e3)) {
      const raw = await provider.review(SYSTEM_PROMPT, buildReviewPrompt(file, chunk));
      const parsed = parseReviewResponse(raw, file.filename);
      issues.push(...parsed.issues.map((issue) => correctIssueLine(issue, workspaceRoot)));
    }
  }
  return { issues, filesAnalyzed: files.length, durationMs: Date.now() - startedAt };
}
async function runReview(context, lastCommit, output, panel) {
  output.clear();
  output.show(true);
  output.appendLine(lastCommit ? "CodeScout: reviewing last commit..." : "CodeScout: reviewing uncommitted changes...");
  panel.setScanning(true);
  try {
    const result = await reviewWorkspace(context, lastCommit, (event, model) => panel.setRetry(event, model));
    const stats = buildStats(result.issues, result.filesAnalyzed, result.durationMs);
    panel.update(result.issues, stats);
    await vscode2.commands.executeCommand("codescout.panel.focus");
    if (result.issues.length === 0) output.appendLine("No issues found.");
    else {
      output.appendLine(`${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} found:`);
      output.appendLine("");
      for (const issue of result.issues) output.appendLine(formatIssue(issue));
    }
    void vscode2.window.showInformationMessage(`CodeScout: ${result.issues.length} issues found`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    panel.setError(message);
    output.appendLine(`Error: ${message}`);
    void vscode2.window.showErrorMessage(`CodeScout: ${message}`);
  }
}
function activate(context) {
  const output = vscode2.window.createOutputChannel("CodeScout");
  const panel = new CodeScoutPanel();
  context.subscriptions.push(output);
  const syncKeyStatus = async () => {
    const config = vscode2.workspace.getConfiguration("codescout");
    const provider = config.get("provider", "gemini");
    panel.setKey(await resolveExtensionKey(context, provider, config.get("apiKey")));
  };
  void syncKeyStatus();
  context.subscriptions.push(
    vscode2.window.registerWebviewViewProvider("codescout.panel", panel),
    vscode2.commands.registerCommand("codescout.scanUncommitted", () => runReview(context, false, output, panel)),
    vscode2.commands.registerCommand("codescout.scanLastCommit", () => runReview(context, true, output, panel)),
    vscode2.commands.registerCommand("codescout.setApiKey", async () => {
      const key = await vscode2.window.showInputBox({ password: true, ignoreFocusOut: true, prompt: "\u0412\u0441\u0442\u0430\u0432\u044C API-\u043A\u043B\u044E\u0447 Gemini (\u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0441 AIza)" });
      if (!key?.trim()) return;
      await context.secrets.store(SECRET_KEY, key.trim());
      panel.setKey(key.trim());
      void vscode2.window.showInformationMessage("\u2705 \u041A\u043B\u044E\u0447 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u043E");
    }),
    vscode2.commands.registerCommand("codescout.clearApiKey", async () => {
      const answer = await vscode2.window.showWarningMessage("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0439 API-\u043A\u043B\u044E\u0447 CodeScout?", { modal: true }, "\u0423\u0434\u0430\u043B\u0438\u0442\u044C");
      if (answer !== "\u0423\u0434\u0430\u043B\u0438\u0442\u044C") return;
      await context.secrets.delete(SECRET_KEY);
      panel.setKey(void 0);
      void vscode2.window.showInformationMessage("\u041A\u043B\u044E\u0447 \u0443\u0434\u0430\u043B\u0451\u043D \u0438\u0437 \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u043E\u0433\u043E \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0430");
    })
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
