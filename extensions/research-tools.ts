import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	annotatePaper,
	askPaper,
	clearPaperAnnotation,
	disconnect,
	getPaper,
	getUserName as getAlphaUserName,
	isLoggedIn as isAlphaLoggedIn,
	listPaperAnnotations,
	login as loginAlpha,
	logout as logoutAlpha,
	readPaperCode,
	searchPapers,
} from "@companion-ai/alpha-hub/lib";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const FEYNMAN_VERSION = (() => {
	try {
		const pkg = require("../package.json") as { version?: string };
		return pkg.version ?? "dev";
	} catch {
		return "dev";
	}
})();

function formatToolText(result: unknown): string {
	return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function getFeynmanHome(): string {
	const agentDir = process.env.FEYNMAN_CODING_AGENT_DIR ??
		process.env.PI_CODING_AGENT_DIR ??
		resolvePath(homedir(), ".feynman", "agent");
	return dirname(agentDir);
}

function extractMessageText(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "";
	}

	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.map((item) => {
			if (!item || typeof item !== "object") {
				return "";
			}
			const record = item as { type?: string; text?: unknown; arguments?: unknown; name?: unknown };
			if (record.type === "text" && typeof record.text === "string") {
				return record.text;
			}
			if (record.type === "toolCall") {
				const name = typeof record.name === "string" ? record.name : "tool";
				const args =
					typeof record.arguments === "string"
						? record.arguments
						: record.arguments
							? JSON.stringify(record.arguments)
							: "";
				return `[tool:${name}] ${args}`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function buildExcerpt(text: string, query: string, radius = 180): string {
	const normalizedText = text.replace(/\s+/g, " ").trim();
	if (!normalizedText) {
		return "";
	}

	const lower = normalizedText.toLowerCase();
	const q = query.toLowerCase();
	const index = lower.indexOf(q);
	if (index === -1) {
		return normalizedText.slice(0, radius * 2) + (normalizedText.length > radius * 2 ? "..." : "");
	}

	const start = Math.max(0, index - radius);
	const end = Math.min(normalizedText.length, index + q.length + radius);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < normalizedText.length ? "..." : "";
	return `${prefix}${normalizedText.slice(start, end)}${suffix}`;
}

async function searchSessionTranscripts(query: string, limit: number): Promise<{
	query: string;
	results: Array<{
		sessionId: string;
		sessionFile: string;
		startedAt?: string;
		cwd?: string;
		matchCount: number;
		topMatches: Array<{ role: string; timestamp?: string; excerpt: string }>;
	}>;
}> {
	const packageRoot = process.env.FEYNMAN_PI_NPM_ROOT;
	if (packageRoot) {
		try {
			const indexerPath = pathToFileURL(
				join(packageRoot, "@kaiserlich-dev", "pi-session-search", "extensions", "indexer.ts"),
			).href;
			const indexer = await import(indexerPath) as {
				updateIndex?: (onProgress?: (msg: string) => void) => Promise<number>;
				search?: (query: string, limit?: number) => Array<{
					sessionPath: string;
					project: string;
					timestamp: string;
					snippet: string;
					rank: number;
					title: string | null;
				}>;
				getSessionSnippets?: (sessionPath: string, query: string, limit?: number) => string[];
			};

			await indexer.updateIndex?.();
			const results = indexer.search?.(query, limit) ?? [];
			if (results.length > 0) {
				return {
					query,
					results: results.map((result) => ({
						sessionId: basename(result.sessionPath),
						sessionFile: result.sessionPath,
						startedAt: result.timestamp,
						cwd: result.project,
						matchCount: 1,
						topMatches: (indexer.getSessionSnippets?.(result.sessionPath, query, 4) ?? [result.snippet])
							.filter(Boolean)
							.map((excerpt) => ({
								role: "match",
								excerpt,
							})),
					})),
				};
			}
		} catch {
			// Fall back to direct JSONL scanning below.
		}
	}

	const sessionDir = join(getFeynmanHome(), "sessions");
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((term) => term.trim())
		.filter((term) => term.length >= 2);
	const needle = query.toLowerCase();

	let files: string[] = [];
	try {
		files = (await readdir(sessionDir))
			.filter((entry) => entry.endsWith(".jsonl"))
			.map((entry) => join(sessionDir, entry));
	} catch {
		return { query, results: [] };
	}

	const sessions = [];
	for (const file of files) {
		const raw = await readFile(file, "utf8").catch(() => "");
		if (!raw) {
			continue;
		}

		let sessionId = basename(file);
		let startedAt: string | undefined;
		let cwd: string | undefined;
		const matches: Array<{ role: string; timestamp?: string; excerpt: string }> = [];

		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			try {
				const record = JSON.parse(line) as {
					type?: string;
					id?: string;
					timestamp?: string;
					cwd?: string;
					message?: { role?: string; content?: unknown };
				};
				if (record.type === "session") {
					sessionId = record.id ?? sessionId;
					startedAt = record.timestamp;
					cwd = record.cwd;
					continue;
				}
				if (record.type !== "message" || !record.message) {
					continue;
				}

				const text = extractMessageText(record.message);
				if (!text) {
					continue;
				}
				const lower = text.toLowerCase();
				const matched = lower.includes(needle) || terms.some((term) => lower.includes(term));
				if (!matched) {
					continue;
				}
				matches.push({
					role: record.message.role ?? "unknown",
					timestamp: record.timestamp,
					excerpt: buildExcerpt(text, query),
				});
			} catch {
				continue;
			}
		}

		if (matches.length === 0) {
			continue;
		}

		let mtime = 0;
		try {
			mtime = (await stat(file)).mtimeMs;
		} catch {
			mtime = 0;
		}

		sessions.push({
			sessionId,
			sessionFile: file,
			startedAt,
			cwd,
			matchCount: matches.length,
			topMatches: matches.slice(0, 4),
			mtime,
		});
	}

	sessions.sort((a, b) => {
		if (b.matchCount !== a.matchCount) {
			return b.matchCount - a.matchCount;
		}
		return b.mtime - a.mtime;
	});

	return {
		query,
		results: sessions.slice(0, limit).map(({ mtime: _mtime, ...session }) => session),
	};
}

function isMarkdownPath(path: string): boolean {
	return [".md", ".markdown", ".txt"].includes(extname(path).toLowerCase());
}

function isLatexPath(path: string): boolean {
	return extname(path).toLowerCase() === ".tex";
}

function wrapCodeAsMarkdown(source: string, filePath: string): string {
	const language = extname(filePath).replace(/^\./, "") || "text";
	return `# ${basename(filePath)}\n\n\`\`\`${language}\n${source}\n\`\`\`\n`;
}

async function openWithDefaultApp(targetPath: string): Promise<void> {
	const target = pathToFileURL(targetPath).href;
	if (process.platform === "darwin") {
		await execFileAsync("open", [target]);
		return;
	}
	if (process.platform === "win32") {
		await execFileAsync("cmd", ["/c", "start", "", target]);
		return;
	}
	await execFileAsync("xdg-open", [target]);
}

async function runCommandWithInput(
	command: string,
	args: string[],
	input: string,
): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		});

		child.once("error", reject);
		child.once("close", (code) => {
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
		});

		child.stdin.end(input);
	});
}

