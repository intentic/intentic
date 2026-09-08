import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { classifyCommand, maskCredentialMaterial } from "@intentic/sandbox-contract";
import { type NamedSecret, secretReference, surfaceForms } from "../../secrets/secret-registry.js";

// Masks every tool's PostToolUse output, not just Bash's, closing the gap where masking depended on how a value was
// fetched. Values mask to `{{secret:name}}`, not a blank, so a read-then-rewrite round-trips. A second, shape-based
// pass covers credential files the vault never stored, judged by the call's own input.

// Same floor as the terminal filter: below this a value isn't distinctive enough to blank safely.
const MIN_LENGTH = 12;
const LINE_MASK = "***";

export interface MaskTarget {
    readonly target: string;
    readonly replacement: string;
}

// Masks to the reference in every surface form (escaped, encoded), not just raw. A multi-line credential's lines are
// also registered, but to the anonymous mask, since the reference would otherwise resolve to N copies. Longest first.
export const maskTargets = (secrets: readonly NamedSecret[]): readonly MaskTarget[] => {
    const byTarget = new Map<string, MaskTarget>();
    const add = (target: string, replacement: string): void => {
        const trimmed = target.trim();
        if (trimmed.length >= MIN_LENGTH && !byTarget.has(trimmed)) {
            byTarget.set(trimmed, { target: trimmed, replacement });
        }
    };
    for (const { name, value } of secrets) {
        // Derived from the trimmed value only, since encoding stored padding would register a target nothing produces.
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

// Names which stored secrets the length floor leaves unmasked, since lowering it would blank ordinary output that
// merely coincides with a short value. Names only, never values, since this is read by things that log.
export const unmaskableSecrets = (secrets: readonly NamedSecret[]): readonly string[] =>
    secrets
        .filter(({ value }) => value.trim().length < MIN_LENGTH)
        .map(({ name }) => name)
        .toSorted();

const maskString = (text: string, targets: readonly MaskTarget[]): string =>
    targets.reduce((masked, { target, replacement }) => (masked.includes(target) ? masked.split(target).join(replacement) : masked), text);

// Gates the shape pass on the call's input, via the same classifier the command gate uses, not the output (shape
// inference on arbitrary text). An oversized field drops rather than truncates, read as ordinary.
const FIELD_MAX = 4096;

const namesCredentialMaterial = (toolInput: unknown): boolean => {
    try {
        const asked = JSON.stringify(toolInput, (_key, value: unknown) => (typeof value === "string" && value.length > FIELD_MAX ? "" : value));
        // Locus is required by the classifier but changes nothing here: this is about a path, not a machine.
        return asked !== undefined && classifyCommand(asked, { locus: "sandbox" }).includes("secrets.access");
    } catch {
        // An input that won't serialize can't be read, and an unreadable input isn't evidence of a credential.
        return false;
    }
};

// Walks a result generically since its shape belongs to the tool (a string, `{file:{content}}`, an MCP array). Keys are
// left alone; returns the same reference when nothing matched, avoiding a copy on the common no-op case.
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
    // No matcher: covers every tool, including ones nobody has written yet, rather than a remembered list.
    PostToolUse: [
        {
            hooks: [
                async (input) => {
                    if (input.hook_event_name !== "PostToolUse") {
                        return {};
                    }
                    // Guarded whole: an unreadable vault is a reason to leave a result alone, never to fail the tool
                    // call.
                    try {
                        const targets = maskTargets(await secrets());
                        // Exact pass first, so a stored value becomes its reference before the shape pass runs;
                        // reversed, the shape pass would blank a stored credential to `***` before it could keep its
                        // name.
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
