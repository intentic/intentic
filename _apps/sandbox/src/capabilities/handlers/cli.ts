import type { CliConfig } from "@intentic/sandbox-contract";
import { join } from "node:path";
import { whisperCliMissing } from "../../discord/voice.js";
import { terminalExec } from "../../system/terminal-run.js";
import { capabilityJobSession } from "../../system/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";
import { envSuffix } from "../cli-env.js";
import { cliProviders } from "../cli/providers.js";

// A CLI-tool integration: give the AGENT an authenticated command-line tool. `apply` drops the provider's
// SKILL.md cheatsheet into the workspace's .claude/skills/<id> (auto-loaded by the agent's settingSources); the
// credential itself is stored in the manifest config and injected into the agent's env each turn (see cliEnvOf),
// never written to a file. Distinct from `integration`, which wires a credential into DEPLOYED apps.
const skillPath = (root: string, id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

export const cliHandler: CapabilityHandler = {
    fragment: (config) => cliProviders[(config as CliConfig).provider].fragment,
    apply: async function* (ctx, id, config) {
        const cliConfig = config as CliConfig;
        const { provider } = cliConfig;
        // Template the static skill for this instance: frontmatter name → the (unique) id so two instances of
        // one provider don't register the same skill name, and each $VAR → its per-instance suffixed name so the
        // agent reads this instance's credentials. Longest keys first to avoid one key corrupting another's prefix.
        const suffix = envSuffix(id);
        const keys = Object.keys(cliProviders[provider].env(cliConfig)).toSorted((a, b) => b.length - a.length);
        let skill = cliProviders[provider].skill.replace(/^name: .*$/m, `name: ${id}`);
        for (const key of keys) {
            skill = skill.replaceAll(`$${key}`, `$${key}_${suffix}`);
        }
        await ctx.files.write(skillPath(ctx.workspace.root, id), skill);
        // Provider-specific side effects beyond env + skill (github/gitlab: git-over-ssh + an https credential),
        // run visibly in the capability's job session — surfaced only when the provider actually shells out.
        // A returned message is a non-fatal warning (e.g. ssh-key registration refused) — surface it, stay connected.
        const session = capabilityJobSession(id);
        if (cliProviders[provider].apply !== undefined && ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        const warning = await cliProviders[provider].apply?.(cliConfig, terminalExec(ctx.terminalRun, session, ctx.workspace.root));
        yield { kind: "log", message: `Connected ${provider}. The agent can use it next turn via its skill + the credential in its env.` };
        if (warning !== undefined) {
            yield { kind: "log", message: warning };
        }
    },
    status: async (ctx, id, config) => {
        if ((await ctx.files.read(skillPath(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        // Discord's voice transcription rides whisper.cpp from this capability's overlay fragment — until the
        // owner rebuilds, the text tools work but voice doesn't, so surface that as pending.
        if ((config as CliConfig).provider === "discord" && (await whisperCliMissing())) {
            return { state: "pending", detail: "voice needs a rebuild (whisper)" };
        }
        return { state: "active" };
    },
    remove: async (ctx, id, config) => {
        await cliProviders[(config as CliConfig).provider].remove?.(
            config as CliConfig,
            terminalExec(ctx.terminalRun, capabilityJobSession(id), ctx.workspace.root),
        );
        await ctx.files.remove(join(ctx.workspace.root, ".claude", "skills", id));
    },
};
