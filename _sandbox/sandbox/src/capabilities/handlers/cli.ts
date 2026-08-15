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

// A CLI-tool integration: give the AGENT an authenticated command-line tool. The provider's card/fields/env/
// skill/fragment are DATA in an installed extension's `contributes.capabilities` (see contributions.ts) — this
// handler is the generic plumbing over that data. `apply` reads the connector's SKILL.md, templates it for this
// instance ($VAR → $VAR_<ID>), drops it into .agents/skills/<id> (loaded-skills.ts projects it to every
// runtime), and runs the connector's optional core hook (git-over-ssh for github/gitlab). The credential is
// injected into the agent's env each turn (cliEnvOf), never written to a file; the image fragment (psql/whisper)
// rides fragment-sources.

// The three lines the phone's own menu uses, so the card and the handset read as one instruction.
const PHONE_STEPS = "on the phone: WhatsApp → Linked devices → Link a device → Link with phone number instead";

/* WHETHER A PHONE EVER LINKED — the whole of WhatsApp's card status, read from the gateway's snapshot.
 *
 * THE DEFAULT IS "NOT YET", and that inversion is the fix: this used to answer `active` for everything that
 * wasn't holding a code THIS SECOND, which is a set containing the two seconds before the first code, every
 * gap between a dead code and its replacement, a gateway that was restarting, and a number WhatsApp had
 * refused outright. All four rendered as a green "ready" connection, so the add flow considered the setup
 * finished and navigated away from the card — the owner never saw a code because nothing ever showed one.
 *
 * A silent gateway is therefore pending too. It is the state of a fresh add (nothing has posted yet, and the
 * card must stay put and wait), and of a gateway that has stopped — neither of which is a paired phone. */
