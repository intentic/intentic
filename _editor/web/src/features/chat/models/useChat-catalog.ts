import {
    type AgentCommand,
    type AgentProvider,
    endpointIdOf,
    endpointProvider,
    isTrialProvider,
    type Model,
    NATIVE_PROVIDERS,
    TRIAL_LABEL,
    type TrialStatusResponse,
} from "@intentic/sandbox-contract";
import { watch } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import {
    acpProviders,
    endpointProviders,
    endpointsLoaded,
    providerCommands,
    providerDefaultModel,
    providerModels,
    providerModelsState,
    trialStatus,
} from "../accounts/providerCatalog";
import { active, conversations } from "../tabs/useChat-tabs";
import { withConcurrency } from "../../../lib/concurrency";
import { sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";

/* A READ whose failure is not news: apply what the daemon sent, and on any failure leave the ref holding
 * whatever it had. Four surfaces here work this way, slash commands, per-account usage, the routed-provider
 * listing, the refusal history, and every one of them is an ANNOTATION on a panel that has its own reason to
 * render. A daemon blip must leave them showing their last reading, never blank them or surface an error the
 * user cannot act on; the connection state itself is reported by the surfaces that own it.
 *
 * The alternative each caller wrote before this was its own try/catch with its own comment saying the same
 * thing, which is four places for that rule to be decided differently. */
export const readOrKeep = async <T>(path: string, apply: (body: T) => void): Promise<void> => {
    try {
        apply(await sandboxJson<T>(path));
    } catch {
        // Left as it was, see above.
    }
};

/* Bumped by resetChat, so a read still in flight when the sandbox changed cannot land its answer in the
 * INCOMING daemon's record. Those commands are the outgoing box's, and a popover offering one the new sandbox
 * does not have is the swallowed-message failure isUnknownSlashCommand exists to prevent: the CLI claims the
 * leading `/`, finds no such command, and discards the rest of the user's message. */
let commandsEpoch = 0;

// Load a provider's daemon-published slash commands into the shared record. Cheap (a cached in-memory read
// daemon-side), so it rides the same reachable seam as the account/model catalogs.
export const loadProviderCommands = (target: AgentProvider): Promise<void> => {
    const epoch = commandsEpoch;
    return readOrKeep<{ commands: AgentCommand[] }>(`/agent/commands?agent=${encodeURIComponent(target)}`, (body) => {
        if (epoch === commandsEpoch) {
            providerCommands.value = { ...providerCommands.value, [target]: body.commands };
        }
    });
};

/* THE SAME READ, ASKED AGAIN BECAUSE THE ANSWER ARRIVES LATE, and asked for the provider the composer is
 * actually on.
 *
 * The daemon learns a provider's commands from its first TURN (agent-commands.ts explains why it is not
 * probed), and it holds them in memory. So the seam above, one read per page load, is racing something it
 * cannot win: a tab opened before any turn has run in this daemon's lifetime — every reload right after a
 * restart or a deploy — cached an empty list, nothing re-asked for the rest of the session, and every
 * conversation opened in that tab had a DEAD `/` popover until it happened to run a turn of its own. The list
 * was there the whole time; only this client's copy was empty.
 *
 * The seam also only ever asked for `claude`, so a conversation on any other provider read an empty record
 * regardless of what its daemon knew.
 *
 * Repeated only while there is nothing to show: a populated list is never re-fetched (a provider's answer only
 * grows within a daemon's life, and a conversation's own turns override it anyway), so the steady state is no
 * requests at all. Concurrent askers — two panes, a provider switch racing a keystroke — share one. */
const commandsInFlight = new Map<AgentProvider, Promise<void>>();

export const ensureProviderCommands = (target: AgentProvider): Promise<void> => {
    if ((providerCommands.value[target] ?? []).length > 0) {
        return Promise.resolve();
    }
    const already = commandsInFlight.get(target);
    if (already !== undefined) {
        return already;
    }
    const reading = loadProviderCommands(target).finally(() => commandsInFlight.delete(target));
    commandsInFlight.set(target, reading);
    return reading;
};

// The reads in flight were asked of the OUTGOING daemon (resetChat): retire their epoch so their answers are
// dropped rather than applied here, and drop the handles so an asker for the incoming sandbox opens its own.
export const retireCommandReads = (): void => {
    commandsEpoch += 1;
    commandsInFlight.clear();
};

// Where a provider's model catalog is read from. Two shapes, because there are two kinds of subject: a native
// provider is one of a closed set the daemon holds a catalog for, so it rides the shared route as a parameter;
// an endpoint is a capability the user created, so its id names the one route configured for it.
const modelsPath = (p: AgentProvider): string => {
    const endpointId = endpointIdOf(p);
    return endpointId !== undefined ? `/endpoints/${encodeURIComponent(endpointId)}/models` : `/providers/${encodeURIComponent(p)}/models`;
};

// Load a provider's live model catalog from the daemon into the shared records (providerModels/
// providerDefaultModel), then keep selections valid: point any native conversation on that provider whose
// model is no longer offered, and the persisted per-provider default, back to the live default (the same
// selection-fix refreshAccounts does for accounts). Claude-Code-harness selections are translator-mapped ids,
// not catalog ids, so they're left alone (claude itself is its own loop on either harness).
const loadProviderModelsOnce = async (target: AgentProvider): Promise<void> => {
    providerModelsState.value = { ...providerModelsState.value, [target]: `loading` };
    let body: { models: Model[]; default: string };
    try {
        const response = await sandboxRequest(modelsPath(target));
        if (!response.ok) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
        body = (await response.json()) as { models: Model[]; default: string };
        if (!Array.isArray(body.models)) {
            providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
            return;
        }
    } catch {
        // The daemon is unreachable/mid-restart; the picker shows the error row with a Retry.
        providerModelsState.value = { ...providerModelsState.value, [target]: `error` };
        return;
    }
    providerModelsState.value = { ...providerModelsState.value, [target]: `loaded` };
    // The daemon's catalog is never empty; the guard keeps us from ever pinning a selection to nothing.
    if (body.models.length === 0) {
        return;
    }
    providerModels.value = {
        ...providerModels.value,
        [target]: body.models.map((entry) => ({
            label: entry.label,
            value: entry.id,
            ...(entry.efforts !== undefined ? { efforts: entry.efforts } : {}),
            ...(entry.description !== undefined ? { description: entry.description } : {}),
            ...(entry.badges !== undefined ? { badges: entry.badges } : {}),
        })),
    };
    providerDefaultModel.value = { ...providerDefaultModel.value, [target]: body.default };
    // Every selection should carry a concrete offered id. Repoint anything empty OR no-longer-offered (a
    // since-renamed/retired id like `grok-code-fast-1`, or a tier alias once the real ids load) to the default,
    // so the picker highlights a selection and the chip always shows a name, never the bare icon. Harness-agnostic
    // now, the catalog is shared, so a claude-code codex/grok selection is validated the same as a native one.
    const valid = new Set(body.models.map((entry) => entry.id));
    for (const conversation of conversations.value) {
        if (conversation.provider.value === target && !valid.has(conversation.model.value)) {
            conversation.model.value = body.default;
        }
    }
    /* THE REMEMBERED PICK IS NOT REWRITTEN FROM A CATALOG, the rule refreshAccounts states for the account, and
     * it belongs here for the same reason: an open chat pinned to an id this list does not carry cannot send,
     * so it moves (above), while the PREFERENCE behind it is a standing choice that no single read is a verdict
     * on. Rewriting it was how a thin answer, a provider whose catalog is still coming up, spent the choice for
     * good. rememberedModelFor resolves it against this very list instead, so a genuinely retired id is stepped
     * over on the way to the default and one that is merely missing this second is honoured again when the
     * catalog carries it. */
};

// One catalog load per provider at a time, the picker's on-open refresh, the reachable seam, and a manual
// retry all reach for the same list, and a second fetch would answer identically. Deduped by POLICY rather
// than by reading `providerModelsState` back as a mutex: that ref is what the picker RENDERS (spinner, error
// row), and using presentation state to decide whether a request may start meant a direct call while one was
// in flight duplicated the fetch, while `loaded` vs `loading` drifting for any other reason broke the dedup.
export const loadProviderModels = withConcurrency(loadProviderModelsOnce, { mode: `singleFlight`, key: (target) => target });

// Refresh every NATIVE provider's catalog, the reachable seam and the picker's on-open refresh both use this,
// so searching across providers always has all lists warm. ACP providers have no daemon catalog (the agent
// owns its own model). In-flight providers collapse into their running load, so this is safe to spam.
export const loadAllProviderModels = async (): Promise<void> => {
    await Promise.all(NATIVE_PROVIDERS.map((target) => loadProviderModels(target)));
};

/* Read the free trial's remaining allowance. Separate from the capability read that discovers the trial exists,
 * because the two answer to different clocks, which endpoints exist changes when someone adds one, while this
 * changes with every message anyone on this account sends, from any tab.
 *
 * A failure leaves the previous figures rather than zeroing them: the count is a courtesy, and a picker that
 * flashed "0 left" because one poll missed would tell a user their trial had ended when it had not. */
export const loadTrialStatus = async (): Promise<void> => {
    try {
        trialStatus.value = (await sandboxJson(`/endpoints/trial/status`)) as TrialStatusResponse;
    } catch {
        // Left as-is; the next reachable load asks again.
    }
};

/* Re-read the allowance the moment a turn settles, so the badge reflects the message that was just sent rather
 * than the state before it. Only for a turn that actually spent the trial: every other provider runs on the
 * user's own account and its count is none of this meter's business, and polling the platform after a Claude
 * turn would be a request that can only ever return the same number. */
watch(
    () => active.value.streaming.value,
    (isStreaming, was) => {
        if (was === true && !isStreaming && isTrialProvider(active.value.provider.value)) {
            void loadTrialStatus();
        }
    },
);

/* The two capability kinds that MINT PROVIDERS, read in one pass because they come from one list: `agent`
 * capabilities are ACP agents (which own their model, so the row IS the provider) and `endpoint` capabilities
 * are model APIs (which have a catalog of their own, loaded straight after).
 *
 * An endpoint's provider id carries the `endpoint/` prefix, that is what tells every surface it runs the full
 * Claude Code loop rather than the ACP floor (capabilitiesOf), and it is what the turn is sent as. */
export const loadCapabilityProviders = async (): Promise<void> => {
    let entries: { id: string; kind: string; config: Record<string, unknown> }[];
    try {
        const body = (await sandboxJson(`/capabilities`)) as { capabilities?: { id: string; kind: string; config: Record<string, unknown> }[] };
        entries = body.capabilities ?? [];
    } catch {
        // Leave the last lists; the picker simply misses new providers until the next reachable load.
        return;
    }
    acpProviders.value = entries
        .filter((entry) => entry.kind === `agent`)
        .map((entry) => ({ id: entry.id, label: typeof entry.config[`name`] === `string` ? (entry.config[`name`] as string) : entry.id }));
    // Labelled by the name the user gave the capability, there is no vendor to name here, and the id is the
    // word they will recognise ("ollama", "gpu-box"). The one exception is the trial, which the user did not
    // name because they did not add it: the daemon provisioned it, so it carries the product's own words.
    // `localmodel` entries ride along because they ARE endpoints to every consumer — the daemon derives their
    // loopback URL and serves their catalog on the same `endpoint/<id>` provider ids (the contract's arm note).
    endpointProviders.value = entries
        .filter((entry) => entry.kind === `endpoint` || entry.kind === `localmodel`)
        .map((entry) => {
            const id = endpointProvider(entry.id);
            // The kind is carried through, not discarded: it is the only thing that tells a locally-run model
            // from a remote server once both are `endpoint/<id>` providers, and the picker draws them apart.
            return {
                id,
                label: isTrialProvider(id) ? TRIAL_LABEL : entry.id,
                kind: entry.kind === `localmodel` ? (`localmodel` as const) : (`endpoint` as const),
            };
        });
    // Each endpoint's catalog is daemon-owned like every other provider's, so load them on the same seam. Not
    // part of loadAllProviderModels: that one runs over a fixed list, and which endpoints exist is what we have
    // only just learned.
    await Promise.all(endpointProviders.value.map((endpoint) => loadProviderModels(endpoint.id)));
    /* The trial's allowance moves with every message, so it is read on the same seam that discovered the trial
     * exists. Failure leaves the last figures, a picker that briefly shows a stale count is better than one
     * that drops the row a user is mid-conversation on.
     *
     * LAST, and after the catalogs above, because this read is what tips the repoint pass onto the trial: a
     * conversation moved there before the trial's models landed would take an empty model id and keep it, since
     * nothing repoints a chat that can already send. */
    await loadTrialStatus();
    /* AND ONLY NOW MAY ANYTHING SAY "you have nothing to send with". Set at the very end, after the endpoints
     * are known AND the allowance has been asked for, because those two together are what decide whether the
     * free trial can serve this sandbox: the one channel a brand-new user has before they connect anything.
     *
     * Not set on the early return above: a failed capability read means we still do not know, and the reachable
     * seam asks again. Same rule `accountsLoaded` follows, for the same reason. */
    endpointsLoaded.value = true;
};

// A singleton per window (hotReload.ts): a hot update that re-ran this module would mint a second set of
// in-flight catalog reads beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
