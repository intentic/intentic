import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { classifyCommand, maskCredentialMaterial } from "@intentic/sandbox-contract";
import { type NamedSecret, secretReference, surfaceForms } from "../secrets/secret-registry.js";

/* MASKING WHAT THE AGENT READS, not only what it runs.
 *
 * bin/agent-output-filter masks the output of a Bash command, and for a long time that was the whole of it, so
 * whether a stored credential reached the model depended on HOW it was fetched. `cat` of a config file came
 * back masked; opening the same file with Read, matching it with Grep, or pulling it through an MCP tool did
 * not. The rule anyone would state out loud ("the model is never shown a credential this sandbox stores") was
 * true of one lane and not of the others, and nothing in the transcript distinguishes them.
 *
 * This closes it at the seam every lane shares. PostToolUse fires for every tool the model calls and
 * `updatedToolOutput` replaces the result before it is sent, so masking becomes a property of the
 * CONVERSATION rather than of the terminal.
 *
 * A value is masked TO ITS REFERENCE, `{{secret:name}}`, the same token the write path resolves back
 * (agent-secrets.ts), not to an anonymous blank. The blank destroyed information twice: the model could not
 * say WHICH credential it was looking at, and a config it read and faithfully rewrote came back with `***`
 * pasted over the real value, a silent credential loss. With the reference, a read and a rewrite round-trip:
 * what the model copies is a token the exits reconstitute.
 *
 * THE VALUES THIS SANDBOX HOLDS, ON EVERY RESULT, and nothing else on an ordinary one. Value masking replaces
 * strings this sandbox actually stores, so it cannot make the mistake the name heuristics make: those infer a
 * credential from the identifier beside it, and their whole failure history is on source code, `oauthToken ===
 * undefined` rewritten mid-comparison, a JSON body broken at `"cacheReadTokens":26170149`. A Read of a source
 * file is exactly the input they get wrong, and unlike a shell dump it is text the model has to reason about
 * precisely. So the floor is exact, and COMPLETE for what is stored, under any field name a connector invents.
 *
 * AND SHAPE MASKING WHERE THE CALL ITSELF NAMED A CREDENTIAL FILE (namesCredentialMaterial below), which is the
 * half the vault cannot reach: the project's own `.env`, a token a deploy minted an hour ago, whatever the
 * owner pasted into the repo this agent was pointed at. None of that is in the registry, so none of it was
 * masked anywhere, and it is most of what a read actually leaks. It is safe to be blunt there for the reason it
 * is not safe to be blunt everywhere: the pass runs on a file the command classifier already calls a credential
 * store, where a `key = value` IS the credential and there is no source code to mangle. The measured patterns
 * stay where they were measured; this is the other table (contract credential-material.ts), the one that
 * already defines what a credential file holds, run as a replacement instead of a question.
 *
 * Bash is covered here too, though its own filter already masks it: with cleaning switched off (the raw
 * baseline) that filter does not run at all, and this is then the only thing between a credential and the
 * transcript. Masking twice costs a scan and changes nothing.
 */

// Same floor as the terminal filter's value masking. A shorter string is not distinctive enough to blank on
// sight, masking an 8-character value would black out ordinary output that merely coincides with it.
const MIN_LENGTH = 12;
const LINE_MASK = "***";

export interface MaskTarget {
    readonly target: string;
    readonly replacement: string;
}

/* Each whole value is masked to its `{{secret:name}}` reference, in every SURFACE FORM it can arrive in
 * (secret-registry.ts surfaceForms), not only the raw one. A value that reached the reader JSON-escaped or
 * percent-encoded shares no run of text with the string this sandbox stores, so a raw-only comparison hands
 * it over intact; that is the ordinary shape of a credential inside a serialized payload or a URL.
 *
 * A credential that SPANS lines (an ssh private key, a WireGuard conf) may also arrive re-wrapped, with no
 * form of the whole surviving as one run, so its lines are registered as their own targets too, but to the
 * anonymous mask, not the reference: a reference stands for the WHOLE value, and stamping it on every line
 * would make the masked block resolve to N copies of the key.
 *
 * Longest first, so a value that contains another is masked whole rather than leaving its tail behind. */
export const maskTargets = (secrets: readonly NamedSecret[]): readonly MaskTarget[] => {
    const byTarget = new Map<string, MaskTarget>();
    const add = (target: string, replacement: string): void => {
        const trimmed = target.trim();
        if (trimmed.length >= MIN_LENGTH && !byTarget.has(trimmed)) {
            byTarget.set(trimmed, { target: trimmed, replacement });
        }
    };
    for (const { name, value } of secrets) {
        // Forms are derived from the TRIMMED value, which is the only form ever masked: encoding the padding
        // of a stored-with-whitespace value would register a target nothing can produce.
        for (const form of surfaceForms(value.trim())) {
            add(form, secretReference(name));
        }
        if (value.includes("\n")) {
            for (const line of value.split("\n")) {
                add(line, LINE_MASK);
            }
        }
    }
    return [...byTarget.values()].toSorted((a, b) => b.target.length - a.target.length);
};

/* WHICH STORED SECRETS THE FLOOR ABOVE LEAVES UNPROTECTED, by name, so the gap is something the owner is
 * told about rather than something they would have to infer from a transcript.
 *
 * MIN_LENGTH is not negotiable downward: masking a short value blacks out ordinary output that merely
 * coincides with it, and a mask that fires on prose is worse than no mask, which is the whole reason the floor
 * exists. But the consequence is easy to miss and reads exactly like protection: the vault takes any value it
 * is given, the Secrets page lists it beside the others, and a nine-character password is then simply never
 * masked. Long API tokens clear the floor and short human-chosen passwords do not, so the credentials most
 * likely to be reused across accounts are precisely the ones that reach the model intact.
 *
 * Names only, never values, this is read by things that log. */
