import { join } from "node:path";
import type { CliConfig } from "@intentic/sandbox-contract";
import { listenerStatus } from "../../extensions/listener-status.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { terminalExec } from "../../terminal/terminal-run.js";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityCtx, CapabilityHandler } from "../capability.js";
import { envSuffix } from "../cli-env.js";
import {
    connectorRegistry,
    connectorSecretField,
    connectorSecretFields,
    connectorSkillPath,
    validateConnectorConfig,
} from "../cli/connector-registry.js";
import { CORE_CONNECTOR_HOOKS, gitAccessWired, gitHostOf } from "../cli/git-access.js";
import { extensionRead } from "../extension-dirs.js";

// A CLI-tool integration: give the AGENT an authenticated command-line tool. The provider's card/fields/env/
// skill/fragment are DATA in an installed extension's `contributes.connectors` (see connector-registry) — this
// handler is the generic plumbing over that data. `apply` reads the connector's SKILL.md, templates it for this
// instance ($VAR → $VAR_<ID>), drops it into .claude/skills/<id> (auto-loaded by the agent), and runs the
// connector's optional core hook (git-over-ssh for github/gitlab). The credential is injected into the agent's
// env each turn (cliEnvOf), never written to a file; the image fragment (psql/whisper) rides fragment-sources.
const skillPath = (root: string, id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

// The narrow ctx as the extension enumerator's host — same fields, extensionsDir threaded through the ctx.
const hostOf = (ctx: CapabilityCtx): ExtensionHost => ({
    workspace: ctx.workspace,
    files: ctx.files,
    capabilities: ctx.capabilities,
    config: { extensionsDir: ctx.extensionsDir },
});

export const cliHandler: CapabilityHandler = {
    secret: (config, connectors) => {
        const spec = connectors.get((config as CliConfig).provider)?.spec;
        return spec === undefined ? undefined : connectorSecretField(spec);
    },
    /* Echo the non-secret fields (url etc.) for display; the rotatable secret becomes hasSecret. EVERY declared
     * secret is withheld, not just that one — a two-token connector (Slack: an app-level token to open the socket,
     * a bot token for the Web API) must not ship its second credential to the browser by not being the one
     * /secrets happens to rotate. The web renders the card's label/logo from the connector manifest, not this. */
    echo: (config, connectors) => {
        const cli = config as CliConfig;
        const spec = connectors.get(cli.provider)?.spec;
        const secretKeys = spec === undefined ? new Set<string>() : connectorSecretFields(spec);
        const rotatable = spec === undefined ? undefined : connectorSecretField(spec);
        const echo: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(cli)) {
            if (!secretKeys.has(key)) {
                echo[key] = value;
            }
        }
        return { ...echo, hasSecret: rotatable !== undefined && cli[rotatable] !== undefined && cli[rotatable] !== "" };
    },
    apply: async function* (ctx, id, config) {
        const cliConfig = config as CliConfig;
        const { provider } = cliConfig;
        const connector = (await connectorRegistry(hostOf(ctx))).get(provider);
        if (connector === undefined) {
            throw new Error(`no connector for provider "${provider}" — install the extension that declares it`);
        }
        const invalid = validateConnectorConfig(connector.spec, cliConfig);
        if (invalid !== undefined) {
            throw new Error(invalid);
        }
        // Template the static skill for this instance: frontmatter name → the (unique) id so two instances of
        // one provider don't register the same skill name, and each $VAR → its per-instance suffixed name so the
        // agent reads this instance's credentials. Longest keys first to avoid one key corrupting another's prefix.
        const suffix = envSuffix(id);
        const keys = Object.keys(connector.spec.env).toSorted((a, b) => b.length - a.length);
        let skill = ((await extensionRead(connectorSkillPath(connector))) ?? "").replace(/^name: .*$/m, `name: ${id}`);
        for (const key of keys) {
            skill = skill.replaceAll(`$${key}`, `$${key}_${suffix}`);
        }
        await ctx.files.write(skillPath(ctx.workspace.root, id), skill);
        // The connector's optional privileged hook (github/gitlab git-over-ssh), run visibly in the capability's
        // job session — surfaced only when it actually shells out. A returned message is a non-fatal warning.
        const hook = CORE_CONNECTOR_HOOKS[provider];
        const session = capabilityJobSession(id);
        if (hook !== undefined && ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        const warning = await hook?.apply(cliConfig, terminalExec(ctx.terminalRun, session, ctx.workspace.root));
        yield { kind: "log", message: `Connected ${provider}. The agent can use it next turn via its skill + the credential in its env.` };
        if (warning !== undefined) {
            yield { kind: "log", message: warning };
        }
    },
    status: async (ctx, id, config) => {
        if ((await ctx.files.read(skillPath(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        // The skill and the manifest are on /work; git access is in the container's HOME, which a recreate
        // wipes — so without this the card read "active" while `git pull` answered Permission denied. The boot
        // restore heals that; a `pending` here is what a restore that COULDN'T (revoked token, no network on
        // the full-setup path) looks like, instead of a card that lies about it.
        const cliConfig = config as CliConfig;
        if (cliConfig["git"] === "on" && CORE_CONNECTOR_HOOKS[cliConfig.provider] !== undefined && !(await gitAccessWired(gitHostOf(cliConfig)))) {
            return { state: "pending", detail: "git access needs a re-add" };
        }
        // Discord's voice transcription rides whisper.cpp from the connector's overlay fragment — until the owner
        // rebuilds, the text tools work but voice doesn't. The gateway process reports whisper's presence via
        // /listeners/discord/status (whisper runs there now, not in the daemon), so surface pending off that.
        if (cliConfig.provider === "discord" && listenerStatus("discord", Date.now())?.whisperReady === false) {
            return { state: "pending", detail: "voice needs a rebuild (whisper)" };
        }
        return { state: "active" };
    },
    remove: async (ctx, id, config) => {
        await CORE_CONNECTOR_HOOKS[(config as CliConfig).provider]?.remove(
            config as CliConfig,
            terminalExec(ctx.terminalRun, capabilityJobSession(id), ctx.workspace.root),
        );
        await ctx.files.remove(join(ctx.workspace.root, ".claude", "skills", id));
    },
};
