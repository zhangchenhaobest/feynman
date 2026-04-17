import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerAlphaTools } from "./research-tools/alpha.js";
import { registerAutoLog } from "./research-tools/autolog.js";
import { registerContextReportTool } from "./research-tools/context.js";
import { registerDiscoveryCommands } from "./research-tools/discovery.js";
import { registerFeynmanModelCommand } from "./research-tools/feynman-model.js";
import { installFeynmanHeader } from "./research-tools/header.js";
import { registerHelpCommand } from "./research-tools/help.js";
import { registerInitCommand, registerOutputsCommand } from "./research-tools/project.js";
import { registerResumePacket } from "./research-tools/resume.js";
import { registerServiceTierControls } from "./research-tools/service-tier.js";
import { registerStateManagement } from "./research-tools/state.js";

export default function researchTools(pi: ExtensionAPI): void {
	const cache: { agentSummaryPromise?: Promise<{ agents: string[]; chains: string[] }> } = {};

	// Pi 0.66.x folds post-switch/resume lifecycle into session_start.
	pi.on("session_start", async (_event, ctx) => {
		await installFeynmanHeader(pi, ctx, cache);
	});

	registerAlphaTools(pi);
	registerAutoLog(pi);
	registerContextReportTool(pi);
	registerDiscoveryCommands(pi);
	registerFeynmanModelCommand(pi);
	registerHelpCommand(pi);
	registerInitCommand(pi);
	registerOutputsCommand(pi);
	registerResumePacket(pi);
	registerServiceTierControls(pi);
	registerStateManagement(pi);
}
