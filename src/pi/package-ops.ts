import { spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { DefaultPackageManager, SettingsManager } from "@mariozechner/pi-coding-agent";

import { NATIVE_PACKAGE_SOURCES, supportsNativePackageSources } from "./package-presets.js";
import { applyFeynmanPackageManagerEnv, getFeynmanNpmPrefixPath } from "./runtime.js";
import { getPathWithCurrentNode, resolveExecutable } from "../system/executables.js";

type PackageScope = "user" | "project";

type ConfiguredPackage = {
	source: string;
	scope: PackageScope;
	filtered: boolean;
	installedPath?: string;
};

type NpmSource = {
	name: string;
	source: string;
	spec: string;
	pinned: boolean;
};

export type MissingConfiguredPackageSummary = {
	missing: ConfiguredPackage[];
	bundled: ConfiguredPackage[];
};

export type InstallPackageSourcesResult = {
	installed: string[];
	skipped: string[];
};

export type UpdateConfiguredPackagesResult = {
	updated: string[];
	skipped: string[];
};

const FILTERED_INSTALL_OUTPUT_PATTERNS = [
	/npm warn deprecated node-domexception@1\.0\.0/i,
	/npm notice/i,
	/^(added|removed|changed) \d+ packages?( in .+)?$/i,
	/^(\d+ )?packages are looking for funding$/i,
	/^run `npm fund` for details$/i,
];
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function createPackageContext(workingDir: string, agentDir: string) {
	applyFeynmanPackageManagerEnv(agentDir);
	process.env.PATH = getPathWithCurrentNode(process.env.PATH);
	const settingsManager = SettingsManager.create(workingDir, agentDir);
	const packageManager = new DefaultPackageManager({
		cwd: workingDir,
		agentDir,
		settingsManager,
	});

	return {
		settingsManager,
		packageManager,
	};
}

function shouldSkipNativeSource(source: string, version = process.versions.node): boolean {
	return !supportsNativePackageSources(version) && NATIVE_PACKAGE_SOURCES.includes(source as (typeof NATIVE_PACKAGE_SOURCES)[number]);
}

function filterUnsupportedSources(sources: string[], version = process.versions.node): { supported: string[]; skipped: string[] } {
	const supported: string[] = [];
	const skipped: string[] = [];

	for (const source of sources) {
		if (shouldSkipNativeSource(source, version)) {
			skipped.push(source);
			continue;
		}
		supported.push(source);
	}

	return { supported, skipped };
}

function relayFilteredOutput(chunk: Buffer | string, writer: NodeJS.WriteStream): void {
	const text = chunk.toString();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		if (FILTERED_INSTALL_OUTPUT_PATTERNS.some((pattern) => pattern.test(line.trim()))) {
			continue;
		}
		writer.write(`${line}\n`);
	}
}

function parseNpmSource(source: string): NpmSource | undefined {
	if (!source.startsWith("npm:")) {
		return undefined;
	}

	const spec = source.slice("npm:".length).trim();
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	const name = match?.[1] ?? spec;
	const version = match?.[2];

	return {
		name,
		source,
		spec,
		pinned: Boolean(version),
	};
}

function dedupeNpmSources(sources: string[], updateToLatest: boolean): string[] {
	const specs = new Map<string, string>();

	for (const source of sources) {
		const parsed = parseNpmSource(source);
		if (!parsed) continue;

		specs.set(parsed.name, updateToLatest && !parsed.pinned ? `${parsed.name}@latest` : parsed.spec);
	}

	return [...specs.values()];
}

function ensureProjectInstallRoot(workingDir: string): string {
	const installRoot = resolve(workingDir, ".feynman", "npm");
	mkdirSync(installRoot, { recursive: true });

	const ignorePath = join(installRoot, ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n!.gitignore\n", "utf8");
	}

	const packageJsonPath = join(installRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		writeFileSync(packageJsonPath, JSON.stringify({ name: "feynman-packages", private: true }, null, 2) + "\n", "utf8");
	}

	return installRoot;
}

function resolveAdjacentNpmExecutable(): string | undefined {
	const executableName = process.platform === "win32" ? "npm.cmd" : "npm";
	const candidate = resolve(dirname(process.execPath), executableName);
	return existsSync(candidate) ? candidate : undefined;
}