async function renderHtmlPreview(filePath: string): Promise<string> {
	const source = await readFile(filePath, "utf8");
	const pandocCommand = process.env.PANDOC_PATH?.trim() || "pandoc";
	const inputFormat = isLatexPath(filePath)
		? "latex"
		: "markdown+lists_without_preceding_blankline+tex_math_dollars+autolink_bare_uris-raw_html";
	const markdown = isLatexPath(filePath) || isMarkdownPath(filePath) ? source : wrapCodeAsMarkdown(source, filePath);
	const args = ["-f", inputFormat, "-t", "html5", "--mathml", "--wrap=none", `--resource-path=${dirname(filePath)}`];
	const { stdout } = await runCommandWithInput(pandocCommand, args, markdown);
	const html = `<!doctype html><html><head><meta charset="utf-8" /><base href="${pathToFileURL(dirname(filePath) + "/").href}" /><title>${basename(filePath)}</title><style>
:root{
  --bg:#faf7f2;
  --paper:#fffdf9;
  --border:#d7cec1;
  --text:#1f1c18;
  --muted:#6c645a;
  --code:#f3eee6;
  --link:#0f6d8c;
  --quote:#8b7f70;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#161311;
    --paper:#1d1916;
    --border:#3b342d;
    --text:#ebe3d6;
    --muted:#b4ab9f;
    --code:#221d19;
    --link:#8ac6d6;
    --quote:#a89d8f;
  }
}
body{
  font-family:Charter,"Iowan Old Style","Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;
  margin:0;
  background:var(--bg);
  color:var(--text);
  line-height:1.7;
}
main{
  max-width:900px;
  margin:2rem auto 4rem;
  padding:2.5rem 3rem;
  background:var(--paper);
  border:1px solid var(--border);
  border-radius:18px;
  box-shadow:0 12px 40px rgba(0,0,0,.06);
}
h1,h2,h3,h4,h5,h6{
  font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
  line-height:1.2;
  margin-top:1.5em;
}
h1{font-size:2.2rem;border-bottom:1px solid var(--border);padding-bottom:.35rem;}
h2{font-size:1.6rem;border-bottom:1px solid var(--border);padding-bottom:.25rem;}
p,ul,ol,blockquote,table{margin:1rem 0;}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{
  background:var(--code);
  border:1px solid var(--border);
  border-radius:12px;
  padding:1rem 1.1rem;
  overflow:auto;
}
code{
  background:var(--code);
  padding:.12rem .28rem;
  border-radius:6px;
}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
img{max-width:100%}
blockquote{
  border-left:4px solid var(--border);
  padding-left:1rem;
  color:var(--quote);
}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--border);padding:.55rem .7rem;text-align:left}
</style></head><body><main>${stdout}</main></body></html>`;
	const tempDir = await mkdtemp(join(tmpdir(), "feynman-preview-"));
	const htmlPath = join(tempDir, `${basename(filePath)}.html`);
	await writeFile(htmlPath, html, "utf8");
	return htmlPath;
}

