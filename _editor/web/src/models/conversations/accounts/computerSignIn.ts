import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { LoginStart } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { t } from "@intentic/ui/i18n";
import { useSandboxScope } from "../../../client/sandbox/scope/useSandboxScope";
import { computerHarnesses, noteHarnessAccountsRead, noteHarnessRefused } from "../../providers/computer/computerHarnesses";
import { defaultModelFor } from "../../providers/providerCatalog";
import { conversations } from "../tabs/useChat-tabs";

/* SETTING UP AND SIGNING IN A CODING AGENT OF THIS COMPUTER (2026-11-24). One press does both: `accounts.start` fetches
   the harness first where this computer has none (minutes, on a slow line), then runs the harness's own sign-in, which
   opens the browser on this computer and finishes by itself. Nothing here holds a credential or sees one: the window
   only watches the attempt (`accounts.status`) and reads the computer's harnesses again once it has landed. */

/** Where one harness's press stands: asked and not yet answered, waiting on the browser, or refused with the words why. */
export type HarnessAttempt =
    | { readonly phase: `starting` }
    | { readonly phase: `waiting`; readonly handshake: string; readonly url: string }
    | { readonly phase: `failed`; readonly error: string };

export const harnessAttempts = sandboxRef<Readonly<Record<string, HarnessAttempt>>>(() => ({}));

const POLL_MS = 1500;

// The folder this window shows is the one "sandbox" it has: every call here goes to its sidecar, by its own scope.
const rpc = () => useSandboxScope().rpc;

// The computer could not be told to stop waiting: the attempt times out there by itself, so this is only worth a line.
const cancelFailed = (cause: unknown): void => console.warn(`[agents here] a sign-in could not be cancelled`, cause);

// SAFETY: the account routes are typed for a sandbox's own providers; on this computer a provider is whichever harness
// the sidecar listed, and the sidecar answers for exactly those ids and refuses any other.
const routed = (id: AgentProvider): NativeProvider => id as NativeProvider;

// The press each harness's attempt belongs to: a cancelled or repeated press leaves the earlier one's answers unread.
// allow(module-state): one attempt per harness per window, whichever surface pressed.
const tickets = new Map<string, number>();
let issued = 0;
const live = (id: string, ticket: number): boolean => tickets.get(id) === ticket;

const put = (id: string, attempt: HarnessAttempt | undefined): void => {
    const rest = Object.entries(harnessAttempts.value).filter(([key]) => key !== id);
    harnessAttempts.value = Object.fromEntries(attempt === undefined ? rest : [...rest, [id, attempt]]);
};

// The account and catalog readers hold the whole chat's reading state. They are asked for when a press or the page
// first needs them, so a strip that only draws the press pulls neither into a pane's first paint.
const readers = async () => {
    const [accounts, catalog] = await Promise.all([import(`./useChat-accounts`), import(`./useChat-catalog`)]);
    return { refreshAccounts: accounts.refreshAccounts, loadProviderModels: catalog.loadProviderModels, loadRunnableProviders: catalog.loadRunnableProviders };
};

// One runnable harness's stored sign-in and its models, as the harness itself states them.
const readHarness = async (id: AgentProvider): Promise<void> => {
    const current = sandboxScopeGuard();
    const { refreshAccounts, loadProviderModels } = await readers();
    const read = await refreshAccounts(id).then(
        () => true,
        () => false,
    );
    if (read && current()) {
        noteHarnessAccountsRead(id);
    }
    await loadProviderModels(id);
};

// A conversation nothing was sent from, standing on a harness this computer cannot run now, moves to the first one it
// can: a fresh chat opens on the sandbox's default provider, which may be a program this reader never installed.
const seatDrafts = (): void => {
    const ready = computerHarnesses.value.filter((harness) => harness.standing === `ready`);
    const [first] = ready;
    if (first === undefined) {
        return;
    }
    for (const conversation of conversations.value) {
        const unsent = !conversation.registered.value && conversation.session.value === undefined;
        if (unsent && !ready.some((harness) => harness.id === conversation.selection.provider.value)) {
            conversation.selection.apply({ kind: `selectModel`, pick: { provider: first.id, value: defaultModelFor(first.id) } });
        }
    }
};

/** Reads which coding agents this computer runs, then each runnable one's sign-in and models. */
export const readComputerHarnesses = async (): Promise<void> => {
    const { loadRunnableProviders } = await readers();
    await loadRunnableProviders().ready;
    await Promise.all(computerHarnesses.value.filter((harness) => harness.asked && harness.standing !== `setUp`).map((harness) => readHarness(harness.id)));
    seatDrafts();
};

const landed = async (id: AgentProvider, ticket: number): Promise<void> => {
    noteHarnessRefused(id, false);
    await readComputerHarnesses();
    if (live(id, ticket)) {
        tickets.delete(id);
        put(id, undefined);
    }
};

// Watches the attempt itself, not the account list: a list that already named an account says nothing about this one.
const watchAttempt = async (id: AgentProvider, ticket: number, start: LoginStart): Promise<void> => {
    while (live(id, ticket)) {
        if (Date.now() > start.expiresAt) {
            put(id, { phase: `failed`, error: t(`chat.computer.harness.timedOut`) });
            return;
        }
        const status = await rpc().accounts.status({ provider: routed(id), handshake: start.handshake });
        if (!live(id, ticket)) {
            return;
        }
        if (status.status === `ok`) {
            await landed(id, ticket);
            return;
        }
        if (status.status === `error`) {
            put(id, { phase: `failed`, error: status.error });
            return;
        }
        await sleep(POLL_MS);
    }
};

/** The press: sets the harness up where it has to be fetched, signs it in, and reads this computer's harnesses again. */
export const startHarness = async (id: AgentProvider): Promise<void> => {
    issued += 1;
    const ticket = issued;
    tickets.set(id, ticket);
    put(id, { phase: `starting` });
    try {
        // No deadline: the answer comes once the harness is on this computer, however long the download takes.
        const start = await rpc().accounts.start({ provider: routed(id) }, { context: { deadline: false } });
        if (!live(id, ticket)) {
            // Given up while it was still being fetched: nobody waits on this attempt any more.
            void rpc().accounts.cancel({ provider: routed(id), handshake: start.handshake }).catch(cancelFailed);
            return;
        }
        put(id, { phase: `waiting`, handshake: start.handshake, url: start.url });
        await watchAttempt(id, ticket, start);
    } catch (error) {
        if (live(id, ticket)) {
            put(id, { phase: `failed`, error: errorMessage(error) });
        }
    }
};

/** Stops waiting on a harness's attempt, and tells the computer to where it has one to stop. */
export const cancelHarness = (id: AgentProvider): void => {
    const attempt = harnessAttempts.value[id];
    tickets.delete(id);
    put(id, undefined);
    if (attempt?.phase === `waiting`) {
        void rpc().accounts.cancel({ provider: routed(id), handshake: attempt.handshake }).catch(cancelFailed);
    }
};