function resolvePackageManagerCommand(settingsManager: SettingsManager): { command: string; args: string[] } | undefined {
	const configured = settingsManager.getNpmCommand();
	if (!configured || configured.length === 0) {
		const adjacentNpm = resolveAdjacentNpmExecutable() ?? resolveExecutable("npm");
		return adjacentNpm ? { command: adjacentNpm, args: [] } : undefined;
	}

	const [command = "npm", ...args] = configured;
	if (!command) {
		return undefined;
	}

	const executable = resolveExecutable(command);
	if (!executable) {
		return undefined;
	}

	return { command: executable, args };
}

async function runPackageManagerInstall(
	settingsManager: SettingsManager,
	workingDir: string,
	agentDir: string,
	scope: PackageScope,
	specs: string[],
): Promise<void> {
	if (specs.length === 0) {
		return;
	}

	const packageManagerCommand = resolvePackageManagerCommand(settingsManager);
	if (!packageManagerCommand) {
		throw new Error("No supported package manager found. Install npm, pnpm, or bun, or configure `npmCommand`.");
	}

	const args = [
		...packageManagerCommand.args,
		"install",
		"--no-audit",
		"--no-fund",
		"--legacy-peer-deps",
		"--loglevel",
		"error",
	];

	if (scope === "user") {
		args.push("-g", "--prefix", getFeynmanNpmPrefixPath(agentDir));
	} else {
		args.push("--prefix", ensureProjectInstallRoot(workingDir));
	}

	args.push(...specs);

	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(packageManagerCommand.command, args, {
			cwd: scope === "user" ? agentDir : workingDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: getPathWithCurrentNode(process.env.PATH),
			},
		});

		child.stdout?.on("data", (chunk) => relayFilteredOutput(chunk, process.stdout));
		child.stderr?.on("data", (chunk) => relayFilteredOutput(chunk, process.stderr));

		child.on("error", reject);
		child.on("exit", (code) => {
			if ((code ?? 1) !== 0) {
				const installingGenerativeUi = specs.some((spec) => spec.startsWith("pi-generative-ui"));
				if (installingGenerativeUi && process.platform === "darwin") {
					reject(
						new Error(
							"Installing pi-generative-ui failed. Its native glimpseui dependency did not compile against the current macOS/Xcode toolchain. Try the npm-installed Feynman path with your local Node toolchain or skip this optional preset for now.",
						),
					);
					return;
				}
				reject(new Error(`${packageManagerCommand.command} install failed with code ${code ?? 1}`));
				return;
			}

			resolvePromise();
		});
	});
}

function groupConfiguredNpmSources(packages: ConfiguredPackage[]): Record<PackageScope, string[]> {
	return {
		user: packages.filter((entry) => entry.scope === "user").map((entry) => entry.source),
		project: packages.filter((entry) => entry.scope === "project").map((entry) => entry.source),
	};
}

function isBundledWorkspacePackagePath(installedPath: string | undefined, appRoot: string): boolean {
	if (!installedPath) {
		return false;
	}

	const bundledRoot = resolve(appRoot, ".feynman", "npm", "node_modules");
	return installedPath.startsWith(bundledRoot);
}

export function getMissingConfiguredPackages(
	workingDir: string,
	agentDir: string,
	appRoot: string,
): MissingConfiguredPackageSummary {
	const { packageManager } = createPackageContext(workingDir, agentDir);
	const configured = packageManager.listConfiguredPackages();

	return configured.reduce<MissingConfiguredPackageSummary>(
		(summary, entry) => {
			if (entry.installedPath) {
				if (isBundledWorkspacePackagePath(entry.installedPath, appRoot)) {
					summary.bundled.push(entry);
				}
				return summary;
			}

			summary.missing.push(entry);
			return summary;
		},
		{ missing: [], bundled: [] },
	);
}