const whatsappStatus = (id: string): { state: "active" | "pending"; detail?: string; code?: string } => {
    const status = listenerStatus("whatsapp", Date.now());
    if (status === undefined) {
        return { state: "pending", detail: "starting the WhatsApp connection…" };
    }
    const pairing = status.pairing?.[id];
    if (pairing === undefined) {
        // Paired: the gateway reports a ceremony for every capability that still has one.
        return status.connections.some((connection) => connection.capabilityId === id && connection.gateway === "ready")
            ? { state: "active" }
            : { state: "pending", detail: "reconnecting to WhatsApp…" };
    }
    if (pairing.state === "failed") {
        // WhatsApp's own complaint, verbatim — "that number is not registered on WhatsApp" is worth ten of any
        // sentence written here, and the retry behind it is quiet enough that this is all the owner ever sees.
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
    /* Echo the non-secret fields (url etc.) for display; the rotatable secret becomes hasSecret. EVERY declared
     * secret is withheld, not just that one — a two-token connector (Slack: an app-level token to open the socket,
     * a bot token for the Web API) must not ship its second credential to the browser by not being the one
     * /secrets happens to rotate. The web renders the card's label/logo from the connector manifest, not this.
     *
     * WHICH FIELDS ARE SECRET IS THE CONNECTOR'S DATA, so an unresolvable connector means this daemon does not
     * KNOW — and "don't know" has to read as "withhold", not as "nothing is secret". An extension switched off,
     * uninstalled, or whose manifest stopped parsing all resolve to `spec === undefined`, and the empty
     * secret-key set that used to fall out of it echoed every stored credential onto the /capabilities list
     * (maintainer-tier, so a live token reached a collaborator's browser) — a leak that depended on unrelated
     * extension state rather than on anything about the credential. `provider` is the one field the CORE owns
     * (contributionDiscriminator pins it), so it is the only thing safe to echo without the card. */
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
    /* Everything a connector keys by name is derived from it — the skill's frontmatter name, the $VAR_<ID>
     * suffixes inside it, the env the agent gets each turn — so the re-apply writes the lot. All that is left
     * is the old skill directory, which nothing would otherwise delete and which would go on offering the agent
     * a cheatsheet for credentials that no longer exist under those names. */
    rename: { carry: async (ctx, from) => removeLoadedSkill(ctx.files, ctx.workspace.root, from) },
    apply: async function* (ctx, id, config) {
        const cliConfig = config as CliConfig;
        const { provider } = cliConfig;
        const connector = (await contributionRegistry(hostOf(ctx))).get(contributionKey("cli", provider));
        if (connector === undefined) {
            throw new Error(`no connector for provider "${provider}" — install the extension that declares it`);
        }
        const invalid = validateContributionConfig(connector.spec, cliConfig);
        if (invalid !== undefined) {
            throw new Error(invalid);
        }
        // Template the static skill for this instance: frontmatter name → the (unique) id so two instances of
        // one provider don't register the same skill name, and each $VAR → its per-instance suffixed name so the
        // agent reads this instance's credentials. Longest keys first to avoid one key corrupting another's prefix.
        const suffix = envSuffix(id);
        const keys = connector.spec.kind === "cli" ? Object.keys(connector.spec.env).toSorted((a, b) => b.length - a.length) : [];
        // No `${tools}` slot for cli: a connector's cheatsheet is about ITS tool, and there is no shared surface
        // behind it the way a browser or a connected computer has one.
        let skill = await contributedSkill(connector, id, "");
        if (skill === undefined) {
            // Two very different reasons the cheatsheet isn't readable, and only one of them is anybody's fault.
            // A rotted checkout is repaired by reinstalling; a messaging connector on a core image is the whole
            // extension tree not being in this image, which no amount of reinstalling brings.
            if (await extensionRuntimeAbsent(connector.extension)) {
                throw new Error(`${provider} is ${RUNTIME_ABSENT_DETAIL}`);
            }
            throw new Error(`the extension declaring "${provider}" has no readable skill file — reinstall it`);
        }
        for (const key of keys) {
            skill = skill.replaceAll(`$${key}`, `$${key}_${suffix}`);
        }
        await writeLoadedSkill(ctx.files, ctx.workspace.root, id, skill);
        // The connector's optional privileged hook (github/gitlab git-over-ssh), run visibly in the capability's
        // job session — surfaced only when it actually shells out. A returned message is a non-fatal warning.
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
        // The skill and the manifest are on /work; git access is in the container's HOME, which a recreate
        // wipes — so without this the card read "active" while `git pull` answered Permission denied. The boot
        // restore heals that; a `pending` here is what a restore that COULDN'T (revoked token, no network on
        // the full-setup path) looks like, instead of a card that lies about it.
        const cliConfig = config as CliConfig;
        /* The card is in every image; the gateway behind a messaging connector is not. Without this the card
         * read "active" on a core image — the two checks below both go through a status the gateway PUSHES, and
         * a gateway that was never started pushes nothing, so both fell through to active. There is no
         * connection here and no way to make one, so it is stated rather than implied by silence. Worded
         * without "rebuild" on purpose: these trees ride a publish-time build context, so the environment
         * overlay the web sends a rebuild-worded status to could not install them.  */
        const connector = (await contributionRegistry(hostOf(ctx))).get(contributionKey("cli", cliConfig.provider));
        if (connector !== undefined && (await extensionRuntimeAbsent(connector.extension))) {
            return { state: "pending", detail: RUNTIME_ABSENT_DETAIL };
        }
        if (cliConfig["git"] === "on" && CORE_CONNECTOR_HOOKS[cliConfig.provider] !== undefined && !(await gitAccessWired(gitHostOf(cliConfig)))) {
            return { state: "pending", detail: "git access needs a re-add" };
        }
        // npm's credential rides the same seam: the ~/.npmrc auth line is container-local, a recreate wipes it,
        // and the boot restore rewrites it — so a missing line is a restore that couldn't, not a healthy card.
        if (cliConfig.provider === "npm" && !(await npmAuthWired())) {
            return { state: "pending", detail: "npm auth needs a re-add" };
        }
        // Discord's voice transcription rides whisper.cpp from the connector's overlay fragment — until the owner
        // rebuilds, the text tools work but voice doesn't. The gateway process reports whisper's presence via
        // /listeners/discord/status (whisper runs there now, not in the daemon), so surface pending off that.
        if (cliConfig.provider === "discord" && listenerStatus("discord", Date.now())?.whisperReady === false) {
            return { state: "pending", detail: "voice needs a rebuild (whisper)" };
        }
        // WhatsApp's credential is a pairing ceremony, not a token, and it is the ONE provider here whose
        // "active" cannot be inferred from a stored config: the config is a phone number anybody can type, and
        // whether a phone ever linked is a fact only the gateway holds.
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