export const unmaskableSecrets = (secrets: readonly NamedSecret[]): readonly string[] =>
    secrets
        .filter(({ value }) => value.trim().length < MIN_LENGTH)
        .map(({ name }) => name)
        .toSorted();

const maskString = (text: string, targets: readonly MaskTarget[]): string =>
    targets.reduce((masked, { target, replacement }) => (masked.includes(target) ? masked.split(target).join(replacement) : masked), text);

/* WAS THIS TOOL CALL AIMED AT A CREDENTIAL FILE? — the switch that turns on the second, shape-based pass
 * (contract credential-material.ts maskCredentialMaterial), and the reason that pass can be blunt.
 *
 * The floor above is complete for what this sandbox STORES and blind to everything else, which is most of what
 * a read actually leaks: the project's own `.env`, a token minted an hour ago, whatever the owner pasted into
 * the repo. Masking those means inferring a credential from its shape, and shape inference on ORDINARY output
 * is the thing this module's header refuses, with the measurements to back it (`oauthToken === undefined`
 * rewritten mid-comparison, a JSON body broken at `"cacheReadTokens":26170149`).
 *
 * So it is not run on ordinary output. It runs where the CALL ITSELF named credential material, judged by the
 * same classifier the command gate consults (sandbox-contract command-classes.ts), over the tool's own input:
 * `Read { file_path: "/work/app/.env" }`, `Bash { command: "cat ~/.npmrc" }`, a Grep through `~/.aws`. One
 * table decides what a credential file is, for the gate and for this, so a path the gate stops asking about is
 * exactly a path whose contents this blanks — that trade is the whole point (guard/actions.ts taint floor).
 *
 * The input rather than the OUTPUT, deliberately: judging the output would be shape inference on arbitrary
 * text by another name, and the input is small, structured, and says what was asked for.
 *
 * FIELD-CAPPED, because a Write's `content` is the whole file and a Read's `file_path` is forty characters:
 * every field that says WHAT WAS ASKED FOR is short, and serializing the one that says what was written would
 * put a megabyte through the classifier on every write. A field past the cap is dropped rather than truncated,
 * and a call whose only credential mention was in it is judged ordinary — this module's safe direction, since
 * the value floor still runs and nothing masked before stops being masked. */
const FIELD_MAX = 4096;

const namesCredentialMaterial = (toolInput: unknown): boolean => {
    try {
        const asked = JSON.stringify(toolInput, (_key, value: unknown) => (typeof value === "string" && value.length > FIELD_MAX ? "" : value));
        return asked !== undefined && classifyCommand(asked).includes("secrets.access");
    } catch {
        // A tool input that will not serialize (a circular structure a runtime handed us) is one this cannot
        // read, and an unreadable input is not evidence of a credential.
        return false;
    }
};

/* A tool result is JSON of a shape that belongs to the tool, a string for Bash, `{ file: { content } }` for
 * Read, a content array for an MCP server, so this walks it rather than knowing any of them. Keys are left
 * alone: a key is a field NAME, and blanking those would corrupt the structure without hiding a secret.
 *
 * Returns the SAME reference when nothing matched, which is how the hook tells "unchanged" from "rewritten"
 * without re-comparing a large result, and what keeps the overwhelmingly common case (no credential anywhere
 * in the output) from allocating a copy of it.
 */
const mapStrings = (value: unknown, transform: (text: string) => string): unknown => {
    if (typeof value === "string") {
        const mapped = transform(value);
        return mapped === value ? value : mapped;
    }
    if (Array.isArray(value)) {
        const items = value.map((item) => mapStrings(item, transform));
        return items.some((item, index) => item !== value[index]) ? items : value;
    }
    if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const entries = Object.entries(source).map(([key, item]) => [key, mapStrings(item, transform)] as const);
        return entries.some(([key, item]) => item !== source[key]) ? Object.fromEntries(entries) : value;
    }
    return value;
};

export const maskDeep = (value: unknown, targets: readonly MaskTarget[]): unknown => mapStrings(value, (text) => maskString(text, targets));

export const redactionHooks = (secrets: () => Promise<readonly NamedSecret[]>): Partial<Record<HookEvent, HookCallbackMatcher[]>> => ({
    /* No matcher, so every tool, including the ones nobody has written yet. A tool list here would be a list
     * of the tools somebody remembered, which is the exact shape of the gap this exists to close. */
    PostToolUse: [
        {
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PostToolUse") {
                        return {};
                    }
                    // Guarded whole: an unreadable vault is a reason to leave a result alone, never to fail the
                    // tool call that produced it.
                    try {
                        const targets = maskTargets(await secrets());
                        /* THE TWO PASSES, in this order and for a reason: the exact one first, so a stored
                         * value becomes its `{{secret:name}}` reference, and the shape one second, which then
                         * reads that reference as the deferred value it is and leaves it alone. Reversed, the
                         * shape pass would blank a stored credential to `***` before the floor above could give
                         * it back its name, and the round trip a reference exists for would be gone. */
                        const aimed = namesCredentialMaterial(input.tool_input);
                        if (targets.length === 0 && !aimed) {
                            return {};
                        }
                        const masked = mapStrings(input.tool_response, (text) => {
                            const valueMasked = maskString(text, targets);
                            return aimed ? maskCredentialMaterial(valueMasked) : valueMasked;
                        });
                        return masked === input.tool_response
                            ? {}
                            : { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: masked } };
                    } catch {
                        return {};
                    }
                },
            ],
        },
    ],
});