export async function installPackageSources(
	workingDir: string,
	agentDir: string,
	sources: string[],
	options?: { local?: boolean; persist?: boolean },
): Promise<InstallPackageSourcesResult> {
	const { settingsManager, packageManager } = createPackageContext(workingDir, agentDir);
	const scope: PackageScope = options?.local ? "project" : "user";
	const installed: string[] = [];

	const bundledSeeded = scope === "user" ? seedBundledWorkspacePackages(agentDir, APP_ROOT, sources) : [];
	installed.push(...bundledSeeded);
	const remainingSources = sources.filter((source) => !bundledSeeded.includes(source));
	const grouped = groupConfiguredNpmSources(
		remainingSources.map((source) => ({
			source,
			scope,
			filtered: false,
		})),
	);
	const { supported: supportedUserSources, skipped } = filterUnsupportedSources(grouped.user);
	const { supported: supportedProjectSources, skipped: skippedProject } = filterUnsupportedSources(grouped.project);
	skipped.push(...skippedProject);

	const supportedNpmSources = scope === "user" ? supportedUserSources : supportedProjectSources;
	if (supportedNpmSources.length > 0) {
		await runPackageManagerInstall(settingsManager, workingDir, agentDir, scope, dedupeNpmSources(supportedNpmSources, false));
		installed.push(...supportedNpmSources);
	}

	for (const source of sources) {
		if (parseNpmSource(source)) {
			continue;
		}

		await packageManager.install(source, { local: options?.local });
		installed.push(source);
	}

	if (options?.persist) {
		for (const source of installed) {
			if (packageManager.addSourceToSettings(source, { local: options?.local })) {
				continue;
			}
			skipped.push(source);
		}
		await settingsManager.flush();
	}

	return { installed, skipped };
}

export async function updateConfiguredPackages(
	workingDir: string,
	agentDir: string,
	source?: string,
): Promise<UpdateConfiguredPackagesResult> {
	const { settingsManager, packageManager } = createPackageContext(workingDir, agentDir);

	if (source) {
		await packageManager.update(source);
		return { updated: [source], skipped: [] };
	}

	const availableUpdates = await packageManager.checkForAvailableUpdates();
	if (availableUpdates.length === 0) {
		return { updated: [], skipped: [] };
	}

	const npmUpdatesByScope: Record<PackageScope, string[]> = { user: [], project: [] };
	const gitUpdates: string[] = [];
	const skipped: string[] = [];

	for (const entry of availableUpdates) {
		if (entry.type === "npm") {
			if (shouldSkipNativeSource(entry.source)) {
				skipped.push(entry.source);
				continue;
			}
			npmUpdatesByScope[entry.scope].push(entry.source);
			continue;
		}

		gitUpdates.push(entry.source);
	}

	for (const scope of ["user", "project"] as const) {
		const sources = npmUpdatesByScope[scope];
		if (sources.length === 0) continue;

		await runPackageManagerInstall(settingsManager, workingDir, agentDir, scope, dedupeNpmSources(sources, true));
	}

	for (const gitSource of gitUpdates) {
		await packageManager.update(gitSource);
	}

	return {
		updated: availableUpdates
			.map((entry) => entry.source)
			.filter((source) => !skipped.includes(source)),
		skipped,
	};
}

function ensureParentDir(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}

function pathsMatchSymlinkTarget(linkPath: string, targetPath: string): boolean {
	try {
		if (!lstatSync(linkPath).isSymbolicLink()) {
			return false;
		}
		return resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath;
	} catch {
		return false;
	}
}

function linkDirectory(linkPath: string, targetPath: string): void {
	if (pathsMatchSymlinkTarget(linkPath, targetPath)) {
		return;
	}

	try {
		if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
			rmSync(linkPath, { force: true });
		}
	} catch {}

	if (existsSync(linkPath)) {
		return;
	}

	ensureParentDir(linkPath);
	try {
		symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
	} catch {
		// Fallback for filesystems that do not allow symlinks.
		if (!existsSync(linkPath)) {
			cpSync(targetPath, linkPath, { recursive: true });
		}
	}
}

export function seedBundledWorkspacePackages(
	agentDir: string,
	appRoot: string,
	sources: string[],
): string[] {
	const bundledNodeModulesRoot = resolve(appRoot, ".feynman", "npm", "node_modules");
	if (!existsSync(bundledNodeModulesRoot)) {
		return [];
	}

	const globalNodeModulesRoot = resolve(getFeynmanNpmPrefixPath(agentDir), "lib", "node_modules");
	const seeded: string[] = [];

	for (const source of sources) {
		if (shouldSkipNativeSource(source)) continue;

		const parsed = parseNpmSource(source);
		if (!parsed) continue;

		const bundledPackagePath = resolve(bundledNodeModulesRoot, parsed.name);
		if (!existsSync(bundledPackagePath)) continue;

		const targetPath = resolve(globalNodeModulesRoot, parsed.name);
		if (!existsSync(targetPath)) {
			linkDirectory(targetPath, bundledPackagePath);
			seeded.push(source);
		}
	}

	return seeded;
}
