import "dotenv/config";

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import {
	getUserName as getAlphaUserName,
	isLoggedIn as isAlphaLoggedIn,
	login as loginAlpha,
	logout as logoutAlpha,
} from "@companion-ai/alpha-hub/lib";
import {
	ModelRegistry,
	AuthStorage,
} from "@mariozechner/pi-coding-agent";

import { buildFeynmanSystemPrompt } from "./feynman-prompt.js";

type ThinkingLevel = "off" | "low" | "medium" | "high";
type Rgb = { r: number; g: number; b: number };
type ThemeColorValue = string | number;
type ThemeJson = {
	$schema?: string;
	name: string;
	vars?: Record<string, ThemeColorValue>;
	colors: Record<string, ThemeColorValue>;
	export?: Record<string, ThemeColorValue>;
};

const OSC11_QUERY = "\u001b]11;?\u0007";
const OSC11_RESPONSE_PATTERN =
	/\u001b]11;(?:rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})|#?([0-9a-fA-F]{6}))(?:\u0007|\u001b\\)/;
const DEFAULT_SAGE_RGB: Rgb = { r: 0x88, g: 0xa8, b: 0x8a };

function parseHexComponent(component: string): number {
	const value = Number.parseInt(component, 16);
	if (Number.isNaN(value)) {
		throw new Error(`Invalid OSC 11 component: ${component}`);
	}
	if (component.length === 2) {
		return value;
	}
	return Math.round(value / ((1 << (component.length * 4)) - 1) * 255);
}

