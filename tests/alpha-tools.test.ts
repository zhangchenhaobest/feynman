import test from "node:test";
import assert from "node:assert/strict";

import { formatAlphaSearchContext, sanitizeAlphaSearchPayload } from "../extensions/research-tools/alpha.js";
import { formatToolText } from "../extensions/research-tools/shared.js";

test("sanitizeAlphaSearchPayload drops raw alpha search text while keeping parsed hits", () => {
	const payload = sanitizeAlphaSearchPayload({
		query: "scaling laws",
		mode: "all",
		semantic: {
			raw: "\n\n\n1. **Paper A**\n- Abstract: noisy raw block",
			results: [
				{
					rank: 1,
					title: "Paper A",
					publishedAt: "2025-09-28",
					organizations: "Stanford University, EPFL",
					authors: "A. Author, B. Author",
					abstract: "Line one.\n\n\nLine two.",
					arxivId: "2509.24012",
					arxivUrl: "https://arxiv.org/abs/2509.24012",
					alphaXivUrl: "https://www.alphaxiv.org/overview/2509.24012",
					raw: "internal raw block that should be dropped",
				},
			],
		},
		keyword: {
			raw: "\n\n\nNoisy keyword fallback",
			results: [],
		},
	});

	assert.deepEqual(payload, {
		query: "scaling laws",
		mode: "all",
		semantic: {
			count: 1,
			results: [
				{
					rank: 1,
					title: "Paper A",
					publishedAt: "2025-09-28",
					organizations: "Stanford University, EPFL",
					authors: "A. Author, B. Author",
					abstract: "Line one. Line two.",
					arxivId: "2509.24012",
					arxivUrl: "https://arxiv.org/abs/2509.24012",
					alphaXivUrl: "https://www.alphaxiv.org/overview/2509.24012",
				},
			],
		},
		keyword: {
			count: 0,
			results: [],
			note: "Noisy keyword fallback",
		},
	});
});

test("formatAlphaSearchContext emits compact model-facing text without raw JSON escapes", () => {
	const text = formatAlphaSearchContext({
		query: "scaling laws",
		mode: "semantic",
		results: [
			{
				rank: 1,
				title: "Paper A",
				abstract: "First line.\n\n\nSecond line.",
				arxivId: "2509.24012",
				raw: "should not appear",
			},
		],
		raw: "\n\n\nvery noisy raw payload",
	});

	assert.match(text, /query: scaling laws/);
	assert.match(text, /1\. Paper A/);
	assert.match(text, /abstract: First line\. Second line\./);
	assert.ok(!text.includes("\\n"));
	assert.ok(!text.includes("raw"));
});

test("formatToolText collapses excess blank lines in plain strings", () => {
	assert.equal(formatToolText("alpha\n\n\n\nbeta"), "alpha\n\nbeta");
});
