import { addAppsToMonorepo, DEFAULT_TEMPLATE_REF, DEFAULT_TEMPLATE_SOURCE, type AppInstanceInput } from "@intentic/scaffold";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { createOutput } from "../lib/output.js";

interface AddAppFlags {
    dir: string;
    apps: string;
    source?: string;
    ref?: string;
}

// Parse a comma-separated --apps value into AppInstanceInput[]. Each entry is either a bare template key
// ("api" → { template: "api", name: "api" }) or a "template:name" pair ("api:shop-api" → { template: "api",
// name: "shop-api" }). This is backward-compatible: the old --apps api,web still works.
const parseApps = (raw: string): AppInstanceInput[] =>
    raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const colon = entry.indexOf(":");
            if (colon === -1) {
                return { template: entry, name: entry };
            }
            return { template: entry.slice(0, colon), name: entry.slice(colon + 1) };
        });

// Add one or more named app instances into an EXISTING monorepo at <dir>. Shells to @intentic/scaffold, which
// clones the source, copies each app's instance packages in (renaming _apps/ dirs for custom names, overlapping
// shared libs land once), and runs `pnpm install`.
export const addAppCommand = buildCommand<AddAppFlags>({
    docs: { brief: "Add one or more app instances into an existing monorepo at <dir>" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, brief: "The monorepo repo directory to add the apps into" },
            apps: {
                kind: "parsed",
                parse: String,
                brief: "Comma-separated entries: template key or template:name, e.g. api,web:shop-web,api:admin-api",
            },
            source: { kind: "parsed", parse: String, optional: true, brief: `Template source git URL (default: ${DEFAULT_TEMPLATE_SOURCE})` },
            ref: { kind: "parsed", parse: String, optional: true, brief: `Template source branch/tag (default: ${DEFAULT_TEMPLATE_REF})` },
        },
    },
    async func(this: CommandContext, flags: AddAppFlags) {
        const out = createOutput(this.process.stdout, loadConfig().intenticOutput);
        const apps = parseApps(flags.apps);
        if (apps.length === 0) {
            throw new Error("no apps specified — pass --apps api,web:shop-web");
        }
        const progress = addAppsToMonorepo({
            repoDir: flags.dir,
            source: flags.source ?? DEFAULT_TEMPLATE_SOURCE,
            ref: flags.ref ?? DEFAULT_TEMPLATE_REF,
            apps,
        });
        for await (const message of progress) {
            out.text(message);
        }
        const labels = apps.map((a) => (a.name === a.template ? a.template : `${a.template}:${a.name}`));
        out.text(`added ${labels.join(", ")} to ${flags.dir}`);
        out.result({ dir: flags.dir, apps });
    },
});
