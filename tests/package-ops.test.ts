import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { seedBundledWorkspacePackages } from "../src/pi/package-ops.js";

function createBundledWorkspace(appRoot: string, packageNames: string[]): void {
	for (const packageName of packageNames) {
		const packageDir = resolve(appRoot, ".feynman", "npm", "node_modules", packageName);
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({ name: packageName, version: "1.0.0" }, null, 2) + "\n",
			"utf8",
		);
	}
}

test("seedBundledWorkspacePackages links bundled packages into the Feynman npm prefix", () => {
	const appRoot = mkdtempSync(join(tmpdir(), "feynman-bundle-"));
	const homeRoot = mkdtempSync(join(tmpdir(), "feynman-home-"));
	const agentDir = resolve(homeRoot, "agent");
	mkdirSync(agentDir, { recursive: true });

	createBundledWorkspace(appRoot, ["pi-subagents", "@samfp/pi-memory"]);

	const seeded = seedBundledWorkspacePackages(agentDir, appRoot, [
		"npm:pi-subagents",
		"npm:@samfp/pi-memory",
	]);

	assert.deepEqual(seeded.sort(), ["npm:@samfp/pi-memory", "npm:pi-subagents"]);
	const globalRoot = resolve(homeRoot, "npm-global", "lib", "node_modules");
	assert.equal(existsSync(resolve(globalRoot, "pi-subagents", "package.json")), true);
	assert.equal(existsSync(resolve(globalRoot, "@samfp", "pi-memory", "package.json")), true);
});

test("seedBundledWorkspacePackages preserves existing installed packages", () => {
	const appRoot = mkdtempSync(join(tmpdir(), "feynman-bundle-"));
	const homeRoot = mkdtempSync(join(tmpdir(), "feynman-home-"));
	const agentDir = resolve(homeRoot, "agent");
	const existingPackageDir = resolve(homeRoot, "npm-global", "lib", "node_modules", "pi-subagents");

	mkdirSync(agentDir, { recursive: true });
	createBundledWorkspace(appRoot, ["pi-subagents"]);
	mkdirSync(existingPackageDir, { recursive: true });
	writeFileSync(resolve(existingPackageDir, "package.json"), '{"name":"pi-subagents","version":"user"}\n', "utf8");

	const seeded = seedBundledWorkspacePackages(agentDir, appRoot, ["npm:pi-subagents"]);

	assert.deepEqual(seeded, []);
	assert.equal(readFileSync(resolve(existingPackageDir, "package.json"), "utf8"), '{"name":"pi-subagents","version":"user"}\n');
	assert.equal(lstatSync(existingPackageDir).isSymbolicLink(), false);
});
