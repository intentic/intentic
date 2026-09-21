#!/usr/bin/env node
// The shared agent-CLI shell (@intentic/agent-cli/run) is the ONE thing this file may import at runtime: it
// pulls nothing in itself, so fileq's own module graph still loads inside a catch that can report a bad install.
import { runAgentCli } from "@intentic/agent-cli/run";

await runAgentCli({ name: "fileq", noun: "document", load: async () => ({ app: (await import("./app.js")).app }) });
