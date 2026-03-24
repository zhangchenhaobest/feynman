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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getExtensionCommandSpec } from "../../metadata/commands.mjs";
import { collapseExcessBlankLines, formatToolText } from "./shared.js";

type JsonRecord = Record<string, unknown>;

type AlphaSearchHit = {
	rank?: number;
	title?: string;
	publishedAt?: string;
	organizations?: string;
	authors?: string;
	abstract?: string;
	arxivId?: string;
	arxivUrl?: string;
	alphaXivUrl?: string;
};

type AlphaSearchSection = {
	count: number;
	results: AlphaSearchHit[];
	note?: string;
};

type AlphaSearchPayload = {
	query?: string;
	mode?: string;
	results?: AlphaSearchHit[];
	semantic?: AlphaSearchSection;
	keyword?: AlphaSearchSection;
	agentic?: AlphaSearchSection;
};

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength = 320): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const collapsed = collapseExcessBlankLines(value)
		.replace(/\s*\n\s*/g, " ")
		.replace(/[ \t]+/g, " ");
	if (!collapsed) {
		return undefined;
	}

	return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…` : collapsed;
}

function sanitizeHit(value: unknown, fallbackRank: number): AlphaSearchHit | null {
	if (!isRecord(value)) {
		return null;
	}

	const title = cleanText(value.title, 220);
	if (!title) {
		return null;
	}

	return {
		rank: typeof value.rank === "number" ? value.rank : fallbackRank,
		title,
		publishedAt: cleanText(value.publishedAt, 48),
		organizations: cleanText(value.organizations, 180),
		authors: cleanText(value.authors, 220),
		abstract: cleanText(value.abstract, 360),
		arxivId: cleanText(value.arxivId, 32),
		arxivUrl: cleanText(value.arxivUrl, 160),
		alphaXivUrl: cleanText(value.alphaXivUrl, 160),
	};
}

function sanitizeHits(value: unknown): AlphaSearchHit[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry, index) => sanitizeHit(entry, index + 1))
		.filter((entry): entry is AlphaSearchHit => entry !== null);
}

function sanitizeSection(value: unknown): AlphaSearchSection {
	if (!isRecord(value)) {
		return { count: 0, results: [] };
	}

	const results = sanitizeHits(value.results);
	const note = results.length === 0 ? cleanText(value.raw, 600) : undefined;

	return {
		count: results.length,
		results,
		...(note ? { note } : {}),
	};
}

export function sanitizeAlphaSearchPayload(value: unknown): AlphaSearchPayload {
	if (!isRecord(value)) {
		return {};
	}

	const payload: AlphaSearchPayload = {
		query: cleanText(value.query, 240),
		mode: cleanText(value.mode, 32),
	};

	const topLevelResults = sanitizeHits(value.results);
	if (topLevelResults.length > 0) {
		payload.results = topLevelResults;
	}

	for (const key of ["semantic", "keyword", "agentic"] as const) {
		if (key in value) {
			payload[key] = sanitizeSection(value[key]);
		}
	}

	return payload;
}

function pushHitLines(lines: string[], hit: AlphaSearchHit): void {
	lines.push(`${hit.rank ?? "?"}. ${hit.title ?? "Untitled result"}`);
	if (hit.arxivId) lines.push(`   arXiv: ${hit.arxivId}`);
	if (hit.publishedAt) lines.push(`   published: ${hit.publishedAt}`);
	if (hit.organizations) lines.push(`   orgs: ${hit.organizations}`);
	if (hit.authors) lines.push(`   authors: ${hit.authors}`);
	if (hit.abstract) lines.push(`   abstract: ${hit.abstract}`);
	if (hit.arxivUrl) lines.push(`   arXiv URL: ${hit.arxivUrl}`);
	if (hit.alphaXivUrl) lines.push(`   alphaXiv URL: ${hit.alphaXivUrl}`);
}

function pushSectionLines(lines: string[], label: string, section: AlphaSearchSection): void {
	lines.push(`${label} (${section.count})`);
	if (section.results.length === 0) {
		lines.push(section.note ? `  note: ${section.note}` : "  no parsed results");
		return;
	}

	for (const hit of section.results) {
		pushHitLines(lines, hit);
	}
}

export function formatAlphaSearchContext(value: unknown): string {
	const payload = sanitizeAlphaSearchPayload(value);
	const lines: string[] = [];

	if (payload.query) lines.push(`query: ${payload.query}`);
	if (payload.mode) lines.push(`mode: ${payload.mode}`);

	if (payload.results) {
		pushSectionLines(lines, "results", { count: payload.results.length, results: payload.results });
	}

	for (const [label, section] of [
		["semantic", payload.semantic],
		["keyword", payload.keyword],
		["agentic", payload.agentic],
	] as const) {
		if (section) {
			pushSectionLines(lines, label, section);
		}
	}

	return lines.length > 0 ? lines.join("\n") : "No alpha search results returned.";
}

export function registerAlphaCommands(pi: ExtensionAPI): void {
	pi.registerCommand("alpha-login", {
		description: getExtensionCommandSpec("alpha-login")?.description ?? "Sign in to alphaXiv from inside Feynman.",
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
		description: getExtensionCommandSpec("alpha-logout")?.description ?? "Clear alphaXiv auth from inside Feynman.",
		handler: async (_args, ctx) => {
			logoutAlpha();
			ctx.ui.notify("alphaXiv auth cleared", "info");
		},
	});

	pi.registerCommand("alpha-status", {
		description: getExtensionCommandSpec("alpha-status")?.description ?? "Show alphaXiv authentication status.",
		handler: async (_args, ctx) => {
			if (!isAlphaLoggedIn()) {
				ctx.ui.notify("alphaXiv not connected", "warning");
				return;
			}

			const name = getAlphaUserName();
			ctx.ui.notify(name ? `alphaXiv connected as ${name}` : "alphaXiv connected", "info");
		},
	});
}

export function registerAlphaTools(pi: ExtensionAPI): void {
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
				const sanitized = sanitizeAlphaSearchPayload(result);
				return {
					content: [{ type: "text", text: formatAlphaSearchContext(sanitized) }],
					details: sanitized,
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
}
