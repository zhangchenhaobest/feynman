import "dotenv/config";

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function printHelp(): void {
	console.log(`Feynman commands:
	  /help                     Show this help
	  /alpha-login              Sign in to alphaXiv
	  /alpha-logout             Clear alphaXiv auth
	  /alpha-status             Show alphaXiv auth status
	  /new                      Start a fresh persisted session
	  /exit                     Quit the REPL
	  /lit-review <topic>       Expand the literature review prompt template
	  /replicate <paper>        Expand the replication prompt template
	  /reading-list <topic>     Expand the reading list prompt template
	  /research-memo <topic>    Expand the general research memo prompt template
	  /deepresearch <topic>     Expand the thorough source-heavy research prompt template
	  /autoresearch <idea>      Expand the idea-to-paper autoresearch prompt template
	  /compare-sources <topic>  Expand the source comparison prompt template
	  /paper-code-audit <item>  Expand the paper/code audit prompt template
	  /paper-draft <topic>      Expand the paper-style writing prompt template

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

function syncFeynmanTheme(appRoot: string, agentDir: string): void {
	const sourceThemePath = resolve(appRoot, ".pi", "themes", "feynman.json");
	const targetThemeDir = resolve(agentDir, "themes");
	const targetThemePath = resolve(targetThemeDir, "feynman.json");

	if (!existsSync(sourceThemePath)) {
		return;
	}

	mkdirSync(targetThemeDir, { recursive: true });
	writeFileSync(targetThemePath, readFileSync(sourceThemePath, "utf8"), "utf8");
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
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(feynmanAgentDir, { recursive: true });
	syncFeynmanTheme(appRoot, feynmanAgentDir);
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
