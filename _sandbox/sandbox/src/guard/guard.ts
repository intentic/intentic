/* guard(), the one decision function every gated action consults.
 *
 * Two families pass through it today: session admission (may this wake start a session?, consulted by
 * fireAutomation for every outside-driven wake and by the workflow release gate) and the outbound sniffer
 * (may this in-turn provider call run?, consulted by the PreToolUse gate in guard/outbound-gate.ts). The
 * decisions themselves live in guard/actions.ts as the catalog; this file is the mechanism.
 *
 * The consult site holds the GuardedAction VALUE returned by defineGuardedAction, so the wiring between a
 * consult and its decide fn is a symbol reference the compiler checks, a dropped import or a typo'd name is a
 * build error, not a runtime fail-open. A value that did not come from defineGuardedAction is denied at
 * runtime (the WeakSet backstop below, for callers outside the type system), and a decide that throws denies:
 * the guard fails closed, both ways.
 *
 * GRANT SEMANTICS live at the consult site, not here: fireAutomation's `cleared` field is the grant, an
 * approved replay skips the HOLD it already answered, but the verdict is recomputed live on every fire, so a
 * DENY still refuses an approved replay. Approve-then-revoke does not execute.
 */

export type GuardVerdict =
    { effect: "allow"; reason: string } | { effect: "hold"; reason: string; autoRunAfterS?: number } | { effect: "deny"; reason: string };

export const ALLOW = (reason: string): GuardVerdict => ({ effect: "allow", reason });
export const DENY = (reason: string): GuardVerdict => ({ effect: "deny", reason });
// autoRunAfterS: the countdown hold, the daemon may run the wake itself once this many seconds pass
// unanswered. Only a decide whose SOLE reason to hold is the automation's own `holdForSeconds` sets it:
// "ask me" (requireApproval, or the admission floor) must never become "unless I'm slow".
export const HOLD = (reason: string, autoRunAfterS?: number): GuardVerdict => ({
    effect: "hold",
    reason,
    ...(autoRunAfterS !== undefined ? { autoRunAfterS } : {}),
});

export interface GuardedActionSpec<I> {
    // Dotted action name, e.g. "session.start", "outbound.send", the catalog key, refused on duplicates.
    readonly action: string;
    // The action's whole decision, run on every consult. Pure: policy arrives in the input, IO stays outside.
    readonly decide: (input: I) => GuardVerdict;
}

declare const guardedActionBrand: unique symbol;
// Only defineGuardedAction can mint one, the brand makes the type nominal, so a hand-rolled
// { action, decide } object does not typecheck at a consult site, and fails the runtime backstop too.
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

// Runtime backstop for callers outside the type system (plain JS, casts): only minted values pass.
export function isGuardedAction(value: unknown): value is GuardedAction<unknown> {
    return typeof value === "object" && value !== null && minted.has(value);
}

// The catalog, for the conformance test, every defined action name, sorted.
export function listGuardedActions(): string[] {
    return [...defined.keys()].toSorted((a, b) => a.localeCompare(b));
}

export function guard<I>(action: GuardedAction<I>, input: I): GuardVerdict {
    if (!isGuardedAction(action)) {
        // The branded type already forbids this, a hand-rolled object must not carry a decide fn that was
        // never vetted at definition time.
        return DENY("guard consulted with an undefined action (failing closed)");
    }
    try {
        return action.decide(input);
    } catch (error) {
        return DENY(`guard failure (failing closed): ${error instanceof Error ? error.message : String(error)}`);
    }
}
