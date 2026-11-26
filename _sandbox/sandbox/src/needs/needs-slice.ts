import { askedAudience, OPERATORS } from "../push/push-audience.js";
import { childActor } from "../auth/principal.js";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { envSuffix } from "@intentic/sandbox-contract/policy/capability-env";
import { grantSite } from "@intentic/sandbox-contract/schemas/needs";
import type { Logger } from "pino";
import { capabilityCtx } from "../capabilities/capability.js";
import { contributionEnv, contributionFor, contributionRegistry, contributionSecretFields } from "../capabilities/contributions.js";
import { connectableEntries } from "../capabilities/offers/connectable.js";
import { registry } from "../capabilities/registry.js";
import type { CompositionCore, Services } from "../composition.js";
import { liveRequestRun } from "../conversations/actor/card-deps.js";
import { liveRunOf } from "../conversations/actor/conversation-holdings.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { conversationProfile } from "../conversations/registry/agents-store.js";
import { approveDraft, proposeDraft, rejectDraft, toolStanding } from "../environment/environment.js";
import { composeEnvironment } from "../environment/overlay.js";
import { onRuntimeChange } from "../seams/runtime-feed.js";
import { versionedRepoWrite } from "../seams/config-commits/settings-versions.js";
import { deliverWake } from "../seams/wake-delivery.js";
import { oweToListenerChannel } from "../extensions/listener/listener-outbox.js";
import { needRaised, needResolved } from "../push/notifications.js";
import { defineSlice } from "../seams/slice.js";
import { capabilityNeed } from "./kinds/capability-need.js";
import { automationNeed } from "./kinds/automation-need.js";
import { environmentNeed } from "./kinds/environment-need.js";
import { instructionNeed, type InstructionNeedDeps } from "./kinds/instruction-need.js";
import { claimNeed } from "./kinds/claim-need.js";
import { deployNeed } from "./kinds/deploy-need.js";
import { pairedDevice } from "../secrets/stack-grants/stack-grants.js";
import { routeNeedOf } from "./kinds/route-need.js";
import { redirectNeedOf } from "./kinds/redirect-need.js";
import { projectOfRemote } from "../account-routing/account-outbox.js";
import { claimedHere, holderOf } from "../account-routing/project-claims.js";
import { resolveRealWithin } from "../workspace/files/workspace-files-paths.js";
import { undefinedIfMissing } from "@intentic/base/errors";
import { refuseInvalidAutomation, saveAutomation } from "../automations/automation-save.js";
import { checkWatchSource } from "../automations/watch/contributed-check.js";
import { catalogWatchKinds } from "../automations/watch/watch-kinds.js";
import { grantNeed } from "./kinds/grant-need.js";
import { hostPowerNeed } from "./kinds/host-power-need.js";
import { wslMemoryNeed } from "./kinds/wsl-memory-need.js";
import { runDeviceAgentFlow } from "../hosts/device-reports.js";
import { releaseNeed } from "./kinds/release-need.js";
import { keepOnDevice } from "./kinds/secret-keep-on.js";
import { type GuardStart, secretNeed } from "./kinds/secret-need.js";
import { startGuard } from "../secrets/guards/host-guards.js";
import { needChannelOf, needChannelText } from "./need-channel.js";
import { strangersOf } from "../automations/fire/wake-source.js";
import { createNeeds, type Needs, type NeedsDeps } from "./needs.js";
import { fileNeedsStore, needsDocument } from "./needs-store.js";

// How long one browser may take to say which sites it allows before the last answer stands, so a sleeping laptop never
// stalls the needs check.
const SITE_CHECK_TIMEOUT_MS = 3_000;
// How long a computer is given to describe itself again after a host-power card changed its settings.
const POWER_REFRESH_MS = 8_000;

// The needs service as the daemon composes it (docs/architecture/needs.md): each kind over the subsystem that owns what
// it asks for, and the lifecycle over the turn engine's doors. Every seam reads the finished Services when it is called,
// never when this is built, since a need is raised and met long after boot.

export interface NeedsSlice {
    readonly needs: Needs;
}

