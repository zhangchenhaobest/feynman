import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@mariozechner/pi-coding-agent";

type SlugLock = {
	pid: number;
	sessionId: string;
	startedAt: string;
	planPath: string;
};

type GcResult = {
	deleted: string[];
	kept: string[];
};

type SpillResult = {
	content: { type: "text"; text: string }[];
	details: unknown;
} | undefined;

type ToolResultPatch = {
	content?: { type: "text"; text: string }[];
	details?: unknown;
	isError?: boolean;
};

const BUILT_IN_TOOL_NAMES = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

function isPathInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function pidIsLive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLock(path: string): SlugLock | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as SlugLock;
	} catch {
		return undefined;
	}
}

function lockIsLive(lock: SlugLock | undefined, timeoutMs: number, now = Date.now()): boolean {
	if (!lock) return false;
	const started = Date.parse(lock.startedAt);
	if (!Number.isFinite(started) || now - started > timeoutMs) return false;
	return pidIsLive(lock.pid);
}

function planPathInfo(cwd: string, inputPath: string): { absPath: string; slug: string; lockPath: string } | undefined {
	const absPath = resolve(cwd, inputPath);
	const plansRoot = resolve(cwd, "outputs", ".plans");
	if (!isPathInside(plansRoot, absPath) || !absPath.endsWith(".md")) return undefined;
	const slug = basename(absPath, ".md");
	const lockPath = resolve(cwd, "outputs", ".state", `${slug}.lock`);
	return { absPath, slug, lockPath };
}

export function claimPlanSlug(
	cwd: string,
	sessionId: string,
	inputPath: string,
	options?: { timeoutMinutes?: number; strategy?: "suffix" | "error" | "overwrite"; now?: number },
): { ok: true; lockPath?: string } | { ok: false; reason: string } {
	const info = planPathInfo(cwd, inputPath);
	if (!info) return { ok: true };

	const strategy = options?.strategy ?? (process.env.FEYNMAN_SLUG_COLLISION_STRATEGY as "suffix" | "error" | "overwrite" | undefined) ?? "error";
	if (strategy === "overwrite") return { ok: true };

	const timeoutMinutes = options?.timeoutMinutes ?? (Number(process.env.FEYNMAN_SLUG_LOCK_TIMEOUT_MINUTES) || 30);
	const timeoutMs = timeoutMinutes * 60_000;
	const existingLock = readLock(info.lockPath);
	const live = lockIsLive(existingLock, timeoutMs, options?.now);
	if (live && existingLock?.sessionId !== sessionId) {
		return {
			ok: false,
			reason: `Slug "${info.slug}" is locked by another Feynman session. Use a unique slug such as ${info.slug}-2, or wait for ${info.lockPath} to expire.`,
		};
	}
	if (existsSync(info.absPath) && existingLock?.sessionId !== sessionId) {
		return {
			ok: false,
			reason: `Plan already exists at ${relative(cwd, info.absPath)}. Use a unique slug such as ${info.slug}-2 to avoid overwriting another run.`,
		};
	}

	mkdirSync(dirname(info.lockPath), { recursive: true });
	writeFileSync(
		info.lockPath,
		JSON.stringify({
			pid: process.pid,
			sessionId,
			startedAt: new Date(options?.now ?? Date.now()).toISOString(),
			planPath: info.absPath,
		}, null, 2) + "\n",
		"utf8",
	);
	return { ok: true, lockPath: info.lockPath };
}

function managedRetentionDays(): number {
	const raw = Number(process.env.FEYNMAN_CACHE_RETENTION_DAYS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 14;
}

function gcIgnored(path: string): boolean {
	if (path.endsWith(".gcignore")) return true;
	try {
		return /^---[\s\S]*?retain:\s*true/im.test(readFileSync(path, "utf8").slice(0, 500));
	} catch {
		return false;
	}
}

export function collectManagedGc(
	cwd: string,
	now = Date.now(),
	retentionDays = managedRetentionDays(),
	options?: { dryRun?: boolean },
): GcResult {
	const roots = [
		resolve(cwd, "outputs", ".cache"),
		resolve(cwd, "outputs", ".runs"),
		resolve(cwd, "outputs", ".notes"),
	];
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const result: GcResult = { deleted: [], kept: [] };

	const visit = (path: string) => {
		if (!existsSync(path)) return;
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = resolve(path, entry.name);
			if (entry.isDirectory()) {
				visit(child);
				try {
					if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true });
				} catch {}
				continue;
			}
			if (!entry.isFile()) continue;
			const stat = statSync(child);
			if (gcIgnored(child) || stat.mtimeMs >= cutoff) {
				result.kept.push(child);
				continue;
			}
			if (!options?.dryRun) {
				rmSync(child, { force: true });
			}
			result.deleted.push(child);
		}
	};

	for (const root of roots) visit(root);
	return result;
}