async function renderPdfPreview(filePath: string): Promise<string> {
	const source = await readFile(filePath, "utf8");
	const pandocCommand = process.env.PANDOC_PATH?.trim() || "pandoc";
	const pdfEngine = process.env.PANDOC_PDF_ENGINE?.trim() || "xelatex";
	const inputFormat = isLatexPath(filePath)
		? "latex"
		: "markdown+lists_without_preceding_blankline+tex_math_dollars+autolink_bare_uris-raw_html";
	const markdown = isLatexPath(filePath) || isMarkdownPath(filePath) ? source : wrapCodeAsMarkdown(source, filePath);
	const tempDir = await mkdtemp(join(tmpdir(), "feynman-preview-"));
	const pdfPath = join(tempDir, `${basename(filePath)}.pdf`);
	const args = [
		"-f",
		inputFormat,
		"-o",
		pdfPath,
		`--pdf-engine=${pdfEngine}`,
		`--resource-path=${dirname(filePath)}`,
	];
	await runCommandWithInput(pandocCommand, args, markdown);
	return pdfPath;
}

function formatHeaderPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function truncateForWidth(text: string, width: number): string {
	if (width <= 0) {
		return "";
	}

	if (text.length <= width) {
		return text;
	}

	if (width <= 3) {
		return ".".repeat(width);
	}

	return `${text.slice(0, width - 3)}...`;
}

function padCell(text: string, width: number): string {
	const truncated = truncateForWidth(text, width);
	return `${truncated}${" ".repeat(Math.max(0, width - truncated.length))}`;
}