interface NeedsSliceDeps {
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

// The repository an AGENTS.md on the main tree belongs to, and its path there: a top-level folder that is a repository
// of its own (agentWorktrees.mainDir), else the workspace root's.
const repoOfFile = (workspaceRoot: string, file: string): { readonly repo: string; readonly path: string } => {
    const [top = "", ...rest] = file.split("/");
    return rest.length > 0 && existsSync(join(workspaceRoot, top, ".git")) ? { repo: top, path: rest.join("/") } : { repo: "root", path: file };
};

// An AGENTS.md on the main tree, through the escape guard: a path, or a symlinked folder, that leads out of the
// workspace is refused rather than read or written. A write is committed on its own in that file's repository.
const mainTreeFiles = (workspaceRoot: string, whole: NeedsSliceDeps["whole"]): InstructionNeedDeps => {
    const within = async (file: string): Promise<string> => {
        const resolved = await resolveRealWithin(workspaceRoot, file);
        if (resolved === undefined) {
            throw new Error(`${file} leads outside the workspace`);
        }
        return resolved.path;
    };
    return {
        read: async (file) => readFile(await within(file), "utf8").catch(undefinedIfMissing),
        write: async (file, text, subject) => {
            const at = await within(file);
            const { repo, path } = repoOfFile(workspaceRoot, file);
            return (await versionedRepoWrite(whole(), repo, [path], subject, () => writeFile(at, text))).committed;
        },
        // The root itself is no path inside it (resolveWithin), so it is named here.
        folder: async (file) => {
            const at = dirname(file) === "." ? workspaceRoot : (await resolveRealWithin(workspaceRoot, dirname(file)))?.path;
            return at !== undefined && (await stat(at).catch(undefinedIfMissing))?.isDirectory() === true;
        },
    };
};

// A secret need over the finished services: the registry, the stores a value is kept in, and the keyrings.
const secretNeedOf = (whole: NeedsSliceDeps["whole"]) =>
    secretNeed({
        registry: () => whole().secretRegistry(),
        keep: (name, value) => whole().sandboxSecrets.set(name, value),
        deviceHeld: async () => (await whole().deviceSecrets.listed()).map((entry) => entry.pointer.name),
        keepOn: (name, value, keepOn) => keepOnDevice(whole(), name, value, keepOn),
        startGuard: (name, hosts) => startHostGuard(whole(), name, hosts),
    });

// An unreadable or unwritable guard file is answered as failed, never read as every guard off: the value is still stored,
// and the agent is told its guard is off and how to turn it on.
const startHostGuard = async (services: Pick<Services, "hostGuards" | "secretHostGuards">, name: string, hosts: readonly string[]): Promise<GuardStart> => {
    try {
        return await startGuard(services.secretHostGuards, services.hostGuards, name, hosts);
    } catch {
        // allow(silent-catch): answered as "failed", which the agent reads; the value is stored either way.
        return "failed";
    }
};

// A host-power need over the computer's facts as the hub holds them, its agent op run as the Devices view runs it.
const hostPowerNeedOf = (whole: NeedsSliceDeps["whole"]) =>
    hostPowerNeed({
        facts: (device) => whole().hostHub.state(device).facts,
        online: (device) => whole().hostHub.online(device),
        runAgentFlow: (device, flow) => runDeviceAgentFlow(whole(), device, flow),
        refresh: (device) => whole().hostHub.refresh(device, POWER_REFRESH_MS),
    });

// A wsl-memory need over the PC's facts as the hub holds them, its agent op run as the power card's is.
const wslMemoryNeedOf = (whole: NeedsSliceDeps["whole"]) =>
    wslMemoryNeed({
        facts: (device) => whole().hostHub.state(device).facts,
        online: (device) => whole().hostHub.online(device),
        runAgentFlow: (device, flow) => runDeviceAgentFlow(whole(), device, flow),
        refresh: (device) => whole().hostHub.refresh(device, POWER_REFRESH_MS),
    });

// A raised need's push, to the people the conversation's asks wait on (push/push-audience.ts), and its words in the
// channel the conversation came from, where its person may be the only place it reaches them.
// (2026-11-22) A host-power card is about one of the owner's own computers, and only a maintainer may answer it
// (kinds/host-power-need.ts `mayAnswer`): it goes to the sandbox's operators, never to the conversation's other people,
// and never into the channel it came from, where nobody could act on it. (2026-11-26) A wsl-memory card is the same: the
// owner's PC, a maintainer's answer.
const notifyNeed =
    (whole: NeedsSliceDeps["whole"], logger: NeedsSliceDeps["logger"]): NeedsDeps["notify"] =>
    (need) => {
        const services = whole();
        const entry = services.agents.entry(need.conversationId);
        const raised = needRaised(need, entry?.social.title?.text);
        if (need.subject.kind === "host-power" || need.subject.kind === "wsl-memory") {
            void services.pushSender.notifyIfAway(raised, OPERATORS);
            return;
        }
        void services.pushSender.notifyIfAway(raised, askedAudience((id) => services.agents.entry(id), need.conversationId));
        const origin = entry?.identity.origin;
        void (async () => {
            const channel = needChannelOf(origin, origin === undefined ? undefined : await strangersOf(services, origin.provider));
            if (channel !== undefined) {
                await oweToListenerChannel(services, channel, needChannelText(need));
            }
        })().catch((error: unknown) =>
            logger.warn({ err: error, conversationId: need.conversationId, provider: origin?.provider }, "needs: the ask could not be journalled for its channel"),
        );
    };

// A settled need's lock-screen ask is replaced on the devices it showed on (push.ts `withdraw`).
const withdrawNeedPush =
    (whole: NeedsSliceDeps["whole"]): NeedsDeps["withdrawNotification"] =>
    (need) =>
        void whole().pushSender.withdraw(needResolved(need));

// Whether any of the person's browsers allows `site`, by the facts the hub holds (a sleeping one answers what it said
// last). `fresh` asks each one again first, each within the site-check timeout.
const browsersAllow = async (services: Services, site: string, fresh: boolean): Promise<boolean> => {
    const browsers = (await services.capabilities.list()).filter((capability) => capability.kind === "webext");
    if (fresh) {
        await Promise.all(browsers.map((browser) => services.webextHub.refresh(browser.id, SITE_CHECK_TIMEOUT_MS)));
    }
    return browsers.some((browser) => services.webextHub.state(browser.id).facts?.grants.some((grant) => grantSite(grant.origin) === site) === true);
};

// The runtime domains whose change can meet an open need: a connection, a grant, a browser's sites, a machine.
const WORLD_DOMAINS: ReadonlySet<string> = new Set(["capabilities", "grants", "webext", "hosts"]);

// One pass's site answers (2026-10-20). Only the boot and fallback passes ask the browsers again, once per pass: a pass
// a change started reads the facts that change brought (a browser's grants-changed push refreshes first).
const passSiteChecks = (whole: NeedsSliceDeps["whole"]) => {
    let answers = new Map<string, boolean>();
    let fresh = false;
    return {
        begin: (passIsFresh: boolean): void => {
            answers = new Map();
            fresh = passIsFresh;
        },
        siteAllowed: async (site: string): Promise<boolean> => {
            const cached = answers.get(site);
            if (cached !== undefined) {
                return cached;
            }
            const allowed = await browsersAllow(whole(), site, fresh);
            fresh = false;
            answers.set(site, allowed);
            return allowed;
        },
    };
};

// What makes a needs pass run now rather than on the fallback timer (2026-10-20): the runtime domains above, a secret
// stored anywhere, and a keyring read that may list a new entry.
const worldChangesOf =
    (whole: NeedsSliceDeps["whole"], logger: NeedsSliceDeps["logger"]): NonNullable<NeedsDeps["subscribeWorldChanges"]> =>
    (recheck) => {
        const services = whole();
        const stops = [
            onRuntimeChange((domains) => {
                if (domains.some((domain) => WORLD_DOMAINS.has(domain))) {
                    recheck();
                }
            }, logger),
            services.onSecretsChanged(recheck),
            services.keyringLink.onRefreshed(() => recheck()),
        ];
        return () => {
            for (const stop of stops) {
                stop();
            }
        };
    };

const createNeedsSlice = ({ workspaceRoot, logger, whole }: NeedsSliceDeps): NeedsSlice => {
    const capabilities = (): Promise<readonly Capability[]> => whole().capabilities.list();
    const secret = secretNeedOf(whole);
    const sites = passSiteChecks(whole);
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
                roles: () => whole().roles.list(),
                profiles: () => whole().accessProfiles.list(),
                areas: () => whole().areas.list(),
                wearRole: async (conversationId, role) => (await whole().agents.wearRole(conversationId, role)) !== undefined,
                siteAllowed: sites.siteAllowed,
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
                standing: (subject) => toolStanding(whole(), subject),
                composedHash: async () => (await composeEnvironment(whole()))?.hash,
            }),
            automation: automationNeed({
                refuse: (automation) => refuseInvalidAutomation(whole(), automation),
                // Made by the conversation that proposed it: its people hear what the automation finds.
                save: (automation, conversationId) => saveAutomation(whole(), automation, childActor(conversationId)),
                exists: async (id) => (await whole().automations.get(id)) !== undefined,
                firstCheck: async (automation) => {
                    if (automation.source === undefined) {
                        return undefined;
                    }
                    const checked = await checkWatchSource(whole(), automation.source, { automation });
                    return { pass: checked.pass, saw: checked.pass ? checked.output : checked.detail, at: Date.now() };
                },
                watchKind: async (source) => (await catalogWatchKinds(whole())).find((kind) => kind.id === source.kind),
            }),
            // On the main tree, the owner's own copy, never a conversation's checkout.
            instruction: instructionNeed(mainTreeFiles(workspaceRoot, whole)),
            "host-power": hostPowerNeedOf(whole),
            "wsl-memory": wslMemoryNeedOf(whole),
            // The platform's directory, asked over the connect token; the claim itself is the owner's press.
            claim: claimNeed({
                normalize: projectOfRemote,
                claimedHere: () => claimedHere(whole().config),
                holder: (project) => holderOf(whole().config, project),
                ownerEmail: () => whole().ownerEmail(),
            }),
            // A person's leave to route as them into another sandbox; the pairing itself is their press.
            route: routeNeedOf(whole),
            redirect: redirectNeedOf(whole),
            // A managed stack's secrets, granted by the owner's press into the auth root a managed deploy reads
            // (secrets/stack-grants/stack-grants.ts).
            deploy: deployNeed({
                device: (device) => pairedDevice(whole(), device),
                grantFor: (ref) => whole().stackGrants.forStack(ref),
                grant: (ref, secrets, by) => whole().stackGrants.add(ref, secrets, by),
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
        notify: notifyNeed(whole, logger),
        withdrawNotification: withdrawNeedPush(whole),
        steer: async (conversationId, prompt) => (await whole().turns.steer(conversationId, { text: prompt, voice: "sandbox" })) === true,
        wake: async (conversationId, prompt) => {
            const services = whole();
            const entry = services.agents.entry(conversationId);
            if (entry === undefined) {
                return undefined;
            }
            const receipt = await deliverWake(
                { turns: services.turns },
                { conversationId, prompt, voice: "sandbox", source: "needs", profile: conversationProfile(entry) },
            );
            if (!("delivered" in receipt)) {
                logger.warn({ conversationId, receipt }, "needs: the conversation took nothing");
                return undefined;
            }
            return receipt.delivered === "queued" ? "queued" : "turn";
        },
        continueWhenMet: async () => (await whole().sandboxSettings.get()).continueWhenNeedMet,
        provideSecret: (need, value, given) => secret.provide(need, value, given),
        onTurnEnded: (listener) => whole().events.subscribe("run.settled", ({ conversationId }) => listener(conversationId)),
        beginCheckPass: sites.begin,
        subscribeWorldChanges: worldChangesOf(whole, logger),
    });
    return { needs };
};

export const needsSlice = defineSlice<NeedsSlice>({
    build: ({ workspace, logger, whole }: Pick<CompositionCore, "workspace" | "logger" | "whole">) =>
        createNeedsSlice({ workspaceRoot: workspace.root, logger, whole }),
});
