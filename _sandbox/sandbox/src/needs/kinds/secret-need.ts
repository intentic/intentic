import type { Need, NeedAsk, NeedSubject, SecretNeed } from "@intentic/sandbox-contract";
import type { NamedSecret } from "../../secrets/secret-registry.js";
import type { AskContext, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

// A secret's value the agent needs (docs/architecture/needs.md). The agent names it and says where it will go; a person
// pastes the value into the card, and it goes straight to the store the reference resolves from. The value never
// travels through a need, a transcript, or anything the agent can read: it is written, then referred to by name.

export interface SecretNeedDeps {
    readonly registry: () => Promise<readonly NamedSecret[]>;
    // Stores a value under a name where `{{secret:NAME}}` resolves it: where that name already lives, else the sandbox's
    // own store.
    readonly keep: (name: string, value: string) => Promise<void>;
}

// How the agent spends it, honestly per runtime: only the Claude Code loop fills a reference in at execution.
const useOf = (name: string, context: Pick<AskContext, "standing"> | undefined): string[] =>
    context?.standing !== undefined && context.standing.secrets !== "masked"
        ? [`This conversation's runtime does not fill in {{secret:…}} references, so the value is there for a Claude Code turn and for connections that read it, not for this shell.`]
        : [`Write {{secret:${name}}} where the value goes (a command, a header, an env assignment): the sandbox fills it in at execution, and it never appears in what you read.`];

const titleOf = (subject: SecretNeed): string => (subject.replace === true ? `A new value for ${subject.name}` : `The ${subject.name} secret`);

export const secretNeed = (deps: SecretNeedDeps): NeedKindHandler & { readonly provide: (need: Need, value: string) => Promise<Met> } => {
    const stored = async (name: string): Promise<boolean> => (await deps.registry()).some((secret) => secret.name === name);

    const resolve = async (ask: NeedAsk, context: AskContext): Promise<Resolved> => {
        if (ask.kind !== "secret") {
            return { kind: "refused", code: "invalid", message: "Not a secret ask." };
        }
        if (ask.replace !== true && (await stored(ask.name))) {
            return {
                kind: "met",
                message: [
                    `${ask.name} is already stored.`,
                    ...useOf(ask.name, context),
                    "If the service refuses it, ask again with --replace.",
                ].join(" "),
            };
        }
        const subject: SecretNeed = {
            kind: "secret",
            name: ask.name,
            ...(ask.where === undefined ? {} : { where: ask.where }),
            ...(ask.link === undefined ? {} : { link: ask.link }),
            ...(ask.hint === undefined ? {} : { hint: ask.hint }),
            ...(ask.replace === true ? { replace: true } : {}),
        };
        return { kind: "raise", subject, title: titleOf(subject) };
    };

    const subjectOf = (need: Need): SecretNeed | undefined => (need.subject.kind === "secret" ? need.subject : undefined);

    return {
        resolve,
        // A replacement is met only by a value given for it: the old one existing is exactly what was wrong.
        check: async (need) => {
            const subject = subjectOf(need);
            if (subject === undefined || subject.replace === true || !(await stored(subject.name))) {
                return undefined;
            }
            return { result: `${subject.name} is stored.`, use: useOf(subject.name, undefined) };
        },
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined) {
                return { refused: "Not a secret need." };
            }
            if (answer.kind === "accept") {
                return { status: "working" };
            }
            // Stored some other way (the Secrets view, a deploy): the person says so, and the store has to agree.
            if (answer.kind === "apply" && (await stored(subject.name))) {
                return { status: "met", result: `${subject.name} is stored.`, use: useOf(subject.name, undefined) };
            }
            return { refused: `${subject.name} is not stored yet: paste its value into the card, or add it on the Secrets view.` };
        },
        provide: async (need, value) => {
            const subject = subjectOf(need);
            if (subject === undefined) {
                throw new Error("Not a secret need.");
            }
            await deps.keep(subject.name, value);
            return { result: `${subject.name} is stored${subject.replace === true ? ", in place of the value that was refused" : ""}.`, use: useOf(subject.name, undefined) };
        },
        nextTurn: () => false,
        key: (subject: NeedSubject) => (subject.kind === "secret" ? subject.name : ""),
    };
};
