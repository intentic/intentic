import { grantNonce } from "@intentic/sandbox-contract/keyring-seal";
import { rulesServe } from "@intentic/sandbox-contract/policy/keyring-origins";
import type { KeyringNeedResult, KeyringOrigin } from "@intentic/sandbox-contract/schemas/keyring";
import { type SandboxNeed, SandboxNeedSchema, type SecretWantResult } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { opt } from "../../opt.js";
import type { DevicePointer, KeyringComputer, KeyringLink, KeyringLogger } from "./keyring-link.js";

// AN AGENT ASKING BY NEED, NOT BY NAME (`secrets want --site github.com`, type_secret aimed at a page or a window): the
// need goes to the owner's computers with Passwords set up, most recently active first, each matching its own entries by
// origin and asking its person. The first yes wins, and that computer's shares are read at once so the name resolves on
// the very next use; a computer that parks the question in its Requests ("pending") ends the round, since the person has
// it in front of them there; when no computer has anything that fits, the one used last is asked again with its
// type-once box, so the person can type it there once. Every need this sandbox raised is kept here, and a pending one
// turns allowed by itself when a later read of that computer's shares lists an entry that serves its origin.

// id -> the need, as the hosted Passwords view lists it. Names, places and words only, never a value.
export const keyringNeedsDocument = defineDocument({ root: "auth", path: "keyring-needs.json", schema: SandboxNeedSchema, granularity: "record" });

// A long-lived sandbox raises needs for months; the oldest settled ones go first past this many.
const KEPT_MAX = 200;

export interface KeyringNeedStore {
    readonly all: () => Promise<readonly SandboxNeed[]>;
    readonly put: (need: SandboxNeed) => Promise<void>;
}

const trimmed = (needs: Readonly<Record<string, SandboxNeed>>) => {
    const rows = Object.values(needs);
    if (rows.length <= KEPT_MAX) {
        return { ...needs };
    }
    // Pending ones stay whatever their age: they are what the view's Requests and the badge count.
    const settled = rows.filter((need) => need.state !== "pending").toSorted((left, right) => left.at - right.at);
    const drop = new Set(settled.slice(0, rows.length - KEPT_MAX).map((need) => need.id));
    return Object.fromEntries(rows.filter((need) => !drop.has(need.id)).map((need) => [need.id, need]));
};

export const fileKeyringNeeds = (path: string): KeyringNeedStore => {
    const file = openDocument(keyringNeedsDocument, path, { fallback: (): Record<string, SandboxNeed> => ({}), mode: 0o600 });
    return {
        all: async () => Object.values(await file.read()).toSorted((left, right) => right.at - left.at),
        put: async (need) => {
            await file.update((current) => trimmed({ ...current, [need.id]: need }));
        },
    };
};

export const memoryKeyringNeeds = (): KeyringNeedStore => {
    const needs = new Map<string, SandboxNeed>();
    return {
        all: async () => [...needs.values()].toSorted((left, right) => right.at - left.at),
        put: async (need) => void needs.set(need.id, need),
    };
};

export interface NeedRequest {
    readonly origin: KeyringOrigin;
    readonly username?: string | undefined;
    readonly detail: string;
    readonly conversationId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
}

export interface KeyringNeedsDeps {
    readonly link: Pick<KeyringLink, "computers" | "passwords" | "pointers" | "onRefreshed">;
    readonly store: KeyringNeedStore;
    readonly logger: KeyringLogger;
    readonly now?: () => number;
}

export interface KeyringNeeds {
    readonly request: (need: NeedRequest) => Promise<SecretWantResult>;
    readonly all: () => Promise<readonly SandboxNeed[]>;
    readonly pending: () => Promise<readonly SandboxNeed[]>;
    // Looks again at the pending needs that wait on `machine`, against what its keyring shares now.
    readonly recheck: (machine: string) => Promise<void>;
    // Hears every shares read; answers its stop.
    readonly start: () => () => void;
}

// A pointer's rules as the origin test reads them. A pointer carries no askpass matchers, so an ssh, sudo or prompt need
// is seen allowed only by the keyring's own answer, never by a later read.
const pointerServes = ({ pointer }: Pick<DevicePointer, "pointer">, origin: KeyringOrigin): boolean =>
    rulesServe({ programs: pointer.programs, packages: pointer.packages, hosts: pointer.hosts, askpass: [] }, origin);

