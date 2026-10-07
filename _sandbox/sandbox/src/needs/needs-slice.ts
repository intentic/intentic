import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Capability } from "@intentic/sandbox-contract";
import { envSuffix, grantSite } from "@intentic/sandbox-contract";
import { ENV_FILE } from "@intentic/scaffold";
import type { Logger } from "pino";
import { capabilityCtx } from "../capabilities/capability.js";
import { contributionEnv, contributionFor, contributionRegistry, contributionSecretFields } from "../capabilities/contributions.js";
import { connectableEntries } from "../capabilities/offers/connectable.js";
import { registry } from "../capabilities/registry.js";
import type { Services } from "../composition.js";
import { liveRequestRun } from "../conversations/actor/card-deps.js";
import { liveRunOf } from "../conversations/actor/conversation-holdings.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { appliedEnvironmentHash, approveDraft, proposeDraft, rejectDraft } from "../environment/environment.js";
import { deliverWake } from "../agent/run/turn/wake-delivery.js";
import { deliverToListenerChannel } from "../extensions/listener/listener-deliver.js";
import { needRaised, needResolved } from "../push/notifications.js";
import { upsertEnv } from "../secrets/env-text.js";
import { textFile } from "../store/text-file.js";
import { capabilityNeed } from "./kinds/capability-need.js";
import { automationNeed } from "./kinds/automation-need.js";
import { environmentNeed } from "./kinds/environment-need.js";
import { refuseInvalidAutomation, saveAutomation } from "../automations/automation-save.js";
import { checkSource } from "../automations/watch/watch-sources.js";
import { sourceEnv } from "../automations/watch/watch-condition.js";
import { grantNeed } from "./kinds/grant-need.js";
import { releaseNeed } from "./kinds/release-need.js";
import { secretNeed } from "./kinds/secret-need.js";
import { needChannelOf, needChannelText } from "./need-channel.js";
import { createNeeds, type Needs, type NeedsDeps } from "./needs.js";
import { fileNeedsStore, needsDocument } from "./needs-store.js";

// How long one browser may take to say which sites it allows before the last answer stands, so a sleeping laptop never
// stalls the needs check.
const SITE_CHECK_TIMEOUT_MS = 3_000;

// The needs service as the daemon composes it (docs/architecture/needs.md): each kind over the subsystem that owns what
// it asks for, and the lifecycle over the turn engine's doors. Every seam reads the finished Services when it is called,
// never when this is built, since a need is raised and met long after boot.

export interface NeedsSlice {
    readonly needs: Needs;
}

export interface NeedsSliceDeps {
    readonly workspaceRoot: string;
    readonly logger: Logger;
    readonly whole: () => Services;
}

// What a cli connection can do before its variables load on the next turn: each variable assigned from the references
// its template would have expanded, which the Claude Code loop substitutes at execution. A template that percent-encodes
// a credential cannot carry a reference (the braces would be encoded), so a connection with one is left to the next turn.
const usableNow = async (services: Services, capability: Capability): Promise<readonly string[]> => {
    if (capability.kind !== "cli") {
        return [];
    }
    const connector = contributionFor(await contributionRegistry(services), "cli", capability.config);
    if (connector === undefined || connector.spec.kind !== "cli") {
        return [];
    }
    const secrets = contributionSecretFields(connector.spec);
    const encoded = Object.values(connector.spec.env).some((template) => [...secrets].some((field) => template.includes(`\${${field}:uri}`)));
    if (encoded) {
        return [];
    }
    const config = Object.fromEntries(
        Object.entries(capability.config).map(([key, value]) => [key, secrets.has(key) ? `{{secret:${capability.id}/${key}}}` : String(value ?? "")]),
    );
    const suffix = envSuffix(capability.id);
    return Object.entries(contributionEnv(connector.spec, config)).map(([key, value]) => `${key}_${suffix}=${value}`);
};

// Stores a secret where its reference resolves: in desired-state/.env when that is where the name already lives (its
// value would shadow the sandbox store's otherwise), else in the sandbox's own store.
const keepSecret = async (services: Services, name: string, value: string): Promise<void> => {
    const desiredState = services.workspace.repos["desired-state"];
    const env = textFile(join(desiredState, ENV_FILE), 0o600);
    if (existsSync(desiredState) && name in parseEnv(await env.read())) {
        await env.update((current) => upsertEnv(current, name, value));
        return;
    }
    await services.sandboxSecrets.set(name, value);
};

// A settled need's lock-screen ask is replaced on the devices it showed on (push.ts `withdraw`).
const withdrawNeedPush =
    (whole: NeedsSliceDeps["whole"]): NeedsDeps["withdrawNotification"] =>
    (need) =>
        void whole().pushSender.withdraw(needResolved(need));

