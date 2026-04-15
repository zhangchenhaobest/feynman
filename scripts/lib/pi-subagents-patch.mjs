export const PI_SUBAGENTS_PATCH_TARGETS = [
	"index.ts",
	"agents.ts",
	"artifacts.ts",
	"run-history.ts",
	"skills.ts",
	"chain-clarify.ts",
];

const RESOLVE_PI_AGENT_DIR_HELPER = [
	"function resolvePiAgentDir(): string {",
	'	const configured = process.env.PI_CODING_AGENT_DIR?.trim();',
	'	if (!configured) return path.join(os.homedir(), ".pi", "agent");',
	'	return configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(2)) : configured;',
	"}",
].join("\n");

function injectResolvePiAgentDirHelper(source) {
	if (source.includes("function resolvePiAgentDir(): string {")) {
		return source;
	}

	const lines = source.split("\n");
	let insertAt = 0;
	let importSeen = false;
	let importOpen = false;

	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index].trim();
		if (!importSeen) {
			if (trimmed === "" || trimmed.startsWith("/**") || trimmed.startsWith("*") || trimmed.startsWith("*/")) {
				insertAt = index + 1;
				continue;
			}
			if (trimmed.startsWith("import ")) {
				importSeen = true;
				importOpen = !trimmed.endsWith(";");
				insertAt = index + 1;
				continue;
			}
			break;
		}

		if (trimmed.startsWith("import ")) {
			importOpen = !trimmed.endsWith(";");
			insertAt = index + 1;
			continue;
		}
		if (importOpen) {
			if (trimmed.endsWith(";")) importOpen = false;
			insertAt = index + 1;
			continue;
		}
		if (trimmed === "") {
			insertAt = index + 1;
			continue;
		}
		insertAt = index;
		break;
	}

	return [...lines.slice(0, insertAt), "", RESOLVE_PI_AGENT_DIR_HELPER, "", ...lines.slice(insertAt)].join("\n");
}

function replaceAll(source, from, to) {
	return source.split(from).join(to);
}

export function patchPiSubagentsSource(relativePath, source) {
	let patched = source;

	switch (relativePath) {
		case "index.ts":
			patched = replaceAll(
				patched,
				'const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");',
				'const configPath = path.join(resolvePiAgentDir(), "extensions", "subagent", "config.json");',
			);
			break;
		case "agents.ts":
			patched = replaceAll(
				patched,
				'const userDir = path.join(os.homedir(), ".pi", "agent", "agents");',
				'const userDir = path.join(resolvePiAgentDir(), "agents");',
			);
			patched = replaceAll(
				patched,
				[
					'export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {',
					'\tconst userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");',
					'\tconst userDirNew = path.join(os.homedir(), ".agents");',
				].join("\n"),
				[
					'export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {',
					'\tconst userDir = path.join(resolvePiAgentDir(), "agents");',
				].join("\n"),
			);
			patched = replaceAll(
				patched,
				[
					'\tconst userAgentsOld = scope === "project" ? [] : loadAgentsFromDir(userDirOld, "user");',
					'\tconst userAgentsNew = scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user");',
					'\tconst userAgents = [...userAgentsOld, ...userAgentsNew];',
				].join("\n"),
				'\tconst userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");',
			);
			patched = replaceAll(
				patched,
				[
					'const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");',
					'const userDirNew = path.join(os.homedir(), ".agents");',
				].join("\n"),
				'const userDir = path.join(resolvePiAgentDir(), "agents");',
			);
			patched = replaceAll(
				patched,
				[
					'\tconst user = [',
					'\t\t...loadAgentsFromDir(userDirOld, "user"),',
					'\t\t...loadAgentsFromDir(userDirNew, "user"),',
					'\t];',
				].join("\n"),
				'\tconst user = loadAgentsFromDir(userDir, "user");',
			);
			patched = replaceAll(
				patched,
				[
					'\tconst chains = [',
					'\t\t...loadChainsFromDir(userDirOld, "user"),',
					'\t\t...loadChainsFromDir(userDirNew, "user"),',
					'\t\t...(projectDir ? loadChainsFromDir(projectDir, "project") : []),',
					'\t];',
				].join("\n"),
				[
					'\tconst chains = [',
					'\t\t...loadChainsFromDir(userDir, "user"),',
					'\t\t...(projectDir ? loadChainsFromDir(projectDir, "project") : []),',
					'\t];',
				].join("\n"),
			);
			patched = replaceAll(
				patched,
				'\tconst userDir = fs.existsSync(userDirNew) ? userDirNew : userDirOld;',
				'\tconst userDir = path.join(resolvePiAgentDir(), "agents");',
			);
			break;
		case "artifacts.ts":
			patched = replaceAll(
				patched,
				'const sessionsBase = path.join(os.homedir(), ".pi", "agent", "sessions");',
				'const sessionsBase = path.join(resolvePiAgentDir(), "sessions");',
			);
			break;
		case "run-history.ts":
			patched = replaceAll(
				patched,
				'const HISTORY_PATH = path.join(os.homedir(), ".pi", "agent", "run-history.jsonl");',
				'const HISTORY_PATH = path.join(resolvePiAgentDir(), "run-history.jsonl");',
			);
			break;
		case "skills.ts":
			patched = replaceAll(
				patched,
				'const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");',
				"const AGENT_DIR = resolvePiAgentDir();",
			);
			break;
		case "chain-clarify.ts":
			patched = replaceAll(
				patched,
				'const dir = path.join(os.homedir(), ".pi", "agent", "agents");',
				'const dir = path.join(resolvePiAgentDir(), "agents");',
			);
			break;
		default:
			return source;
	}

	if (patched === source) {
		return source;
	}

	return injectResolvePiAgentDirHelper(patched);
}
