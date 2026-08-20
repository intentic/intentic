/* What a gated e2e suite needs from the world before it is allowed to run, and what it reports when the world
 * does not have it. The companion to `./vitest.ts`: that file decides how long a suite may take, this one
 * decides whether it runs at all.
 *
 * It exists because each suite spelled the same two questions its own way, and one of them spelled it wrong.
 * `cli.e2e.test.ts` asked the opt-in switch in `describe.skipIf` but read its Cloudflare token through a local
 * helper that THREW on an unset variable, so the nightly, which sets the switch for every tier at once, went
 * red on the tier it had deliberately been given no credentials for. A suite that cannot reach its service has
 * nothing to say; it must stand down, not fail. Deciding both questions in one place is what makes that the
 * only possible outcome.
 *
 * The two kinds of requirement are named apart on purpose, because they come from different people:
 *
 *   `enabledBy`, the opt-in switch, set by the package's own `e2e` script. It says gated e2e was ASKED for,
 *                 which is why a plain `pnpm test` runs none of this.
 *   `secrets`  , the credentials, set by an operator or by CI. They say what the tier can actually reach.
 *
 * A skip is never silent: when the switch is on and a secret is missing, the tier says which one in its own
 * title, and vitest prints that beside the `↓`. So a nightly's log already states which tiers ran and which
 * stood down, without a suite adding a line to make it so.
 *
 * What this does NOT gate is a Docker daemon, which every tier here needs. No variable announces one, probing
 * would make this async, and CI answers it structurally instead, the e2e jobs extend `.dind`.
 */

// The switch spellings an operator writes. Only these: an `INTENTIC_E2E=0` left in a shell is an instruction to
// stay off, and "non-empty" would read it as an instruction to run.
const asked = (key: string): boolean => process.env[key] === "1" || process.env[key] === "true";

// A credential counts when it carries something. CI defines a variable it has no value for as the empty string,
// so `undefined` alone would let a tier start and then fail against the service with an empty token.
const held = (key: string): boolean => {
    const value = process.env[key];
    return value !== undefined && value !== "";
};

export interface E2eTier<K extends string> {
    /** Whether the world has everything this tier named. Feed it to `describe.skipIf(!tier.runs)`. */
    runs: boolean;
    /** The suite's name, carrying what is missing when the switch is on but a credential is not. */
    title: string;
    /** The declared credentials, read at use. Reading one where the tier does not run throws, naming it. */
    secrets: Record<K, string>;
}

/* Declare a tier. `title` is the suite's name, the same string that would otherwise be written inline in
 * `describe`, because the composed title is where a missing credential gets stated.
 *
 * Secrets are a Proxy rather than a snapshot so that a read is only ever legal where the tier runs. Module
 * scope executes even in a skipped file, so a suite that lifts a token to a top-level `const` would be back to
 * failing on absence; reaching for one there now throws a sentence saying so, instead of handing back the empty
 * string that quietly reaches the service. Inside a hook or a test, where `runs` is already true, every
 * declared key is present by construction.
 */
export const e2eTier = <K extends string = never>(title: string, tier: { enabledBy: string; secrets?: readonly K[] }): E2eTier<K> => {
    const missing = (tier.secrets ?? []).filter((key) => !held(key));
    const runs = asked(tier.enabledBy) && missing.length === 0;
    return {
        runs,
        // Annotated only when the switch is on: with e2e not asked for at all, every tier is off and saying so
        // on each of them is noise. The case worth naming is the nightly's, asked for, and short of a secret.
        title: asked(tier.enabledBy) && missing.length > 0 ? `${title} — stood down, no ${missing.join(" + ")}` : title,
        secrets: new Proxy({} as Record<K, string>, {
            get: (_target, key) => {
                if (typeof key === "symbol") {
                    return undefined;
                }
                const value = process.env[key];
                if (value === undefined || value === "") {
                    throw new Error(`${title} read ${key} where the tier does not run — a secret may only be read inside the suite`);
                }
                return value;
            },
        }),
    };
};