function textFromToolContent(content: ToolResultContent): string {
	return content
		.map((item) => item.type === "text" ? item.text : "")
		.filter(Boolean)
		.join("\n");
}

type ToolResultContent = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

function customToolOutputCapChars(): number {
	const raw = Number(process.env.FEYNMAN_CUSTOM_TOOL_CAP_CHARS);
	return Number.isFinite(raw) && raw > 0 ? raw : 24_000;
}

export function spillLargeCustomToolResult(
	cwd: string,
	toolName: string,
	toolCallId: string,
	content: ToolResultContent,
	details: unknown,
): SpillResult {
	if (BUILT_IN_TOOL_NAMES.has(toolName)) return undefined;
	const text = textFromToolContent(content);
	const cap = customToolOutputCapChars();
	if (text.length <= cap) return undefined;

	const hash = createHash("sha256").update(text).digest("hex");
	const safeToolName = toolName.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "tool";
	const path = resolve(cwd, "outputs", ".runs", `${safeToolName}-${toolCallId}-${hash.slice(0, 12)}.md`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
	const pointer = {
		feynman_spillover: true,
		tool: toolName,
		toolCallId,
		path,
		bytes: Buffer.byteLength(text, "utf8"),
		sha256: hash,
		head: text.slice(0, Math.min(cap, 2_000)),
		note: "Full custom/subagent tool result was written to disk. Read the path in bounded chunks when needed.",
		originalDetails: details,
	};
	return {
		content: [{ type: "text", text: JSON.stringify(pointer, null, 2) }],
		details: pointer,
	};
}

function appendJsonl(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function recordCheckpoint(ctx: ExtensionContext, toolName: string, isError: boolean): void {
	appendJsonl(resolve(ctx.cwd, "outputs", ".state", "feynman.checkpoint.jsonl"), {
		timestamp: new Date().toISOString(),
		sessionId: ctx.sessionManager.getSessionId(),
		toolName,
		isError,
		context: ctx.getContextUsage?.(),
	});
}

function recordJobEvent(ctx: ExtensionContext, toolName: string, status: "running" | "done" | "failed", data: unknown): void {
	appendJsonl(resolve(ctx.cwd, "outputs", ".state", "subagent.jobs.jsonl"), {
		timestamp: new Date().toISOString(),
		sessionId: ctx.sessionManager.getSessionId(),
		toolName,
		status,
		data,
	});
}

function looksLikeSubagentTool(toolName: string): boolean {
	return /subagent|parallel|chain|run/i.test(toolName);
}

export function registerStateManagement(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.FEYNMAN_OUTPUTS_GC === "off") return;
		collectManagedGc(ctx.cwd);
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (isToolCallEventType("write", event)) {
			const claim = claimPlanSlug(ctx.cwd, sessionId, event.input.path);
			if (!claim.ok) return { block: true, reason: claim.reason };
		}
		if (isToolCallEventType("edit", event)) {
			const claim = claimPlanSlug(ctx.cwd, sessionId, event.input.path);
			if (!claim.ok) return { block: true, reason: claim.reason };
		}
		if (looksLikeSubagentTool(event.toolName)) {
			recordJobEvent(ctx, event.toolName, "running", event.input);
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx): Promise<ToolResultPatch | undefined> => {
		recordCheckpoint(ctx, event.toolName, event.isError);
		if (looksLikeSubagentTool(event.toolName)) {
			recordJobEvent(ctx, event.toolName, event.isError ? "failed" : "done", event.details ?? event.content);
		}
		return spillLargeCustomToolResult(ctx.cwd, event.toolName, event.toolCallId, event.content as ToolResultContent, event.details);
	});
}
