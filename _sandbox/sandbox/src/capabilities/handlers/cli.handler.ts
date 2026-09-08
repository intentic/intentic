import { type CliConfig, envSuffix } from "@intentic/sandbox-contract";
import { extensionRuntimeAbsent, RUNTIME_ABSENT_DETAIL } from "../../extensions/extension-readiness.js";
import { listenerStatus } from "../../extensions/listener-status.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../../settings/loaded-skills.js";
import { terminalExec } from "../../terminal/terminal-run.js";
import { capabilityJobSession } from "../../terminal/terminal-session.js";
import type { CapabilityHandler } from "../capability.js";
import {
    contributedSkill,
    contributionKey,
    contributionRegistry,
    contributionSecretField,
    contributionSecretFields,
    hostOf,
    validateContributionConfig,
} from "../contributions.js";
import { CORE_CONNECTOR_HOOKS } from "../cli/connector-hooks.js";
import { gitAccessWired, gitHostOf } from "../cli/git-access.js";
import { npmAuthWired } from "../cli/npm-access.js";

// CLI-tool integration: provider data (card, fields, env, skill, fragment) lives in an installed extension's manifest;
// this handler is generic plumbing over it. `apply` templates the connector's skill per instance ($VAR to $VAR_<ID>)
// and runs its optional core hook. The credential is injected into the agent's env each turn, never written to a file.

// The phone's own menu text, so the card and handset read as one instruction.
const PHONE_STEPS = "on the phone: WhatsApp → Linked devices → Link a device → Link with phone number instead";

// Whether a phone ever linked, read from the gateway's snapshot; the default is pending, not active. A silent gateway
// covers both a fresh add and one that has stopped: neither is a paired phone.
const whatsappStatus = (id: string): { state: "active" | "pending"; detail?: string; code?: string } => {
    const status = listenerStatus("whatsapp", Date.now());
    if (status === undefined) {
        return { state: "pending", detail: "starting the WhatsApp connection…" };
    }
    const pairing = status.pairing?.[id];
    if (pairing === undefined) {
        // No ceremony entry means either already paired or never started; the ready connections tell them apart.
        return status.connections.some((connection) => connection.capabilityId === id && connection.gateway === "ready")
            ? { state: "active" }
            : { state: "pending", detail: "reconnecting to WhatsApp…" };
    }
    if (pairing.state === "failed") {
        // WhatsApp's refusal message reaches the owner verbatim; the retry behind it stays silent.
        return { state: "pending", detail: `WhatsApp refused that number: ${pairing.detail ?? "unknown error"}` };
    }
    if (pairing.state === "code" && pairing.code !== undefined) {
        return { state: "pending", detail: `Type this code ${PHONE_STEPS}.`, code: pairing.code };
    }
    return { state: "pending", detail: "waiting for WhatsApp to issue a pairing code…" };
};

