import { type CapabilityCatalogEntry, instancesOf } from "@intentic/capability-catalog";
import type { Capability, CapabilityNeed, CapabilityStatus, CredentialGate, Need, NeedAsk, NeedSubject } from "@intentic/sandbox-contract";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// A connection the agent needs (docs/architecture/needs.md): answered for the asking turn, not for the sandbox. The
// three answers that used to come back as "already connected, use it" are each told apart here: a connection for a
// different site, one this turn's persona or a gate withholds, and one whose credential is being refused.

export interface CapabilityNeedDeps {
    // Every connectable entry: the static catalog merged with enabled extensions' contributions.
    readonly entries: () => Promise<readonly CapabilityCatalogEntry[]>;
    readonly capabilities: () => Promise<readonly Capability[]>;
    readonly status: (capability: Capability) => Promise<CapabilityStatus>;
    readonly gates: () => Promise<readonly CredentialGate[]>;
    // What this turn can do with a cli connection before its variables and skill load on the next turn: each variable
    // assigned from its credential's reference, which the sandbox substitutes at execution. Empty for any other kind.
    readonly usableNow: (capability: Capability) => Promise<readonly string[]>;
}

// The fields a target lands in, most specific first, and the ones that take an address rather than a bare host.
const TARGET_FIELDS = ["homeUrl", "url", "baseUrl", "endpoint", "loginUrl", "host", "domain", "site", "server", "address"] as const;
const ADDRESS_FIELDS = new Set(["homeUrl", "url", "baseUrl", "endpoint", "loginUrl"]);

// A host a person or an agent would write, reduced to what a stored setting would hold: no scheme, path, port or www.
export const hostOf = (value: string): string =>
    value
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/^[^@/]*@/, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
        .replace(/^www\./, "");

// Whether a connection is for the target: any of its settings names the target's host, or a host the target is a
// subdomain of, or one that is a subdomain of it.
export const servesTarget = (capability: Capability, target: string): boolean => {
    const wanted = hostOf(target);
    if (wanted === "") {
        return true;
    }
    return Object.values(capability.config).some((value) => {
        if (typeof value !== "string" || value === "") {
            return false;
        }
        const held = hostOf(value);
        return held === wanted || held.endsWith(`.${wanted}`) || wanted.endsWith(`.${held}`);
    });
};

// One setting of a connection as a form would hold it; each kind's config is its own shape, read here by key.
const settingOf = (capability: Capability, key: string): string => {
    const value = Object.entries(capability.config).find(([name]) => name === key)?.[1];
    return value === undefined || value === null ? "" : String(value);
};

// The entry's own fields an agent may fill: never a secret, never a pinned discriminator.
const fillable = (entry: CapabilityCatalogEntry): ReadonlySet<string> =>
    new Set(entry.fields.filter((field) => field.secret !== true && field.value === undefined).map((field) => field.key));

const secretKeys = (entry: CapabilityCatalogEntry): ReadonlySet<string> =>
    new Set(entry.fields.filter((field) => field.secret === true).map((field) => field.key));

// Where a new connection's target goes: the first address-shaped field the entry has, holding an address, else a host.
const targetFill = (entry: CapabilityCatalogEntry, target: string): Record<string, string> => {
    const keys = fillable(entry);
    const field = TARGET_FIELDS.find((key) => keys.has(key));
    if (field === undefined) {
        return {};
    }
    const bare = target.trim();
    return { [field]: ADDRESS_FIELDS.has(field) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(bare) ? `https://${hostOf(bare)}` : bare };
};

const titleOf = (subject: CapabilityNeed): string => {
    switch (subject.mode) {
        case "connect":
            return subject.target === undefined ? `Connect ${subject.name}` : `Connect ${subject.name} for ${hostOf(subject.target)}`;
        case "reconnect":
            return `Reconnect ${subject.name} ("${subject.instance ?? subject.entry}")`;
        case "change":
            return `Change ${subject.name} ("${subject.instance ?? subject.entry}")`;
    }
};

const raise = (subject: CapabilityNeed): Resolved => ({ kind: "raise", subject, title: titleOf(subject) });

const refused = (code: string, message: string): Resolved => ({ kind: "refused", code, message });

// The kinds whose connection a turn mounts at its start, so a later grant or connection reaches only the next turn.
const MOUNTED = new Set(["browser", "identity", "device", "webext", "mcp", "agent", "plugin"]);