function wrapForWidth(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) {
		return [];
	}

	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return [];
	}

	const words = normalized.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= width) {
			current = candidate;
			continue;
		}

		if (current) {
			lines.push(current);
			if (lines.length === maxLines) {
				lines[maxLines - 1] = truncateForWidth(lines[maxLines - 1], width);
				return lines;
			}
		}

		current = word.length <= width ? word : truncateForWidth(word, width);
	}

	if (current && lines.length < maxLines) {
		lines.push(current);
	}

	return lines;
}

function getCurrentModelLabel(ctx: ExtensionContext): string {
	if (ctx.model) {
		return `${ctx.model.provider}/${ctx.model.id}`;
	}

	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "model_change") {
			return `${entry.provider}/${entry.modelId}`;
		}
	}

	return "model not set";
}

function getRecentActivitySummary(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message") {
			continue;
		}

		const text = extractMessageText(entry.message).replace(/\s+/g, " ").trim();
		if (!text) {
			continue;
		}

		const role = entry.message.role === "assistant"
			? "agent"
			: entry.message.role === "user"
				? "you"
				: entry.message.role;
		return `${role}: ${text}`;
	}

	return "No messages yet in this session.";
}

function buildTitledBorder(width: number, title: string): { left: string; right: string } {
	const gap = Math.max(0, width - title.length);
	const left = Math.floor(gap / 2);
	return {
		left: "─".repeat(left),
		right: "─".repeat(gap - left),
	};
}