export const createNeedsSlice = ({ workspaceRoot, logger, whole }: NeedsSliceDeps): NeedsSlice => {
    const capabilities = (): Promise<readonly Capability[]> => whole().capabilities.list();
    const secret = secretNeed({
        registry: () => whole().secretRegistry(),
        keep: (name, value) => keepSecret(whole(), name, value),
    });
    const needs = createNeeds({
        store: fileNeedsStore(join(workspaceRoot, needsDocument.path)),
        kinds: {
            capability: capabilityNeed({
                entries: () => connectableEntries(whole()),
                capabilities,
                status: (capability) => registry[capability.kind].status(capabilityCtx(whole()), capability.id, capability.config),
                gates: () => whole().credentialGates.list(),
                usableNow: (capability) => usableNow(whole(), capability),
            }),
            secret,
            grant: grantNeed({
                capabilities,
                personas: { get: (id) => whole().personas.get(id), upsert: (persona) => whole().personas.upsert(persona) },
                grants: () => whole().conversationGrants,
                personaIdByName: async (name) => (await whole().personas.list()).find((persona) => (persona.label ?? persona.id) === name)?.id,
                // Every one of the person's browsers, asked fresh (a sleeping one answers what it said last).
                siteAllowed: async (site) => {
                    const services = whole();
                    const browsers = (await services.capabilities.list()).filter((capability) => capability.kind === "webext");
                    for (const browser of browsers) {
                        await services.webextHub.refresh(browser.id, SITE_CHECK_TIMEOUT_MS);
                        if (services.webextHub.state(browser.id).facts?.grants.some((grant) => grantSite(grant.origin) === site) === true) {
                            return true;
                        }
                    }
                    return false;
                },
            }),
            release: releaseNeed({
                gates: () => whole().credentialGates.list(),
                grants: () => whole().credentialGrants,
                exists: async (subject) =>
                    (await capabilities()).some((capability) => capability.id === subject) ||
                    (await whole().secretRegistry()).some((stored) => stored.name === subject),
            }),
            environment: environmentNeed({
                propose: (tool, steps) => proposeDraft(whole(), tool, steps),
                approve: (tool) => approveDraft(whole(), tool),
                reject: (tool) => rejectDraft(whole(), tool),
                appliedHash: () => appliedEnvironmentHash(whole()),
            }),
            automation: automationNeed({
                refuse: (automation) => refuseInvalidAutomation(whole(), automation),
                save: (automation) => saveAutomation(whole(), automation),
                exists: async (id) => (await whole().automations.get(id)) !== undefined,
                firstCheck: async (automation) => {
                    if (automation.source === undefined) {
                        return undefined;
                    }
                    const checked = await checkSource(automation.source, {
                        fetch: (url, init) => fetch(url, init),
                        env: await sourceEnv(whole(), automation),
                    });
                    return { pass: checked.pass, saw: checked.pass ? checked.output : checked.detail, at: Date.now() };
                },
            }),
        },
        logger,
        raisingConversation: (named) => liveRequestRun(whole().conversations)(named)?.conversationId,
        standingOf: (conversationId) => turnStandingOf(whole().conversations, conversationId),
        isLive: (conversationId) => liveRunOf(whole().conversations, conversationId) !== undefined,
        draw: (conversationId, need) => {
            const frame = { kind: "need" as const, need };
            liveRunOf(whole().conversations, conversationId)?.push(frame);
            // Frames raised outside the turn's own pump reach its actor by hand, as every card raised this way does.
            void whole().conversations.send(conversationId, { kind: "frame", frame });
        },
        show: (conversationId, shown) => void whole().conversations.send(conversationId, { kind: "needs-shown", needs: shown }),
        notify: (need) => {
            const services = whole();
            const entry = services.agents.entry(need.conversationId);
            void services.pushSender.notifyIfAway(needRaised(need, entry?.social.title?.text));
            // Said in the channel the conversation came from too, where its person may be the only place it reaches them.
            const channel = needChannelOf(entry?.identity.origin);
            if (channel !== undefined) {
                void deliverToListenerChannel(services, channel, needChannelText(need)).catch((error: unknown) =>
                    logger.warn({ err: error, conversationId: need.conversationId, provider: channel.provider }, "needs: the channel did not take the ask"),
                );
            }
        },
        withdrawNotification: withdrawNeedPush(whole),
        steer: async (conversationId, prompt) => (await whole().turns.steer(conversationId, { text: prompt, voice: "sandbox" })) === true,
        wake: async (conversationId, prompt) => {
            const services = whole();
            const entry = services.agents.entry(conversationId);
            if (entry === undefined) {
                return undefined;
            }
            const receipt = await deliverWake(
                { turns: services.turns, sessionIdOf: (id) => services.conversations.sessionIdOf(id) },
                { conversationId, prompt, voice: "sandbox", source: "needs", profile: conversationProfile(entry) },
            );
            if (!("delivered" in receipt)) {
                logger.warn({ conversationId, receipt }, "needs: the conversation took nothing");
                return undefined;
            }
            return receipt.delivered === "queued" ? "queued" : "turn";
        },
        continueWhenMet: async () => (await whole().sandboxSettings.get()).continueWhenNeedMet,
        provideSecret: (need, value) => secret.provide(need, value),
        onTurnEnded: (listener) => whole().events.subscribe("run.settled", ({ conversationId }) => listener(conversationId)),
    });
    return { needs };
};
