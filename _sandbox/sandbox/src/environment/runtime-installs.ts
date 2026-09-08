import {
    type EnvironmentDrift,
    type RuntimeInstall,
    type RuntimeInstallKind,
    type RuntimeInstallsFile,
    RuntimeInstallsFileSchema,
} from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";

// Ledger of tools installed into the container at runtime, written by the harness (the install-steering hook), not the
// model. Lives under /work so it survives container recreates; recurrence counts per session, not per command. Carries
// the drift snapshot too, machine-scoped where the ledger is workspace-scoped.

// Distinct sessions kept per tool; recurrence needs ≥ 2, and eight is enough to call it constant.
const SESSIONS_KEPT = 8;
// Recent commands kept per tool, for the draft's comment only.
const COMMANDS_KEPT = 3;
const COMMAND_MAX_LENGTH = 240;
// Max tools kept; the oldest entry is evicted past this, bounding a runaway classifier.
const TOOLS_KEPT = 200;

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
    const file = jsonFile<RuntimeInstallsFile>(path, {
        parse: (raw) => RuntimeInstallsFileSchema.safeParse(raw).data,
        fallback: () => ({ installs: [] }),
    });
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
    };
};
