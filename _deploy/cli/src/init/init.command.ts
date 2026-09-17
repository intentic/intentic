import { join } from "node:path";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { CONFIG_FILE, ENV_FILE } from "../lib/artifact.js";
import { createOutput } from "../lib/output.js";
import { version } from "../lib/version.js";
import { scaffold } from "./init.js";

export const init = buildCommand<{ dir?: string; link: boolean; app?: string; selfHost: boolean; zone?: string; minimal: boolean }>({
    docs: { brief: "Scaffold local intent, desired-state, and app git repos" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, optional: true, brief: "Directory to scaffold in (default: .)" },
            link: { kind: "boolean", brief: "Link @intentic/* to this monorepo's _libs for local development against unpublished packages" },
            app: { kind: "parsed", parse: String, optional: true, brief: "Clone this git URL as the app repo instead of scaffolding a starter app" },
            selfHost: {
                kind: "boolean",
                brief: "Scaffold the example app onto the auto-registered `self` deploy target (this machine) instead of a placeholder remote host",
            },
            zone: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Cloudflare zone for the scaffolded app's domain (app.<zone>); used with --self-host",
            },
            minimal: {
                kind: "boolean",
                brief: "Reachability-only ledger: intent + desired-state with an empty deploy.config.ts, no app repo and no placeholder host",
            },
        },
    },
    async func(this: CommandContext, flags: { dir?: string; link: boolean; app?: string; selfHost: boolean; zone?: string; minimal: boolean }) {
        if (flags.minimal && (flags.app !== undefined || flags.selfHost || flags.zone !== undefined)) {
            throw new Error("--minimal cannot be combined with --app, --self-host, or --zone");
        }
        const out = createOutput(this.process.stdout, loadConfig().intenticOutput);
        const { intentDir, targetDir, appDir } = await scaffold(
            flags.dir ?? ".",
            version,
            flags.link,
            flags.app,
            flags.selfHost,
            flags.zone,
            flags.minimal,
        );
        out.text(
            appDir === undefined
                ? `initialized ${intentDir} (with ${CONFIG_FILE}) and ${targetDir}`
                : `initialized ${intentDir} (with ${CONFIG_FILE}), ${targetDir}, and ${appDir}`,
        );
        // A scaffold command's most useful line is the next one. Without it the only route from here to a deployment
        // was the docs, for a command whose whole job is to start somebody off.
        out.text("");
        out.text("Next:");
        for (const step of [
            `1. declare what you want in ${join(intentDir, CONFIG_FILE)}`,
            `2. \`intentic deploy resolve\` to turn it into ${targetDir}'s artifact, which names the secrets it needs`,
            `3. put those in ${join(targetDir, ENV_FILE)}, then \`intentic deploy plan\` to preview and \`intentic deploy apply\` to execute`,
        ]) {
            out.text(`  ${step}`);
        }
        out.result({ intentDir, targetDir, ...(appDir === undefined ? {} : { appDir }) });
    },
});