function parseHexColor(color: string): Rgb | undefined {
	const match = color.trim().match(/^#?([0-9a-fA-F]{6})$/);
	if (!match) {
		return undefined;
	}

	return {
		r: Number.parseInt(match[1].slice(0, 2), 16),
		g: Number.parseInt(match[1].slice(2, 4), 16),
		b: Number.parseInt(match[1].slice(4, 6), 16),
	};
}

function rgbToHex(rgb: Rgb): string {
	return `#${[rgb.r, rgb.g, rgb.b]
		.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0"))
		.join("")}`;
}

function blendRgb(base: Rgb, tint: Rgb, alpha: number): Rgb {
	const mix = (baseChannel: number, tintChannel: number) =>
		baseChannel + (tintChannel - baseChannel) * alpha;
	return {
		r: mix(base.r, tint.r),
		g: mix(base.g, tint.g),
		b: mix(base.b, tint.b),
	};
}

function isLightRgb(rgb: Rgb): boolean {
	const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
	return luminance >= 0.6;
}

function resolveThemeColorValue(
	value: ThemeColorValue | undefined,
	vars: Record<string, ThemeColorValue> | undefined,
	visited = new Set<string>(),
): ThemeColorValue | undefined {
	if (value === undefined || typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (!vars || !(value in vars) || visited.has(value)) {
		return value;
	}
	visited.add(value);
	return resolveThemeColorValue(vars[value], vars, visited);
}

function resolveThemeRgb(
	value: ThemeColorValue | undefined,
	vars: Record<string, ThemeColorValue> | undefined,
): Rgb | undefined {
	const resolved = resolveThemeColorValue(value, vars);
	return typeof resolved === "string" ? parseHexColor(resolved) : undefined;
}

function deriveMessageBackgrounds(themeJson: ThemeJson, terminalBackgroundHex: string): Pick<ThemeJson["colors"], "userMessageBg" | "customMessageBg"> | undefined {
	const terminalBackground = parseHexColor(terminalBackgroundHex);
	if (!terminalBackground) {
		return undefined;
	}

	const tint =
		resolveThemeRgb(themeJson.colors.accent, themeJson.vars) ??
		resolveThemeRgb(themeJson.vars?.sage, themeJson.vars) ??
		DEFAULT_SAGE_RGB;
	const lightBackground = isLightRgb(terminalBackground);
	const userAlpha = lightBackground ? 0.15 : 0.23;
	const customAlpha = lightBackground ? 0.11 : 0.17;

	return {
		userMessageBg: rgbToHex(blendRgb(terminalBackground, tint, userAlpha)),
		customMessageBg: rgbToHex(blendRgb(terminalBackground, tint, customAlpha)),
	};
}

async function probeTerminalBackgroundHex(timeoutMs = 120): Promise<string | undefined> {
	if (typeof process.env.FEYNMAN_TERMINAL_BG === "string" && process.env.FEYNMAN_TERMINAL_BG.trim()) {
		return process.env.FEYNMAN_TERMINAL_BG.trim();
	}
	if (typeof process.env.PI_TERMINAL_BG === "string" && process.env.PI_TERMINAL_BG.trim()) {
		return process.env.PI_TERMINAL_BG.trim();
	}
	if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
		return undefined;
	}

	const wasRaw = "isRaw" in input ? Boolean((input as typeof input & { isRaw?: boolean }).isRaw) : false;
	const wasFlowing = "readableFlowing" in input
		? (input as typeof input & { readableFlowing?: boolean | null }).readableFlowing
		: null;

	return await new Promise<string | undefined>((resolve) => {
		let settled = false;
		let buffer = "";

		const finish = (value: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			input.off("data", onData);
			try {
				if (!wasRaw) {
					input.setRawMode(false);
				}
			} catch {
				// Ignore raw mode restore failures and return best-effort detection.
			}
			if (wasFlowing !== true) {
				input.pause();
			}
			resolve(value);
		};

		const onData = (chunk: string | Buffer) => {
			buffer += chunk.toString("utf8");
			const match = buffer.match(OSC11_RESPONSE_PATTERN);
			if (!match) {
				if (buffer.length > 512) {
					finish(undefined);
				}
				return;
			}

			if (match[4]) {
				finish(`#${match[4].toLowerCase()}`);
				return;
			}

			try {
				finish(
					rgbToHex({
						r: parseHexComponent(match[1]),
						g: parseHexComponent(match[2]),
						b: parseHexComponent(match[3]),
					}),
				);
			} catch {
				finish(undefined);
			}
		};

		const timer = setTimeout(() => finish(undefined), timeoutMs);
		input.on("data", onData);

		try {
			if (!wasRaw) {
				input.setRawMode(true);
			}
			output.write(OSC11_QUERY);
		} catch {
			finish(undefined);
		}
	});
}

function printHelp(): void {
	console.log(`Feynman commands:
	  /help                     Show this help
	  /init                     Initialize AGENTS.md and session-log folders
	  /alpha-login              Sign in to alphaXiv
	  /alpha-logout             Clear alphaXiv auth
	  /alpha-status             Show alphaXiv auth status
	  /new                      Start a fresh persisted session
	  /exit                     Quit the REPL
	  /lit <topic>              Expand the literature review prompt template
	  /related <topic>          Map related work and justify the research gap
	  /review <artifact>        Simulate a peer review for an AI research artifact
	  /ablate <artifact>        Design the minimum convincing ablation set
	  /rebuttal <artifact>      Draft a rebuttal and revision matrix
	  /replicate <paper>        Expand the replication prompt template
	  /reading <topic>          Expand the reading list prompt template
	  /memo <topic>             Expand the general research memo prompt template
	  /deepresearch <topic>     Expand the thorough source-heavy research prompt template
	  /autoresearch <idea>      Expand the idea-to-paper autoresearch prompt template
	  /compare <topic>          Expand the source comparison prompt template
	  /audit <item>             Expand the paper/code audit prompt template
	  /draft <topic>            Expand the paper-style writing prompt template
	  /log                      Write a durable session log
	  /watch <topic>            Create a recurring or deferred research watch
	  /jobs                     Inspect active background work

	Package-powered workflows:
	  /agents                   Open the subagent and chain manager
	  /run /chain /parallel     Delegate research work to subagents
	  /ps                       Open the background process panel
	  /schedule-prompt          Manage deferred and recurring jobs
	  /search                   Search prior indexed sessions
	  /preview                  Preview generated markdown or code artifacts

	CLI flags:
  --prompt "<text>"         Run one prompt and exit
  --alpha-login             Sign in to alphaXiv and exit
  --alpha-logout            Clear alphaXiv auth and exit
  --alpha-status            Show alphaXiv auth status and exit
  --model provider:model    Force a specific model
  --thinking level          off | low | medium | high
  --cwd /path/to/workdir    Working directory for tools
  --session-dir /path       Session storage directory
  --doctor                  Check Feynman auth, models, preview tools, and paths
  --setup-preview           Install preview dependencies when possible

Top-level:
  feynman setup             Configure alpha login, web search, and preview deps
  feynman setup alpha       Configure alphaXiv login
  feynman setup web         Configure web search provider
  feynman setup preview     Install preview dependencies`);
}

function parseModelSpec(spec: string, modelRegistry: ModelRegistry) {
	const trimmed = spec.trim();
	const separator = trimmed.includes(":") ? ":" : trimmed.includes("/") ? "/" : null;
	if (!separator) {
		return undefined;
	}

	const [provider, ...rest] = trimmed.split(separator);
	const id = rest.join(separator);
	if (!provider || !id) {
		return undefined;
	}

	return modelRegistry.find(provider, id);
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value.toLowerCase();
	if (normalized === "off" || normalized === "low" || normalized === "medium" || normalized === "high") {
		return normalized;
	}

	return undefined;
}

function resolveExecutable(name: string, fallbackPaths: string[] = []): string | undefined {
	for (const candidate of fallbackPaths) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	const result = spawnSync("sh", ["-lc", `command -v ${name}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});

	if (result.status === 0) {
		const resolved = result.stdout.trim();
		if (resolved) {
			return resolved;
		}
	}

	return undefined;
}

function patchEmbeddedPiBranding(piPackageRoot: string): void {
	const packageJsonPath = resolve(piPackageRoot, "package.json");
	const cliPath = resolve(piPackageRoot, "dist", "cli.js");
	const interactiveModePath = resolve(piPackageRoot, "dist", "modes", "interactive", "interactive-mode.js");
	const footerPath = resolve(piPackageRoot, "dist", "modes", "interactive", "components", "footer.js");

	if (existsSync(packageJsonPath)) {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			piConfig?: { name?: string; configDir?: string };
		};
		if (pkg.piConfig?.name !== "feynman") {
			pkg.piConfig = {
				...pkg.piConfig,
				name: "feynman",
			};
			writeFileSync(packageJsonPath, JSON.stringify(pkg, null, "\t") + "\n", "utf8");
		}
	}

	if (existsSync(cliPath)) {
		const cliSource = readFileSync(cliPath, "utf8");
		if (cliSource.includes('process.title = "pi";')) {
			writeFileSync(cliPath, cliSource.replace('process.title = "pi";', 'process.title = "feynman";'), "utf8");
		}
	}

	if (existsSync(interactiveModePath)) {
		const interactiveModeSource = readFileSync(interactiveModePath, "utf8");
		if (interactiveModeSource.includes("`π - ${sessionName} - ${cwdBasename}`")) {
			writeFileSync(
				interactiveModePath,
				interactiveModeSource
					.replace("`π - ${sessionName} - ${cwdBasename}`", "`feynman - ${sessionName} - ${cwdBasename}`")
					.replace("`π - ${cwdBasename}`", "`feynman - ${cwdBasename}`"),
				"utf8",
			);
		}
	}

	if (existsSync(footerPath)) {
		const footerSource = readFileSync(footerPath, "utf8");
		const footerOriginal = [
			'        // Add thinking level indicator if model supports reasoning',
			'        let rightSideWithoutProvider = modelName;',
			'        if (state.model?.reasoning) {',
			'            const thinkingLevel = state.thinkingLevel || "off";',
			'            rightSideWithoutProvider =',
			'                thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;',
			'        }',
			'        // Prepend the provider in parentheses if there are multiple providers and there\'s enough room',
			'        let rightSide = rightSideWithoutProvider;',
			'        if (this.footerData.getAvailableProviderCount() > 1 && state.model) {',
			'            rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;',
		].join("\n");
		const footerReplacement = [
			'        // Add thinking level indicator if model supports reasoning',
			'        const modelLabel = theme.fg("accent", modelName);',
			'        let rightSideWithoutProvider = modelLabel;',
			'        if (state.model?.reasoning) {',
			'            const thinkingLevel = state.thinkingLevel || "off";',
			'            const separator = theme.fg("dim", " • ");',
			'            rightSideWithoutProvider = thinkingLevel === "off"',
			'                ? `${modelLabel}${separator}${theme.fg("muted", "thinking off")}`',
			'                : `${modelLabel}${separator}${theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel)}`;',
			'        }',
			'        // Prepend the provider in parentheses if there are multiple providers and there\'s enough room',
			'        let rightSide = rightSideWithoutProvider;',
			'        if (this.footerData.getAvailableProviderCount() > 1 && state.model) {',
			'            rightSide = `${theme.fg("muted", `(${state.model.provider})`)} ${rightSideWithoutProvider}`;',
		].join("\n");
		if (footerSource.includes(footerOriginal)) {
			writeFileSync(footerPath, footerSource.replace(footerOriginal, footerReplacement), "utf8");
		}
	}
}

function patchPackageWorkspace(appRoot: string): void {
	const workspaceRoot = resolve(appRoot, ".pi", "npm", "node_modules");
	const webAccessPath = resolve(workspaceRoot, "pi-web-access", "index.ts");
	const sessionSearchIndexerPath = resolve(
		workspaceRoot,
		"@kaiserlich-dev",
		"pi-session-search",
		"extensions",
		"indexer.ts",
	);
	const piMemoryPath = resolve(workspaceRoot, "@samfp", "pi-memory", "src", "index.ts");

	if (existsSync(webAccessPath)) {
		const source = readFileSync(webAccessPath, "utf8");
		if (source.includes('pi.registerCommand("search",')) {
			writeFileSync(
				webAccessPath,
				source.replace('pi.registerCommand("search",', 'pi.registerCommand("web-results",'),
				"utf8",
			);
		}
	}

	if (existsSync(sessionSearchIndexerPath)) {
		const source = readFileSync(sessionSearchIndexerPath, "utf8");
		const original = 'const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");';
		const replacement =
			'const sessionsDir = process.env.FEYNMAN_SESSION_DIR ?? process.env.PI_SESSION_DIR ?? path.join(os.homedir(), ".pi", "agent", "sessions");';
		if (source.includes(original)) {
			writeFileSync(sessionSearchIndexerPath, source.replace(original, replacement), "utf8");
		}
	}

	if (existsSync(piMemoryPath)) {
		let source = readFileSync(piMemoryPath, "utf8");
		const memoryOriginal = 'const MEMORY_DIR = join(homedir(), ".pi", "memory");';
		const memoryReplacement =
			'const MEMORY_DIR = process.env.FEYNMAN_MEMORY_DIR ?? process.env.PI_MEMORY_DIR ?? join(homedir(), ".pi", "memory");';
		if (source.includes(memoryOriginal)) {
			source = source.replace(memoryOriginal, memoryReplacement);
		}

		const execOriginal = 'const result = await pi.exec("pi", ["-p", prompt, "--print"], {';
		const execReplacement = [
			'const execBinary = process.env.FEYNMAN_NODE_EXECUTABLE || process.env.FEYNMAN_EXECUTABLE || "pi";',
			'      const execArgs = process.env.FEYNMAN_BIN_PATH',
			'        ? [process.env.FEYNMAN_BIN_PATH, "--prompt", prompt]',
			'        : ["-p", prompt, "--print"];',
			'      const result = await pi.exec(execBinary, execArgs, {',
		].join("\n");
		if (source.includes(execOriginal)) {
			source = source.replace(execOriginal, execReplacement);
		}

		writeFileSync(piMemoryPath, source, "utf8");
	}
}

function choosePreferredModel(
	availableModels: Array<{ provider: string; id: string }>,
): { provider: string; id: string } | undefined {
	const preferences = [
		{ provider: "anthropic", id: "claude-opus-4-6" },
		{ provider: "anthropic", id: "claude-opus-4-5" },
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "openai", id: "gpt-5.4" },
		{ provider: "openai", id: "gpt-5" },
	];

	for (const preferred of preferences) {
		const match = availableModels.find(
			(model) => model.provider === preferred.provider && model.id === preferred.id,
		);
		if (match) {
			return match;
		}
	}

	return availableModels[0];
}

function normalizeFeynmanSettings(
	settingsPath: string,
	bundledSettingsPath: string,
	defaultThinkingLevel: ThinkingLevel,
	authPath: string,
): void {
	let settings: Record<string, unknown> = {};

	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch {
			settings = {};
		}
	}
	else if (existsSync(bundledSettingsPath)) {
		try {
			settings = JSON.parse(readFileSync(bundledSettingsPath, "utf8"));
		} catch {
			settings = {};
		}
	}

	if (!settings.defaultThinkingLevel) {
		settings.defaultThinkingLevel = defaultThinkingLevel;
	}
	settings.theme = "feynman";
	settings.quietStartup = true;
	settings.collapseChangelog = true;

	const authStorage = AuthStorage.create(authPath);
	const modelRegistry = new ModelRegistry(authStorage);
	const availableModels = modelRegistry.getAvailable().map((model) => ({
		provider: model.provider,
		id: model.id,
	}));

	if ((!settings.defaultProvider || !settings.defaultModel) && availableModels.length > 0) {
		const preferredModel = choosePreferredModel(availableModels);
		if (preferredModel) {
			settings.defaultProvider = preferredModel.provider;
			settings.defaultModel = preferredModel.id;
		}
	}

	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function readJson(path: string): Record<string, unknown> {
	if (!existsSync(path)) {
		return {};
	}

	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

function getWebSearchConfigPath(): string {
	return resolve(homedir(), ".pi", "web-search.json");
}

function loadWebSearchConfig(): Record<string, unknown> {
	return readJson(getWebSearchConfigPath());
}

function saveWebSearchConfig(config: Record<string, unknown>): void {
	const path = getWebSearchConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function hasConfiguredWebProvider(): boolean {
	const config = loadWebSearchConfig();
	return typeof config.perplexityApiKey === "string" && config.perplexityApiKey.trim().length > 0
		|| typeof config.geminiApiKey === "string" && config.geminiApiKey.trim().length > 0;
}

async function promptText(question: string, defaultValue = ""): Promise<string> {
	if (!input.isTTY || !output.isTTY) {
		throw new Error("feynman setup requires an interactive terminal.");
	}
	const rl = createInterface({ input, output });
	try {
		const suffix = defaultValue ? ` [${defaultValue}]` : "";
		const value = (await rl.question(`${question}${suffix}: `)).trim();
		return value || defaultValue;
	} finally {
		rl.close();
	}
}

async function promptChoice(question: string, choices: string[], defaultIndex = 0): Promise<number> {
	console.log(question);
	for (const [index, choice] of choices.entries()) {
		const marker = index === defaultIndex ? "*" : " ";
		console.log(`  ${marker} ${index + 1}. ${choice}`);
	}
	const answer = await promptText("Select", String(defaultIndex + 1));
	const parsed = Number(answer);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > choices.length) {
		return defaultIndex;
	}
	return parsed - 1;
}

async function setupWebProvider(): Promise<void> {
	const config = loadWebSearchConfig();
	const choices = [
		"Gemini API key",
		"Perplexity API key",
		"Browser Gemini (manual sign-in only)",
		"Skip",
	];
	const selection = await promptChoice("Choose a web search provider for Feynman:", choices, hasConfiguredWebProvider() ? 3 : 0);

	if (selection === 0) {
		const key = await promptText("Gemini API key");
		if (key) {
			config.geminiApiKey = key;
			delete config.perplexityApiKey;
			saveWebSearchConfig(config);
			console.log("Saved Gemini API key to ~/.pi/web-search.json");
		}
		return;
	}

	if (selection === 1) {
		const key = await promptText("Perplexity API key");
		if (key) {
			config.perplexityApiKey = key;
			delete config.geminiApiKey;
			saveWebSearchConfig(config);
			console.log("Saved Perplexity API key to ~/.pi/web-search.json");
		}
		return;
	}

	if (selection === 2) {
		console.log("Sign into gemini.google.com in Chrome, Chromium, Brave, or Edge, then restart Feynman.");
		return;
	}
}

async function runSetup(
	section: string | undefined,
	settingsPath: string,
	bundledSettingsPath: string,
	authPath: string,
	workingDir: string,
	sessionDir: string,
): Promise<void> {
	if (section === "alpha" || !section) {
		if (!isAlphaLoggedIn()) {
			await loginAlpha();
			console.log("alphaXiv login complete");
		} else {
			console.log("alphaXiv login already configured");
		}
		if (section === "alpha") return;
	}

	if (section === "web" || !section) {
		await setupWebProvider();
		if (section === "web") return;
	}

	if (section === "preview" || !section) {
		setupPreviewDependencies();
		if (section === "preview") return;
	}

	normalizeFeynmanSettings(settingsPath, bundledSettingsPath, "medium", authPath);
	runDoctor(settingsPath, authPath, sessionDir, workingDir);
}

function runDoctor(
	settingsPath: string,
	authPath: string,
	sessionDir: string,
	workingDir: string,
): void {
	const settings = readJson(settingsPath);
	const modelRegistry = new ModelRegistry(AuthStorage.create(authPath));
	const availableModels = modelRegistry.getAvailable();
	const pandocPath = resolveExecutable("pandoc", [
		"/opt/homebrew/bin/pandoc",
		"/usr/local/bin/pandoc",
	]);
	const browserPath =
		process.env.PUPPETEER_EXECUTABLE_PATH ??
		resolveExecutable("google-chrome", [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		]);

	console.log("Feynman doctor");
	console.log("");
	console.log(`working dir: ${workingDir}`);
	console.log(`session dir: ${sessionDir}`);
	console.log("");
	console.log(`alphaXiv auth: ${isAlphaLoggedIn() ? "ok" : "missing"}`);
	if (isAlphaLoggedIn()) {
		const name = getAlphaUserName();
		if (name) {
			console.log(`  user: ${name}`);
		}
	}
	console.log(`models available: ${availableModels.length}`);
	if (availableModels.length > 0) {
		const sample = availableModels
			.slice(0, 6)
			.map((model) => `${model.provider}/${model.id}`)
			.join(", ");
		console.log(`  sample: ${sample}`);
	}
	console.log(
		`default model: ${typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string"
			? `${settings.defaultProvider}/${settings.defaultModel}`
			: "not set"}`,
	);
	console.log(`pandoc: ${pandocPath ?? "missing"}`);
	console.log(`browser preview runtime: ${browserPath ?? "missing"}`);
	console.log(`web research provider: ${hasConfiguredWebProvider() ? "configured" : "missing"}`);
	console.log(`quiet startup: ${settings.quietStartup === true ? "enabled" : "disabled"}`);
	console.log(`theme: ${typeof settings.theme === "string" ? settings.theme : "not set"}`);
	console.log(`setup hint: feynman setup`);
}

function setupPreviewDependencies(): void {
	const pandocPath = resolveExecutable("pandoc", [
		"/opt/homebrew/bin/pandoc",
		"/usr/local/bin/pandoc",
	]);
	if (pandocPath) {
		console.log(`pandoc already installed at ${pandocPath}`);
		return;
	}

	const brewPath = resolveExecutable("brew", [
		"/opt/homebrew/bin/brew",
		"/usr/local/bin/brew",
	]);
	if (process.platform === "darwin" && brewPath) {
		const result = spawnSync(brewPath, ["install", "pandoc"], { stdio: "inherit" });
		if (result.status !== 0) {
			throw new Error("Failed to install pandoc via Homebrew.");
		}
		console.log("Preview dependency installed: pandoc");
		return;
	}

	throw new Error("Automatic preview setup is only supported on macOS with Homebrew right now.");
}

function syncDirectory(sourceDir: string, targetDir: string): void {
	if (!existsSync(sourceDir)) {
		return;
	}

	mkdirSync(targetDir, { recursive: true });
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const sourcePath = resolve(sourceDir, entry.name);
		const targetPath = resolve(targetDir, entry.name);

		if (entry.isDirectory()) {
			syncDirectory(sourcePath, targetPath);
			continue;
		}

		if (entry.isFile()) {
			writeFileSync(targetPath, readFileSync(sourcePath, "utf8"), "utf8");
		}
	}
}

function syncFeynmanTheme(appRoot: string, agentDir: string, terminalBackgroundHex?: string): void {
	const sourceThemePath = resolve(appRoot, ".pi", "themes", "feynman.json");
	const targetThemeDir = resolve(agentDir, "themes");
	const targetThemePath = resolve(targetThemeDir, "feynman.json");

	if (!existsSync(sourceThemePath)) {
		return;
	}

	mkdirSync(targetThemeDir, { recursive: true });

	const sourceTheme = readFileSync(sourceThemePath, "utf8");
	if (!terminalBackgroundHex) {
		writeFileSync(targetThemePath, sourceTheme, "utf8");
		return;
	}

	try {
		const parsedTheme = JSON.parse(sourceTheme) as ThemeJson;
		const derivedBackgrounds = deriveMessageBackgrounds(parsedTheme, terminalBackgroundHex);
		if (!derivedBackgrounds) {
			writeFileSync(targetThemePath, sourceTheme, "utf8");
			return;
		}

		const generatedTheme: ThemeJson = {
			...parsedTheme,
			colors: {
				...parsedTheme.colors,
				...derivedBackgrounds,
			},
		};
		writeFileSync(targetThemePath, JSON.stringify(generatedTheme, null, 2) + "\n", "utf8");
	} catch {
		writeFileSync(targetThemePath, sourceTheme, "utf8");
	}
}

function syncFeynmanAgents(appRoot: string, agentDir: string): void {
	syncDirectory(resolve(appRoot, ".pi", "agents"), resolve(agentDir, "agents"));
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const appRoot = resolve(here, "..");
	const piPackageRoot = resolve(appRoot, "node_modules", "@mariozechner", "pi-coding-agent");
	const piCliPath = resolve(appRoot, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js");
	const feynmanAgentDir = resolve(homedir(), ".feynman", "agent");
	const bundledSettingsPath = resolve(appRoot, ".pi", "settings.json");
	patchEmbeddedPiBranding(piPackageRoot);
	patchPackageWorkspace(appRoot);

	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			cwd: { type: "string" },
			doctor: { type: "boolean" },
			help: { type: "boolean" },
			"alpha-login": { type: "boolean" },
			"alpha-logout": { type: "boolean" },
			"alpha-status": { type: "boolean" },
			model: { type: "string" },
			"new-session": { type: "boolean" },
			prompt: { type: "string" },
			"session-dir": { type: "string" },
			"setup-preview": { type: "boolean" },
			thinking: { type: "string" },
		},
	});

	if (values.help) {
		printHelp();
		return;
	}

	const workingDir = resolve(values.cwd ?? process.cwd());
	const sessionDir = resolve(values["session-dir"] ?? resolve(homedir(), ".feynman", "sessions"));
	const terminalBackgroundHex = await probeTerminalBackgroundHex();
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(feynmanAgentDir, { recursive: true });
	syncFeynmanTheme(appRoot, feynmanAgentDir, terminalBackgroundHex);
	syncFeynmanAgents(appRoot, feynmanAgentDir);
	const feynmanSettingsPath = resolve(feynmanAgentDir, "settings.json");
	const feynmanAuthPath = resolve(feynmanAgentDir, "auth.json");
	const thinkingLevel = normalizeThinkingLevel(values.thinking ?? process.env.FEYNMAN_THINKING) ?? "medium";
	normalizeFeynmanSettings(feynmanSettingsPath, bundledSettingsPath, thinkingLevel, feynmanAuthPath);

	if (positionals[0] === "setup") {
		await runSetup(positionals[1], feynmanSettingsPath, bundledSettingsPath, feynmanAuthPath, workingDir, sessionDir);
		return;
	}

	if (values.doctor) {
		runDoctor(feynmanSettingsPath, feynmanAuthPath, sessionDir, workingDir);
		return;
	}

	if (values["setup-preview"]) {
		setupPreviewDependencies();
		return;
	}

	if (values["alpha-login"]) {
		const result = await loginAlpha();
		normalizeFeynmanSettings(feynmanSettingsPath, bundledSettingsPath, thinkingLevel, feynmanAuthPath);
		const name =
			(result.userInfo &&
			typeof result.userInfo === "object" &&
			"name" in result.userInfo &&
			typeof result.userInfo.name === "string")
				? result.userInfo.name
				: getAlphaUserName();
		console.log(name ? `alphaXiv login complete: ${name}` : "alphaXiv login complete");
		return;
	}

	if (values["alpha-logout"]) {
		logoutAlpha();
		console.log("alphaXiv auth cleared");
		return;
	}

	if (values["alpha-status"]) {
		if (isAlphaLoggedIn()) {
			const name = getAlphaUserName();
			console.log(name ? `alphaXiv logged in as ${name}` : "alphaXiv logged in");
		} else {
			console.log("alphaXiv not logged in");
		}
		return;
	}

	const explicitModelSpec = values.model ?? process.env.FEYNMAN_MODEL;
	if (explicitModelSpec) {
		const modelRegistry = new ModelRegistry(AuthStorage.create(feynmanAuthPath));
		const explicitModel = parseModelSpec(explicitModelSpec, modelRegistry);
		if (!explicitModel) {
			throw new Error(`Unknown model: ${explicitModelSpec}`);
		}
	}
	const oneShotPrompt = values.prompt;
	const initialPrompt = oneShotPrompt ?? (positionals.length > 0 ? positionals.join(" ") : undefined);
	const systemPrompt = buildFeynmanSystemPrompt();

	const piArgs = [
		"--session-dir",
		sessionDir,
		"--extension",
		resolve(appRoot, "extensions", "research-tools.ts"),
		"--skill",
		resolve(appRoot, "skills"),
		"--prompt-template",
		resolve(appRoot, "prompts"),
		"--system-prompt",
		systemPrompt,
	];

	if (explicitModelSpec) {
		piArgs.push("--model", explicitModelSpec);
	}
	if (thinkingLevel) {
		piArgs.push("--thinking", thinkingLevel);
	}
	if (oneShotPrompt) {
		piArgs.push("-p", oneShotPrompt);
	}
	else if (initialPrompt) {
		piArgs.push(initialPrompt);
	}

	const child = spawn(process.execPath, [piCliPath, ...piArgs], {
		cwd: workingDir,
		stdio: "inherit",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: feynmanAgentDir,
			FEYNMAN_CODING_AGENT_DIR: feynmanAgentDir,
			FEYNMAN_TERMINAL_BG: terminalBackgroundHex,
			PI_TERMINAL_BG: terminalBackgroundHex,
			FEYNMAN_PI_NPM_ROOT: resolve(appRoot, ".pi", "npm", "node_modules"),
			FEYNMAN_SESSION_DIR: sessionDir,
			PI_SESSION_DIR: sessionDir,
			FEYNMAN_MEMORY_DIR: resolve(dirname(feynmanAgentDir), "memory"),
			FEYNMAN_NODE_EXECUTABLE: process.execPath,
			FEYNMAN_BIN_PATH: resolve(appRoot, "bin", "feynman.js"),
			PANDOC_PATH:
				process.env.PANDOC_PATH ??
				resolveExecutable("pandoc", [
					"/opt/homebrew/bin/pandoc",
					"/usr/local/bin/pandoc",
				]),
			PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1",
			MERMAID_CLI_PATH:
				process.env.MERMAID_CLI_PATH ??
				resolveExecutable("mmdc", [
					"/opt/homebrew/bin/mmdc",
					"/usr/local/bin/mmdc",
				]),
			PUPPETEER_EXECUTABLE_PATH:
				process.env.PUPPETEER_EXECUTABLE_PATH ??
				resolveExecutable("google-chrome", [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
					"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
					"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
				]),
		},
	});

	await new Promise<void>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal) {
				process.kill(process.pid, signal);
				return;
			}
			process.exitCode = code ?? 0;
			resolvePromise();
		});
	});
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