function formatShortcutLine(command: string, description: string, width: number): string {
	const commandWidth = Math.min(18, Math.max(13, Math.floor(width * 0.3)));
	return truncateForWidth(`${padCell(command, commandWidth)} ${description}`, width);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function buildProjectAgentsTemplate(): string {
	return `# Feynman Project Guide

This file is read automatically at startup. It is the durable project memory for Feynman.

## Project Overview
- State the research question, target artifact, target venue, and key datasets or benchmarks here.

## AI Research Context
- Problem statement:
- Core hypothesis:
- Closest prior work:
- Required baselines:
- Required ablations:
- Primary metrics:
- Datasets / benchmarks:

## Ground Rules
- Do not modify raw data in \`Data/Raw/\` or equivalent raw-data folders.
- Read first, act second: inspect project structure and existing notes before making changes.
- Prefer durable artifacts in \`notes/\`, \`outputs/\`, \`experiments/\`, and \`papers/\`.
- Keep strong claims source-grounded. Include direct URLs in final writeups.

## Current Status
- Replace this section with the latest project status, known issues, and next steps.

## Session Logging
- Use \`/log\` at the end of meaningful sessions to write a durable session note into \`notes/session-logs/\`.

## Review Readiness
- Known reviewer concerns:
- Missing experiments:
- Missing writing or framing work:
`;
}

function buildSessionLogsReadme(): string {
	return `# Session Logs

Use \`/log\` to write one durable note per meaningful Feynman session.

Recommended contents:
- what was done
- strongest findings
- artifacts written
- unresolved questions
- next steps
`;
}

type HelpCommand = {
	usage: string;
	description: string;
};

function buildFeynmanHelpSections(): Array<{ title: string; commands: HelpCommand[] }> {
	return [
		{
			title: "Core Research Workflows",
			commands: [
				{ usage: "/lit <topic>", description: "Survey papers on a topic." },
				{ usage: "/related <topic>", description: "Map related work and justify the gap." },
				{ usage: "/review <artifact>", description: "Simulate a peer review for an AI research artifact." },
				{ usage: "/ablate <artifact>", description: "Design the minimum convincing ablation set." },
				{ usage: "/rebuttal <artifact>", description: "Draft a rebuttal and revision matrix." },
				{ usage: "/replicate <paper or claim>", description: "Plan or execute a replication workflow." },
				{ usage: "/reading <topic>", description: "Build a prioritized reading list." },
				{ usage: "/memo <topic>", description: "Write a source-grounded research memo." },
				{ usage: "/compare <topic>", description: "Compare sources and disagreements." },
				{ usage: "/audit <item>", description: "Audit a paper against its codebase." },
				{ usage: "/draft <topic>", description: "Write a paper-style draft." },
				{ usage: "/deepresearch <topic>", description: "Run a source-heavy research pass." },
				{ usage: "/autoresearch <idea>", description: "Run an end-to-end idea-to-paper workflow." },
			],
		},
		{
			title: "Project Memory And Tracking",
			commands: [
				{ usage: "/init", description: "Bootstrap AGENTS.md and session-log folders." },
				{ usage: "/log", description: "Write a durable session log into notes/." },
				{ usage: "/watch <topic>", description: "Create a recurring or deferred research watch." },
				{ usage: "/jobs", description: "Inspect active background work." },
				{ usage: "/search", description: "Search prior indexed sessions." },
			],
		},
		{
			title: "Delegation And Background Work",
			commands: [
				{ usage: "/agents", description: "Open the agent and chain manager." },
				{ usage: "/run <agent> <task>", description: "Run one subagent." },
				{ usage: "/chain ...", description: "Run a sequential multi-agent chain." },
				{ usage: "/parallel ...", description: "Run agents in parallel." },
				{ usage: "/ps", description: "Open the background process panel." },
				{ usage: "/schedule-prompt", description: "Manage recurring and deferred jobs." },
			],
		},
		{
			title: "Setup And Utilities",
			commands: [
				{ usage: "/alpha-login", description: "Sign in to alphaXiv." },
				{ usage: "/alpha-status", description: "Check alphaXiv auth." },
				{ usage: "/alpha-logout", description: "Clear alphaXiv auth." },
				{ usage: "/preview", description: "Preview generated artifacts." },
			],
		},
	];
}

export default function researchTools(pi: ExtensionAPI): void {
	function installFeynmanHeader(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			return;
		}

		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const maxAvailableWidth = Math.max(width - 2, 1);
				const preferredWidth = Math.min(104, Math.max(56, width - 4));
				const cardWidth = Math.min(maxAvailableWidth, preferredWidth);
				const innerWidth = cardWidth - 2;
				const outerPadding = " ".repeat(Math.max(0, Math.floor((width - cardWidth) / 2)));
				const title = truncateForWidth(` Feynman v${FEYNMAN_VERSION} `, innerWidth);
				const titledBorder = buildTitledBorder(innerWidth, title);
				const modelLabel = getCurrentModelLabel(ctx);
				const sessionLabel = ctx.sessionManager.getSessionName()?.trim() || "default session";
				const directoryLabel = formatHeaderPath(ctx.cwd);
				const recentActivity = getRecentActivitySummary(ctx);
				const shortcuts = [
					["/lit", "survey papers on a topic"],
					["/review", "simulate a peer review"],
					["/draft", "draft a paper-style writeup"],
					["/deepresearch", "run a source-heavy research pass"],
				];
				const lines: string[] = [];

				const push = (line: string): void => {
					lines.push(`${outerPadding}${line}`);
				};

				const renderBoxLine = (content: string): string =>
					`${theme.fg("borderMuted", "│")}${content}${theme.fg("borderMuted", "│")}`;
				const renderDivider = (): string =>
					`${theme.fg("borderMuted", "├")}${theme.fg("borderMuted", "─".repeat(innerWidth))}${theme.fg("borderMuted", "┤")}`;
				const styleAccentCell = (text: string, cellWidth: number): string =>
					theme.fg("accent", theme.bold(padCell(text, cellWidth)));
				const styleMutedCell = (text: string, cellWidth: number): string =>
					theme.fg("muted", padCell(text, cellWidth));

				push("");
				push(
					theme.fg("borderMuted", `╭${titledBorder.left}`) +
						theme.fg("accent", theme.bold(title)) +
						theme.fg("borderMuted", `${titledBorder.right}╮`),
				);

				if (innerWidth < 88) {
					const activityLines = wrapForWidth(recentActivity, innerWidth, 2);
					push(renderBoxLine(padCell("", innerWidth)));
					push(renderBoxLine(theme.fg("accent", theme.bold(padCell("Research session ready", innerWidth)))));
					push(renderBoxLine(padCell(`model: ${modelLabel}`, innerWidth)));
					push(renderBoxLine(padCell(`session: ${sessionLabel}`, innerWidth)));
					push(renderBoxLine(padCell(`directory: ${directoryLabel}`, innerWidth)));
					push(renderDivider());
					push(renderBoxLine(theme.fg("accent", theme.bold(padCell("Quick starts", innerWidth)))));
					for (const [command, description] of shortcuts) {
						push(renderBoxLine(padCell(formatShortcutLine(command, description, innerWidth), innerWidth)));
					}
					push(renderDivider());
					push(renderBoxLine(theme.fg("accent", theme.bold(padCell("Recent activity", innerWidth)))));
					for (const activityLine of activityLines.length > 0 ? activityLines : ["No messages yet in this session."]) {
						push(renderBoxLine(padCell(activityLine, innerWidth)));
					}
				} else {
					const leftWidth = Math.min(44, Math.max(38, Math.floor(innerWidth * 0.43)));
					const rightWidth = innerWidth - leftWidth - 3;
					const activityLines = wrapForWidth(recentActivity, innerWidth, 2);
					const row = (
						left: string,
						right: string,
						options?: { leftAccent?: boolean; rightAccent?: boolean; leftMuted?: boolean; rightMuted?: boolean },
					): string => {
						const leftCell = options?.leftAccent
							? styleAccentCell(left, leftWidth)
							: options?.leftMuted
								? styleMutedCell(left, leftWidth)
								: padCell(left, leftWidth);
						const rightCell = options?.rightAccent
							? styleAccentCell(right, rightWidth)
							: options?.rightMuted
								? styleMutedCell(right, rightWidth)
								: padCell(right, rightWidth);
						return renderBoxLine(`${leftCell}${theme.fg("borderMuted", " │ ")}${rightCell}`);
					};

					push(renderBoxLine(padCell("", innerWidth)));
					push(row("Research session ready", "Quick starts", { leftAccent: true, rightAccent: true }));
					push(row(`model: ${modelLabel}`, formatShortcutLine(shortcuts[0][0], shortcuts[0][1], rightWidth)));
					push(row(`session: ${sessionLabel}`, formatShortcutLine(shortcuts[1][0], shortcuts[1][1], rightWidth)));
					push(row(`directory: ${directoryLabel}`, formatShortcutLine(shortcuts[2][0], shortcuts[2][1], rightWidth)));
					push(row("ask naturally; slash commands are optional", formatShortcutLine(shortcuts[3][0], shortcuts[3][1], rightWidth), { leftMuted: true }));
					push(renderDivider());
					push(renderBoxLine(theme.fg("accent", theme.bold(padCell("Recent activity", innerWidth)))));
					for (const activityLine of activityLines.length > 0 ? activityLines : ["No messages yet in this session."]) {
						push(renderBoxLine(padCell(activityLine, innerWidth)));
					}
				}

				push(theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`));
				push("");
				return lines;
			},
			invalidate() {},
		}));
	}

	pi.on("session_start", async (_event, ctx) => {
		installFeynmanHeader(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		installFeynmanHeader(ctx);
	});

	pi.registerCommand("alpha-login", {
		description: "Sign in to alphaXiv from inside Feynman.",
		handler: async (_args, ctx) => {
			if (isAlphaLoggedIn()) {
				const name = getAlphaUserName();
				ctx.ui.notify(name ? `alphaXiv already connected as ${name}` : "alphaXiv already connected", "info");
				return;
			}

			await loginAlpha();
			const name = getAlphaUserName();
			ctx.ui.notify(name ? `alphaXiv connected as ${name}` : "alphaXiv login complete", "info");
		},
	});

	pi.registerCommand("alpha-logout", {
		description: "Clear alphaXiv auth from inside Feynman.",
		handler: async (_args, ctx) => {
			logoutAlpha();
			ctx.ui.notify("alphaXiv auth cleared", "info");
		},
	});

	pi.registerCommand("alpha-status", {
		description: "Show alphaXiv authentication status.",
		handler: async (_args, ctx) => {
			if (!isAlphaLoggedIn()) {
				ctx.ui.notify("alphaXiv not connected", "warning");
				return;
			}

			const name = getAlphaUserName();
			ctx.ui.notify(name ? `alphaXiv connected as ${name}` : "alphaXiv connected", "info");
		},
	});

	pi.registerCommand("help", {
		description: "Show grouped Feynman commands and prefill the editor with a selected command.",
		handler: async (_args, ctx) => {
			const sections = buildFeynmanHelpSections();
			const items = sections.flatMap((section) => [
				`--- ${section.title} ---`,
				...section.commands.map((command) => `${command.usage} — ${command.description}`),
			]);

			const selected = await ctx.ui.select("Feynman Help", items);
			if (!selected || selected.startsWith("---")) {
				return;
			}

			const usage = selected.split(" — ")[0];
			ctx.ui.setEditorText(usage);
			ctx.ui.notify(`Prefilled ${usage}`, "info");
		},
	});

	pi.registerCommand("init", {
		description: "Initialize AGENTS.md and session-log folders for a research project.",
		handler: async (_args, ctx) => {
			const agentsPath = resolvePath(ctx.cwd, "AGENTS.md");
			const notesDir = resolvePath(ctx.cwd, "notes");
			const sessionLogsDir = resolvePath(notesDir, "session-logs");
			const sessionLogsReadmePath = resolvePath(sessionLogsDir, "README.md");
			const created: string[] = [];
			const skipped: string[] = [];

			await mkdir(notesDir, { recursive: true });
			await mkdir(sessionLogsDir, { recursive: true });

			if (!(await pathExists(agentsPath))) {
				await writeFile(agentsPath, buildProjectAgentsTemplate(), "utf8");
				created.push("AGENTS.md");
			} else {
				skipped.push("AGENTS.md");
			}

			if (!(await pathExists(sessionLogsReadmePath))) {
				await writeFile(sessionLogsReadmePath, buildSessionLogsReadme(), "utf8");
				created.push("notes/session-logs/README.md");
			} else {
				skipped.push("notes/session-logs/README.md");
			}

			const createdSummary = created.length > 0 ? `created: ${created.join(", ")}` : "created: nothing";
			const skippedSummary = skipped.length > 0 ? `; kept existing: ${skipped.join(", ")}` : "";
			ctx.ui.notify(`${createdSummary}${skippedSummary}`, "info");
		},
	});

	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description: "Search prior Feynman session transcripts to recover what was done, said, or written before.",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query to look for in past sessions.",
			}),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum number of sessions to return. Defaults to 3.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const result = await searchSessionTranscripts(params.query, Math.max(1, Math.min(params.limit ?? 3, 8)));
			return {
				content: [{ type: "text", text: formatToolText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "alpha_search",
		label: "Alpha Search",
		description: "Search papers through alphaXiv using semantic, keyword, both, agentic, or all retrieval modes.",
		parameters: Type.Object({
			query: Type.String({ description: "Paper search query." }),
			mode: Type.Optional(
				Type.String({
					description: "Search mode: semantic, keyword, both, agentic, or all.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await searchPapers(params.query, params.mode?.trim() || "all");
				return {
					content: [{ type: "text", text: formatToolText(result) }],
					details: result,
				};
			} finally {
				await disconnect();
			}
		},
	});

	pi.registerTool({
		name: "alpha_get_paper",
		label: "Alpha Get Paper",
		description: "Fetch a paper report or full text, plus any local annotation, using alphaXiv.",
		parameters: Type.Object({
			paper: Type.String({
				description: "arXiv ID, arXiv URL, or alphaXiv URL.",
			}),
			fullText: Type.Optional(
				Type.Boolean({
					description: "Return raw full text instead of the AI report.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await getPaper(params.paper, { fullText: params.fullText });
				return {
					content: [{ type: "text", text: formatToolText(result) }],
					details: result,
				};
			} finally {
				await disconnect();
			}
		},
	});

	pi.registerTool({
		name: "alpha_ask_paper",
		label: "Alpha Ask Paper",
		description: "Ask a targeted question about a paper using alphaXiv's PDF analysis.",
		parameters: Type.Object({
			paper: Type.String({
				description: "arXiv ID, arXiv URL, or alphaXiv URL.",
			}),
			question: Type.String({
				description: "Question to ask about the paper.",
			}),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await askPaper(params.paper, params.question);
				return {
					content: [{ type: "text", text: formatToolText(result) }],
					details: result,
				};
			} finally {
				await disconnect();
			}
		},
	});

	pi.registerTool({
		name: "alpha_annotate_paper",
		label: "Alpha Annotate Paper",
		description: "Write or clear a persistent local annotation for a paper.",
		parameters: Type.Object({
			paper: Type.String({
				description: "Paper ID to annotate.",
			}),
			note: Type.Optional(
				Type.String({
					description: "Annotation text. Omit when clear=true.",
				}),
			),
			clear: Type.Optional(
				Type.Boolean({
					description: "Clear the existing annotation instead of writing one.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const result = params.clear
				? await clearPaperAnnotation(params.paper)
				: params.note
					? await annotatePaper(params.paper, params.note)
					: (() => {
							throw new Error("Provide either note or clear=true.");
						})();

			return {
				content: [{ type: "text", text: formatToolText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "alpha_list_annotations",
		label: "Alpha List Annotations",
		description: "List all persistent local paper annotations.",
		parameters: Type.Object({}),
		async execute() {
			const result = await listPaperAnnotations();
			return {
				content: [{ type: "text", text: formatToolText(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "alpha_read_code",
		label: "Alpha Read Code",
		description: "Read files from a paper's GitHub repository through alphaXiv.",
		parameters: Type.Object({
			githubUrl: Type.String({
				description: "GitHub repository URL for the paper implementation.",
			}),
			path: Type.Optional(
				Type.String({
					description: "Repository path to inspect. Use / for the repo overview.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const result = await readPaperCode(params.githubUrl, params.path?.trim() || "/");
				return {
					content: [{ type: "text", text: formatToolText(result) }],
					details: result,
				};
			} finally {
				await disconnect();
			}
		},
	});

	pi.registerTool({
		name: "preview_file",
		label: "Preview File",
		description: "Open a markdown, LaTeX, PDF, or code artifact in the browser or a PDF viewer for human review.",
		parameters: Type.Object({
			path: Type.String({
				description: "Path to the file to preview.",
			}),
			target: Type.Optional(
				Type.String({
					description: "Preview target: browser or pdf. Defaults to browser.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const target = (params.target?.trim().toLowerCase() || "browser");
			if (target !== "browser" && target !== "pdf") {
				throw new Error("target must be browser or pdf");
			}

			const resolvedPath = resolvePath(ctx.cwd, params.path);
			const openedPath =
				extname(resolvedPath).toLowerCase() === ".pdf" && target === "pdf"
					? resolvedPath
					: target === "pdf"
						? await renderPdfPreview(resolvedPath)
						: await renderHtmlPreview(resolvedPath);

			await mkdir(dirname(openedPath), { recursive: true }).catch(() => {});
			await openWithDefaultApp(openedPath);

			const result = {
				sourcePath: resolvedPath,
				target,
				openedPath,
			};
			return {
				content: [{ type: "text", text: formatToolText(result) }],
				details: result,
			};
		},
	});
}
