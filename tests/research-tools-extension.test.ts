import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { formatToolResultWithSpillover } from "../extensions/research-tools/alpha.js";
import { autoLogPath, writeAutoLogEntry } from "../extensions/research-tools/autolog.js";
import { computeContextPosture } from "../extensions/research-tools/context.js";
import { buildResumePacket } from "../extensions/research-tools/resume.js";
import { buildContextRiskSummary } from "../src/setup/doctor.js";
import { claimPlanSlug, collectManagedGc, spillLargeCustomToolResult } from "../extensions/research-tools/state.js";

function fakeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		model: {
			provider: "test",
			id: "small",
			contextWindow: 32_000,
		},
		getContextUsage: () => ({
			tokens: 24_000,
			contextWindow: 32_000,
			percent: 75,
		}),
		sessionManager: {
			getSessionId: () => "session-1",
		},
	} as unknown as ExtensionContext;
}

test("alpha tool spillover writes oversized output to outputs cache", () => {
	const root = mkdtempSync(join(tmpdir(), "feynman-spill-"));
	const originalCap = process.env.FEYNMAN_TOOL_OUTPUT_CAP_CHARS;
	process.env.FEYNMAN_TOOL_OUTPUT_CAP_CHARS = "64";
	try {
		const result = formatToolResultWithSpillover(fakeCtx(root), "alpha_get_paper", { text: "x".repeat(500) });
		const parsed = JSON.parse(result.text) as { path: string; feynman_spillover: boolean };
		assert.equal(parsed.feynman_spillover, true);
		assert.equal(existsSync(parsed.path), true);
		assert.match(readFileSync(parsed.path, "utf8"), /xxxxx/);
		assert.match(parsed.path, /outputs\/\.cache\/alpha_get_paper-/);
	} finally {
		if (originalCap === undefined) {
			delete process.env.FEYNMAN_TOOL_OUTPUT_CAP_CHARS;
		} else {
			process.env.FEYNMAN_TOOL_OUTPUT_CAP_CHARS = originalCap;
		}
	}
});

test("context_report posture uses Pi context usage directly", () => {
	const report = computeContextPosture(fakeCtx("/tmp"));
	assert.equal(report.model, "test/small");
	assert.equal(report.contextWindow, 32_000);
	assert.equal(report.estimatedInputTokens, 24_000);
	assert.equal(report.compactionThresholdHit, true);
	assert.equal(report.recommendedMaxWorkers, 1);
});

test("autolog writes dated jsonl entries under notes", () => {
	const root = mkdtempSync(join(tmpdir(), "feynman-autolog-"));
	writeAutoLogEntry(root, { role: "user", text: "hello" });
	const path = autoLogPath(root);
	assert.equal(existsSync(path), true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8").trim()), { role: "user", text: "hello" });
});

test("resume packet summarizes recent plans and changelog from disk", () => {
	const root = mkdtempSync(join(tmpdir(), "feynman-resume-"));
	mkdirSync(resolve(root, "outputs", ".plans"), { recursive: true });
	mkdirSync(resolve(root, "outputs", ".state"), { recursive: true });
	const planPath = resolve(root, "outputs", ".plans", "demo.md");
	const statePath = resolve(root, "outputs", ".state", "demo.jobs.jsonl");
	writeFileSyncSafe(planPath, "# Plan\n\n- next step");
	writeFileSyncSafe(statePath, "{\"status\":\"running\"}\n");
	writeFileSyncSafe(resolve(root, "CHANGELOG.md"), "## Entry\n- verified\n");
	const packet = buildResumePacket(root);
	assert.ok(packet);
	assert.match(packet!, /Recent plans/);
	assert.match(packet!, /demo\.md/);
	assert.match(packet!, /CHANGELOG tail/);
});

test("doctor context risk uses Pi model context window and compaction settings", () => {
	const summary = buildContextRiskSummary(
		{ compaction: { reserveTokens: 4096, keepRecentTokens: 8000 }, retry: { maxRetries: 2 } },
		{ provider: "local", id: "qwen", contextWindow: 32_000, maxTokens: 4096, reasoning: true },
	);
	assert.equal(summary.level, "high");
	assert.match(summary.lines.join("\n"), /Pi compaction: reserve=4096, keepRecent=8000/);
	assert.match(summary.lines.join("\n"), /Pi retry: maxRetries=2/);
});

test("slug lock blocks overwriting an existing plan from another session", () => {
	const root = mkdtempSync(join(tmpdir(), "feynman-slug-"));
	const planPath = resolve(root, "outputs", ".plans", "demo.md");
	writeFileSyncSafe(planPath, "# Existing\n");

	const result = claimPlanSlug(root, "session-2", "outputs/.plans/demo.md");

	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.reason, /Plan already exists/);
	}
});

test("managed cache gc deletes stale cache files and honors dry-run", () => {
	const root = mkdtempSync(join(tmpdir(), "feynman-gc-"));
	const cachePath = resolve(root, "outputs", ".cache", "old.md");
	writeFileSyncSafe(cachePath, "old");
	const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	utimesSync(cachePath, old, old);

	const preview = collectManagedGc(root, Date.now(), 14, { dryRun: true });
	assert.equal(preview.deleted.length, 1);
	assert.equal(existsSync(cachePath), true);

	const actual = collectManagedGc(root, Date.now(), 14);
	assert.equal(actual.deleted.length, 1);
	assert.equal(existsSync(cachePath), false);
});

test("large custom tool results spill to outputs runs", () => {
	const root = mkdtempSync(join(tmpdir(), "feynman-subagent-spill-"));
	const originalCap = process.env.FEYNMAN_CUSTOM_TOOL_CAP_CHARS;
	process.env.FEYNMAN_CUSTOM_TOOL_CAP_CHARS = "50";
	try {
		const result = spillLargeCustomToolResult(
			root,
			"subagent",
			"call-1",
			[{ type: "text", text: "x".repeat(200) }],
			{ ok: true },
		);
		assert.ok(result);
		const parsed = JSON.parse(result!.content[0]!.text) as { path: string; feynman_spillover: boolean };
		assert.equal(parsed.feynman_spillover, true);
		assert.match(parsed.path, /outputs\/\.runs\/subagent-call-1-/);
		assert.equal(existsSync(parsed.path), true);
	} finally {
		if (originalCap === undefined) {
			delete process.env.FEYNMAN_CUSTOM_TOOL_CAP_CHARS;
		} else {
			process.env.FEYNMAN_CUSTOM_TOOL_CAP_CHARS = originalCap;
		}
	}
});

function writeFileSyncSafe(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}