export const cliHandler: CapabilityHandler = {
    secret: (config, connectors) => {
        const spec = connectors.get(contributionKey("cli", (config as CliConfig).provider))?.spec;
        return spec === undefined ? undefined : contributionSecretField(spec);
    },
    // Every declared secret is withheld, not just the rotatable one (a two-token connector like Slack has two). Which
    // fields are secret is the connector's data, so an unresolvable connector withholds everything but `provider`.
    echo: (config, connectors) => {
        const cli = config as CliConfig;
        const spec = connectors.get(contributionKey("cli", cli.provider))?.spec;
        if (spec === undefined) {
            return { provider: cli.provider, hasSecret: false };
        }
        const secretKeys = contributionSecretFields(spec);
        const rotatable = contributionSecretField(spec);
        const echo: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(cli)) {
            if (!secretKeys.has(key)) {
                echo[key] = value;
            }
        }
        return { ...echo, hasSecret: rotatable !== undefined && cli[rotatable] !== undefined && cli[rotatable] !== "" };
    },
    // Every connector artifact keys off the id (skill frontmatter, $VAR_<ID> suffixes, the env); rename re-applies to
    // rewrite them all, then drops the stale skill dir the re-apply wouldn't otherwise touch.
    rename: { carry: async (ctx, from) => removeLoadedSkill(ctx.files, ctx.workspace.root, from) },
    async *apply(ctx, id, config) {
        const cliConfig = config as CliConfig;
        const { provider } = cliConfig;
        const connector = (await contributionRegistry(hostOf(ctx))).get(contributionKey("cli", provider));
        if (connector === undefined) {
            throw new Error(`no connector for provider "${provider}": install the extension that declares it`);
        }
        const invalid = validateContributionConfig(connector.spec, cliConfig);
        if (invalid !== undefined) {
            throw new Error(invalid);
        }
        // Longest keys first, so one env var name can't corrupt another's shared prefix.
        const suffix = envSuffix(id);
        const keys = connector.spec.kind === "cli" ? Object.keys(connector.spec.env).toSorted((a, b) => b.length - a.length) : [];
        // No `${tools}` slot for cli: a connector's cheatsheet is only about its own tool.
        let skill = await contributedSkill(connector, id, "");
        if (skill === undefined) {
            // Unreadable for two reasons: a rotted checkout (reinstall fixes it), or an absent extension tree.
            if (await extensionRuntimeAbsent(connector.extension)) {
                throw new Error(`${provider} is ${RUNTIME_ABSENT_DETAIL}`);
            }
            throw new Error(`the extension declaring "${provider}" has no readable skill file: reinstall it`);
        }
        for (const key of keys) {
            skill = skill.replaceAll(`$${key}`, `$${key}_${suffix}`);
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill);
        // Hook runs visibly in the job session only when it shells out; its return value is a non-fatal warning.
        const hook = CORE_CONNECTOR_HOOKS[provider];
        const session = capabilityJobSession(id);
        if (hook !== undefined && hook.silent !== true && ctx.terminalRun.visible) {
            yield { kind: "terminal", session };
        }
        const warning = await hook?.apply(cliConfig, terminalExec(ctx.terminalRun, session, ctx.workspace.root));
        yield { kind: "log", message: `Connected ${provider}. The agent can use it next turn via its skill + the credential in its env.` };
        if (warning !== undefined) {
            yield { kind: "log", message: warning };
        }
    },
    status: async (ctx, id, config) => {
        if ((await ctx.files.read(loadedSkillFile(ctx.workspace.root, id))) === undefined) {
            return { state: "inactive" };
        }
        // Git access lives in container HOME, wiped by a recreate; pending here means the restore couldn't heal it.
        const cliConfig = config as CliConfig;
        // RUNTIME_ABSENT_DETAIL avoids "rebuild": the runtime can be absent with nothing to rebuild.
        const connector = (await contributionRegistry(hostOf(ctx))).get(contributionKey("cli", cliConfig.provider));
        if (connector !== undefined && (await extensionRuntimeAbsent(connector.extension))) {
            return { state: "pending", detail: RUNTIME_ABSENT_DETAIL };
        }
        if (cliConfig["git"] === "on" && CORE_CONNECTOR_HOOKS[cliConfig.provider] !== undefined && !(await gitAccessWired(gitHostOf(cliConfig)))) {
            return { state: "pending", detail: "git access needs a re-add" };
        }
        // npm's ~/.npmrc line is container-local too; missing here means the boot restore couldn't rewrite it.
        if (cliConfig.provider === "npm" && !(await npmAuthWired())) {
            return { state: "pending", detail: "npm auth needs a re-add" };
        }
        // Voice needs whisper.cpp from the overlay fragment; the gateway reports it via /listeners/discord/status.
        if (cliConfig.provider === "discord" && listenerStatus("discord", Date.now())?.whisperReady === false) {
            return { state: "pending", detail: "voice needs a rebuild (whisper)" };
        }
        // whatsapp's config is just a phone number anyone can type; only the gateway knows whether one ever linked.
        if (cliConfig.provider === "whatsapp") {
            return whatsappStatus(id);
        }
        return { state: "active" };
    },
    remove: async (ctx, id, config) => {
        await CORE_CONNECTOR_HOOKS[(config as CliConfig).provider]?.remove(
            config as CliConfig,
            terminalExec(ctx.terminalRun, capabilityJobSession(id), ctx.workspace.root),
        );
        await removeLoadedSkill(ctx.files, ctx.workspace.root, id);
    },
};