export const capabilityNeed = (deps: CapabilityNeedDeps): NeedKindHandler => {
    const entryFor = async (asked: string): Promise<{ entry: CapabilityCatalogEntry; instance?: Capability } | undefined> => {
        const entries = await deps.entries();
        const entry = entries.find((candidate) => candidate.id === asked);
        if (entry !== undefined) {
            return { entry };
        }
        // An instance's own id: the entry it was made from is whichever catalog entry claims it.
        const instance = (await deps.capabilities()).find((capability) => capability.id === asked);
        if (instance === undefined) {
            return undefined;
        }
        const owner = entries.find((candidate) => instancesOf(candidate, [instance]).length > 0);
        return owner === undefined ? undefined : { entry: owner, instance };
    };

    // What a connected, working capability means for the asking turn.
    const reachFor = async (capability: Capability, entry: CapabilityCatalogEntry, context: AskContext): Promise<Resolved> => {
        const { standing } = context;
        if (standing !== undefined && standing.withheldByGate.includes(capability.id)) {
            const gate = (await deps.gates()).find((entry2) => entry2.subject === capability.id);
            if (gate?.scope === "use") {
                return refused(
                    "gated_per_use",
                    `${entry.name} is connected as "${capability.id}" and released one use at a time by ${gate.approvers.join(" or ")}: use it, and the approval card goes up for that one use.`,
                );
            }
            return {
                kind: "raise",
                subject: { kind: "release", subject: capability.id, approvers: gate?.approvers ?? [] },
                title: `Release "${capability.id}" to this conversation`,
            };
        }
        if (standing !== undefined && standing.withheldByPersona.includes(capability.id)) {
            return {
                kind: "raise",
                subject: {
                    kind: "grant",
                    subject: "capability",
                    what: capability.id,
                    label: `"${capability.id}" (${entry.name})`,
                    ...(standing.persona === undefined ? {} : { persona: standing.persona.name }),
                },
                title: `Let this conversation use "${capability.id}"`,
            };
        }
        const now = await deps.usableNow(capability);
        if (standing === undefined || standing.granted.includes(capability.id)) {
            return {
                kind: "met",
                message: `${entry.name} is connected as "${capability.id}" and this turn has it: use it. If its credential is being refused, ask again with --reconnect.`,
            };
        }
        // Connected after this turn started: nothing mounted it yet.
        return {
            kind: "met",
            message: [
                `${entry.name} is connected as "${capability.id}", after this turn started, so its tools and skill load on your next turn.`,
                ...(now.length > 0 ? [`In this turn, set its variables from their references, which the sandbox fills in at execution: ${now.join(" ")}`] : []),
                ...(MOUNTED.has(capability.kind) ? ["Finish what you can and end this turn: nothing mounts it mid-turn."] : []),
            ].join(" "),
        };
    };

    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "capability") {
            return refused("invalid", "Not a capability ask.");
        }
        const found = await entryFor(ask.entry);
        if (found === undefined) {
            return refused("unknown_capability", `No catalog entry or connection is named "${ask.entry}": \`capabilities list\` names what exists.`);
        }
        const { entry } = found;
        const set = ask.set ?? {};
        const secrets = secretKeys(entry);
        const credential = Object.keys(set).find((key) => secrets.has(key));
        if (credential !== undefined) {
            return refused(
                "credential_field",
                `"${credential}" is ${entry.name}'s credential, which only a person types, on the card. Leave it out: the card asks them for it.`,
            );
        }
        const keys = fillable(entry);
        const unknown = Object.keys(set).filter((key) => !keys.has(key));
        if (unknown.length > 0) {
            return refused(
                "unknown_field",
                `${entry.name} has no setting named ${unknown.map((key) => `"${key}"`).join(", ")}. Its settings: ${[...keys].join(", ") || "none"}.`,
            );
        }
        const all = instancesOf(entry, await deps.capabilities());
        const matching = found.instance !== undefined ? [found.instance] : ask.target === undefined ? all : all.filter((capability) => servesTarget(capability, ask.target ?? ""));
        const statuses = await Promise.all(matching.map(async (capability) => ({ capability, status: await deps.status(capability) })));
        const live = statuses.find(({ status }) => status.state === "active");
        const connected = live ?? statuses[0];
        if (connected !== undefined && Object.keys(set).length > 0) {
            const changes = Object.fromEntries(Object.entries(set).filter(([key, value]) => settingOf(connected.capability, key) !== value));
            if (Object.keys(changes).length === 0) {
                return reachFor(connected.capability, entry, context);
            }
            return raise({ kind: "capability", entry: entry.id, name: entry.name, mode: "change", instance: connected.capability.id, changes });
        }
        if (live !== undefined && ask.reconnect !== true) {
            return reachFor(live.capability, entry, context);
        }
        if (connected !== undefined) {
            // Connected but not working (or said to be refusing): a new credential, not a second connection.
            const reported = ask.reconnect === true && live !== undefined;
            const reason = reported ? "The agent says its credential is being refused, though the connection still answers." : connected.status.detail;
            return raise({
                kind: "capability",
                entry: entry.id,
                name: entry.name,
                mode: "reconnect",
                instance: connected.capability.id,
                ...(ask.target === undefined ? {} : { target: ask.target }),
                ...(reason === undefined ? {} : { reason }),
                ...(reported ? { reported: true } : {}),
            });
        }
        const prefill = { ...(ask.target === undefined ? {} : targetFill(entry, ask.target)), ...set };
        return raise({
            kind: "capability",
            entry: entry.id,
            name: entry.name,
            mode: "connect",
            ...(ask.target === undefined ? {} : { target: ask.target }),
            ...(Object.keys(prefill).length === 0 ? {} : { prefill }),
            ...(all.length > 0 && ask.target !== undefined
                ? { reason: `${all.map((capability) => `"${capability.id}"`).join(", ")} ${all.length === 1 ? "is" : "are"} connected, but not for ${hostOf(ask.target)}.` }
                : {}),
        });
    };

    const subjectOf = (need: Need): CapabilityNeed | undefined => (need.subject.kind === "capability" ? need.subject : undefined);

    const check = async (need: Need): Promise<Met | undefined> => {
        const subject = subjectOf(need);
        if (subject === undefined) {
            return undefined;
        }
        const entry = (await deps.entries()).find((candidate) => candidate.id === subject.entry);
        if (entry === undefined) {
            return undefined;
        }
        const all = instancesOf(entry, await deps.capabilities());
        if (subject.mode === "change") {
            const instance = all.find((capability) => capability.id === subject.instance);
            const applied =
                instance !== undefined && Object.entries(subject.changes ?? {}).every(([key, value]) => settingOf(instance, key) === value);
            return applied && instance !== undefined ? { result: `${entry.name} "${instance.id}" now has the change applied.`, use: [] } : undefined;
        }
        const candidates =
            subject.mode === "reconnect"
                ? all.filter((capability) => capability.id === subject.instance)
                : all.filter((capability) => subject.target === undefined || servesTarget(capability, subject.target));
        for (const capability of candidates) {
            if ((await deps.status(capability)).state !== "active") {
                continue;
            }
            // A reconnect whose connection never stopped probing active is met by the person's own word (answer), not by
            // a probe that could not see the refusal in the first place.
            if (subject.mode === "reconnect" && subject.reported === true) {
                return undefined;
            }
            const now = await deps.usableNow(capability);
            return {
                result: `${entry.name} is connected as "${capability.id}".`,
                use: [
                    ...(now.length > 0 ? [`To use it before your next turn, set its variables from their references: ${now.join(" ")}`] : []),
                    "From your next turn its tools, variables and skill load by themselves.",
                ],
            };
        }
        return undefined;
    };

    return {
        resolve,
        check,
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined) {
                return { refused: "Not a capability need." };
            }
            if (answer.kind === "accept") {
                return { status: "working" };
            }
            if (answer.kind !== "apply") {
                return { refused: "A capability need is answered by setting it up, or declined." };
            }
            // The person says it is done: a working connection meets it, a reconnect included.
            const entry = (await deps.entries()).find((candidate) => candidate.id === subject.entry);
            const instance = entry === undefined ? undefined : instancesOf(entry, await deps.capabilities()).find((capability) => subject.instance === undefined ? subject.target === undefined || servesTarget(capability, subject.target) : capability.id === subject.instance);
            if (instance === undefined || (await deps.status(instance)).state !== "active") {
                return { refused: `${subject.name} is not working yet: finish its setup first, then press again.` };
            }
            const { reported: _reported, ...vouched } = subject;
            const met = await check({ ...need, subject: vouched });
            return { status: "met", ...(met ?? { result: `${subject.name} is connected as "${instance.id}".`, use: [] }) };
        },
        nextTurn: (need) => {
            const subject = subjectOf(need);
            return subject !== undefined && subject.mode !== "change";
        },
        key: (subject: NeedSubject) =>
            subject.kind === "capability" ? [subject.entry, subject.mode, subject.instance ?? "", hostOf(subject.target ?? "")].join("|") : "",
    };
};