type Settled = { readonly result: SecretWantResult; readonly need: SandboxNeed };

// What one computer's answer makes of the need, or undefined to ask the next one.
const settle = (need: SandboxNeed, machine: string, answer: KeyringNeedResult): Settled | undefined => {
    if (answer.ok) {
        const name = answer.pointer.name;
        return {
            need: { ...need, machine, state: "allowed", name },
            result: { state: "allowed", name, machine, message: `Allowed on ${machine}: use the secret named ${name}.` },
        };
    }
    if (answer.code === "pending") {
        return {
            need: { ...need, machine, state: "pending" },
            result: { state: "pending", id: need.id, machine, message: `waiting for the owner's answer in Passwords on ${machine}` },
        };
    }
    if (answer.code === "declined") {
        return {
            need: { ...need, machine, state: "denied" },
            result: { state: "denied", message: `The owner said no on ${machine}: do not ask again, and do not look for another way to get it.` },
        };
    }
    return undefined;
};

const ask = async (deps: KeyringNeedsDeps, request: NeedRequest, machine: string, typeOnce: boolean): Promise<KeyringNeedResult> =>
    deps.link.passwords.need(
        machine,
        {
            origin: request.origin,
            ...opt("username", request.username),
            detail: request.detail.slice(0, 300),
            ...opt("conversation", request.conversationId?.slice(0, 200)),
            purpose: "agent",
            typeOnce,
        },
        request.signal,
    );

// The round over the computers that can be asked; the last refusal's words when none settled it.
const round = async (deps: KeyringNeedsDeps, request: NeedRequest, need: SandboxNeed, computers: readonly KeyringComputer[]): Promise<Settled | { readonly unsettled: string }> => {
    let last = "None of the owner's computers keeps a password for that place.";
    let allUnknown = true;
    for (const { machine } of computers) {
        const answer = await ask(deps, request, machine, false);
        const settled = settle(need, machine, answer);
        if (settled !== undefined) {
            return settled;
        }
        if (!answer.ok) {
            allUnknown &&= answer.code === "unknown";
            last = answer.refusal;
        }
    }
    const first = computers[0];
    if (!allUnknown || first === undefined) {
        return { unsettled: last };
    }
    // Nothing fits anywhere: the computer used last offers its type-once box, so the person can type it there.
    const answer = await ask(deps, request, first.machine, true);
    return settle(need, first.machine, answer) ?? { unsettled: answer.ok ? last : answer.refusal };
};

export const createKeyringNeeds = (deps: KeyringNeedsDeps): KeyringNeeds => {
    const now = deps.now ?? Date.now;
    const recheck = async (machine: string): Promise<void> => {
        const waiting = (await deps.store.all()).filter((need) => need.state === "pending" && need.machine === machine);
        if (waiting.length === 0) {
            return;
        }
        const shared = (await deps.link.pointers()).filter((entry) => entry.machine === machine);
        for (const need of waiting) {
            const found = shared.find((entry) => pointerServes(entry, need.origin));
            if (found !== undefined) {
                await deps.store.put({ ...need, state: "allowed", name: found.pointer.name });
            }
        }
    };
    return {
        request: async (request) => {
            const need: SandboxNeed = {
                id: grantNonce(),
                origin: request.origin,
                ...opt("username", request.username),
                detail: request.detail,
                ...opt("conversation", request.conversationId),
                state: "unknown",
                at: now(),
            };
            const computers = (await deps.link.computers()).filter((computer) => computer.online && computer.setUp);
            if (computers.length === 0) {
                await deps.store.put(need);
                return {
                    state: "unknown",
                    message: "None of the owner's computers with Passwords set up is online right now: carry on with what does not need it, and say what you left undone.",
                };
            }
            const outcome = await round(deps, request, need, computers);
            if ("unsettled" in outcome) {
                await deps.store.put(need);
                return { state: "unknown", message: `${outcome.unsettled} Carry on without it, and say what you left undone.` };
            }
            await deps.store.put(outcome.need);
            return outcome.result;
        },
        all: () => deps.store.all(),
        pending: async () => (await deps.store.all()).filter((need) => need.state === "pending"),
        recheck,
        start: () =>
            deps.link.onRefreshed((machine) => {
                void recheck(machine).catch((error: Error) => deps.logger.warn({ err: error, machine }, "keyring: the needs waiting on this computer could not be checked again"));
            }),
    };
};
