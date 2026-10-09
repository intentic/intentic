import {
    type EnvironmentComposition,
    type EnvironmentDrift,
    type EnvironmentOffer,
    type RuntimeInstall,
    type RuntimeInstallKind,
    type RuntimeInstallsFile,
    RuntimeInstallsFileSchema,
} from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Ledger of tools installed into the container at runtime, written by the harness (the install-steering hook), not the
// model. Lives under /work so it survives container recreates; recurrence counts per session, not per command. Carries
// the drift snapshot too, machine-scoped where the ledger is workspace-scoped.

export const runtimeInstallsDocument = defineDocument({
    path: stateRelPath(".intentic/records/runtime-installs.json"),
    schema: RuntimeInstallsFileSchema,
});

// Distinct sessions kept per tool; recurrence needs ≥ 2, and eight is enough to call it constant.
const SESSIONS_KEPT = 8;
// Recent commands kept per tool, for the draft's comment only.
const COMMANDS_KEPT = 3;
const COMMAND_MAX_LENGTH = 240;
// Max tools kept; the oldest entry is evicted past this, bounding a runaway classifier.
const TOOLS_KEPT = 200;
// Answered drafts remembered; the oldest is forgotten past this, far more than one workspace's tools.
const SETTLED_KEPT = 200;
// Composed overlays remembered. A container is built from one of the last few; forty covers a long run of approvals and
// capability changes between two rebuilds without the ledger growing with every compose.
const COMPOSITIONS_KEPT = 40;
// Daemon-written drafts awaiting an answer; one per tool at most, so this is a ceiling, not a working size.
const OFFERS_KEPT = 200;

export interface ClassifiedInstall {
    readonly tool: string;
    readonly kind: RuntimeInstallKind;
}

export interface RuntimeInstallsStore {
    readonly read: () => Promise<RuntimeInstallsFile>;
    // Merges one command's installs by (kind, tool); a missing `session` still records but can't add recurrence.
    readonly record: (installs: readonly ClassifiedInstall[], command: string, session: string | undefined, at: number) => Promise<void>;
    readonly saveDrift: (drift: EnvironmentDrift) => Promise<void>;
    // Tombstones tools the owner declined so the sweep won't redraft them. `at: undefined` clears the tombstone: a
    // dismiss that can't be undone is a dismiss nobody presses.
    readonly decline: (tools: readonly string[], at: number | undefined) => Promise<void>;
    // Remembers drafts the owner answered, by tool and the hash of their steps, so a copy an agent's land brings back
    // proposes nothing; `unsettle` forgets one, for an agent asking for exactly those steps again on purpose.
    readonly settle: (drafts: readonly { readonly tool: string; readonly hash: string }[], at: number) => Promise<void>;
    readonly unsettle: (tool: string, hash: string) => Promise<void>;
    // Remembers one composed overlay (environment.ts composeEnvironment), so the overlay a container was built from can
    // be read back by its hash after newer ones replaced it on disk. The same hash again keeps its first record.
    readonly recordComposition: (composition: EnvironmentComposition) => Promise<void>;
    // Remembers drafts the daemon wrote on its own, until they are answered or thrown away (drift-sweep.ts).
    readonly offer: (offers: readonly EnvironmentOffer[]) => Promise<void>;
    // Forgets offers by tool and hash: answered, superseded, or read as a no.
    readonly withdrawOffers: (offers: readonly { readonly tool: string; readonly hash: string }[]) => Promise<void>;
}

const keyOf = (install: { readonly kind: RuntimeInstallKind; readonly tool: string }): string => `${install.kind}:${install.tool}`;

const merged = (
    current: RuntimeInstall | undefined,
    install: ClassifiedInstall,
    command: string,
    session: string | undefined,
    at: number,
): RuntimeInstall => {
    const trimmed = command.length > COMMAND_MAX_LENGTH ? `${command.slice(0, COMMAND_MAX_LENGTH)}…` : command;
    if (current === undefined) {
        return {
            tool: install.tool,
            kind: install.kind,
            sessions: session === undefined ? [] : [session],
            commands: [trimmed],
            firstAt: at,
            lastAt: at,
            count: 1,
        };
    }
    const sessions =
        session === undefined || current.sessions.includes(session) ? current.sessions : [...current.sessions, session].slice(-SESSIONS_KEPT);
    const commands = current.commands.includes(trimmed) ? current.commands : [...current.commands, trimmed].slice(-COMMANDS_KEPT);
    return { ...current, sessions, commands, lastAt: at, count: current.count + 1 };
};

