import { errorMessage } from "@intentic/base/errors";
// The one decision function every gated action consults; deciders are values minted by defineGuardedAction; guard fails
// closed both for a value that wasn't minted and for a decide that throws. Grant/approval semantics live at the consult
// site, not here: the verdict is recomputed live on every call.

export type GuardVerdict =
    { effect: "allow"; reason: string } | { effect: "hold"; reason: string; autoRunAfterS?: number } | { effect: "deny"; reason: string };

export const ALLOW = (reason: string): GuardVerdict => ({ effect: "allow", reason });
export const DENY = (reason: string): GuardVerdict => ({ effect: "deny", reason });
// Countdown hold, set only when holdForSeconds is the sole reason to hold; an ask-me hold must not get one.
export const HOLD = (reason: string, autoRunAfterS?: number): GuardVerdict => ({
    effect: "hold",
    reason,
    ...(autoRunAfterS !== undefined ? { autoRunAfterS } : {}),
});

export interface GuardedActionSpec<I> {
    // Dotted action name, e.g. "session.start"; the catalog key, refused on duplicates.
    readonly action: string;
    // The action's whole decision, run on every consult; pure, policy arrives in the input.
    readonly decide: (input: I) => GuardVerdict;
}

declare const guardedActionBrand: unique symbol;
// Only defineGuardedAction can mint one; the brand makes the type nominal, so a hand-rolled object fails both the
// typecheck and the runtime backstop.
export type GuardedAction<I> = Readonly<GuardedActionSpec<I>> & { readonly [guardedActionBrand]: true };

const defined = new Map<string, GuardedAction<never>>();
const minted = new WeakSet<object>();

export function defineGuardedAction<I>(spec: GuardedActionSpec<I>): GuardedAction<I> {
    if (defined.has(spec.action)) {
        throw new Error(`guarded action "${spec.action}" is already defined: action names are the catalog key`);
    }
    const def = Object.freeze({ ...spec }) as GuardedAction<I>;
    minted.add(def);
    defined.set(spec.action, def as GuardedAction<never>);
    return def;
}

// Runtime backstop for callers outside the type system; only minted values pass.
export function isGuardedAction(value: unknown): value is GuardedAction<unknown> {
    return typeof value === "object" && value !== null && minted.has(value);
}

// The catalog for the conformance test: every defined action name, sorted.
export function listGuardedActions(): string[] {
    return [...defined.keys()].toSorted((a, b) => a.localeCompare(b));
}

export function guard<I>(action: GuardedAction<I>, input: I): GuardVerdict {
    if (!isGuardedAction(action)) {
        // The branded type already forbids this; a hand-rolled decide fn was never vetted at definition.
        return DENY("guard consulted with an undefined action (failing closed)");
    }
    try {
        return action.decide(input);
    } catch (error) {
        return DENY(`guard failure (failing closed): ${errorMessage(error)}`);
    }
}
