import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const piPackageRoot = resolve(appRoot, "node_modules", "@mariozechner", "pi-coding-agent");
const packageJsonPath = resolve(piPackageRoot, "package.json");
const cliPath = resolve(piPackageRoot, "dist", "cli.js");
const interactiveModePath = resolve(piPackageRoot, "dist", "modes", "interactive", "interactive-mode.js");
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
const settingsPath = resolve(appRoot, ".pi", "settings.json");
const workspaceDir = resolve(appRoot, ".pi", "npm");
const workspacePackageJsonPath = resolve(workspaceDir, "package.json");

function ensurePackageWorkspace() {
	if (!existsSync(settingsPath)) {
		return;
	}

	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	const packageSpecs = Array.isArray(settings.packages)
		? settings.packages
			.filter((value) => typeof value === "string" && value.startsWith("npm:"))
			.map((value) => value.slice(4))
		: [];

	if (packageSpecs.length === 0) {
		return;
	}

	mkdirSync(workspaceDir, { recursive: true });

	writeFileSync(
		workspacePackageJsonPath,
		JSON.stringify(
			{
				name: "pi-extensions",
				private: true,
				dependencies: Object.fromEntries(packageSpecs.map((spec) => [spec, "latest"])),
			},
			null,
			2,
		) + "\n",
		"utf8",
	);

	const npmExec = process.env.npm_execpath;
	const install = npmExec
		? spawnSync(process.execPath, [npmExec, "install", "--prefix", workspaceDir, ...packageSpecs], {
				stdio: "inherit",
			})
		: spawnSync("npm", ["install", "--prefix", workspaceDir, ...packageSpecs], {
				stdio: "inherit",
			});

	if (install.status !== 0) {
		console.warn("[feynman] warning: failed to preinstall default Pi packages into .pi/npm");
	}
}

ensurePackageWorkspace();

if (existsSync(packageJsonPath)) {
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	if (pkg.piConfig?.name !== "feynman") {
		pkg.piConfig = {
			...(pkg.piConfig || {}),
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