export const fileRuntimeInstallsStore = (path: string): RuntimeInstallsStore => {
    const file = openDocument(runtimeInstallsDocument, path, { fallback: (): RuntimeInstallsFile => ({ installs: [] }) });
    return {
        read: file.read,
        record: async (installs, command, session, at) => {
            if (installs.length === 0) {
                return;
            }
            await file.update((current) => {
                const byKey = new Map(current.installs.map((entry) => [keyOf(entry), entry]));
                for (const install of installs) {
                    byKey.set(keyOf(install), merged(byKey.get(keyOf(install)), install, command, session, at));
                }
                const entries = [...byKey.values()].toSorted((left, right) => right.lastAt - left.lastAt).slice(0, TOOLS_KEPT);
                return { ...current, installs: entries };
            });
        },
        saveDrift: async (drift) => {
            await file.update((current) => ({ ...current, drift }));
        },
        decline: async (tools, at) => {
            if (tools.length === 0) {
                return;
            }
            const names = new Set(tools);
            await file.update((current) => ({
                ...current,
                installs: current.installs.map((entry) => {
                    if (!names.has(entry.tool)) {
                        return entry;
                    }
                    if (at === undefined) {
                        const { declinedAt: _cleared, ...rest } = entry;
                        return rest;
                    }
                    return { ...entry, declinedAt: at };
                }),
            }));
        },
        settle: async (drafts, at) => {
            if (drafts.length === 0) {
                return;
            }
            const keys = new Set(drafts.map((draft) => `${draft.tool}\u0000${draft.hash}`));
            await file.update((current) => {
                const kept = (current.settled ?? []).filter((entry) => !keys.has(`${entry.tool}\u0000${entry.hash}`));
                const added = [
                    ...new Map(drafts.map((draft) => [`${draft.tool}\u0000${draft.hash}`, { tool: draft.tool, hash: draft.hash, at }])).values(),
                ];
                return { ...current, settled: [...kept, ...added].slice(-SETTLED_KEPT) };
            });
        },
        unsettle: async (tool, hash) => {
            const answered = (entry: { readonly tool: string; readonly hash: string }): boolean => entry.tool === tool && entry.hash === hash;
            if (!((await file.read()).settled ?? []).some(answered)) {
                return;
            }
            await file.update((current) => ({ ...current, settled: (current.settled ?? []).filter((entry) => !answered(entry)) }));
        },
        recordComposition: async (composition) => {
            if ((await file.read()).compositions?.some((entry) => entry.hash === composition.hash) === true) {
                return;
            }
            await file.update((current) => {
                const kept = current.compositions ?? [];
                return kept.some((entry) => entry.hash === composition.hash)
                    ? current
                    : { ...current, compositions: [...kept, composition].slice(-COMPOSITIONS_KEPT) };
            });
        },
        offer: async (offers) => {
            if (offers.length === 0) {
                return;
            }
            const keys = new Set(offers.map((offer) => `${offer.tool}\u0000${offer.hash}`));
            await file.update((current) => {
                const kept = (current.offered ?? []).filter((entry) => !keys.has(`${entry.tool}\u0000${entry.hash}`));
                return { ...current, offered: [...kept, ...offers].slice(-OFFERS_KEPT) };
            });
        },
        withdrawOffers: async (offers) => {
            if (offers.length === 0) {
                return;
            }
            const keys = new Set(offers.map((offer) => `${offer.tool}\u0000${offer.hash}`));
            await file.update((current) => ({ ...current, offered: (current.offered ?? []).filter((entry) => !keys.has(`${entry.tool}\u0000${entry.hash}`)) }));
        },
    };
};
