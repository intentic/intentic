// Decides whether a gated e2e suite runs at all; vitest.ts decides how long one may take. The opt-in switch
// (`enabledBy`) and the credentials (`secrets`) are separate, so the switch on with no secret stands down rather than
// fails; the missing one names itself in the suite's title. Does not gate a Docker daemon; CI's e2e jobs extend `.dind`
// for that.

// Only `1`/`true` count as on; a leftover `=0` in the shell must read as off, not as "non-empty means run".
const asked = (key: string): boolean => process.env[key] === "1" || process.env[key] === "true";

// Empty string counts as missing too: CI defines an unset secret as "", not `undefined`.
const held = (key: string): boolean => {
    const value = process.env[key];
    return value !== undefined && value !== "";
};

export interface E2eTier<K extends string> {
    /** Whether the world has everything this tier needs; feed to `describe.skipIf(!tier.runs)`. */
    runs: boolean;
    /** The suite's name, carrying what is missing when the switch is on but a credential is not. */
    title: string;
    /** The declared credentials, read at use. Reading one where the tier does not run throws, naming it. */
    secrets: Record<K, string>;
}

// `title` is the composed suite name: where a missing credential shows. `secrets` is a Proxy, not a snapshot, so a
// top-level read outside a running tier throws instead of silently returning "".
export const e2eTier = <K extends string = never>(title: string, tier: { enabledBy: string; secrets?: readonly K[] }): E2eTier<K> => {
    const missing = (tier.secrets ?? []).filter((key) => !held(key));
    const runs = asked(tier.enabledBy) && missing.length === 0;
    return {
        runs,
        // Annotated only when the switch is on; noting every unrequested tier as "off" would just be noise.
        title: asked(tier.enabledBy) && missing.length > 0 ? `${title}, stood down, no ${missing.join(" + ")}` : title,
        secrets: new Proxy({} as Record<K, string>, {
            get: (_target, key) => {
                if (typeof key === "symbol") {
                    return undefined;
                }
                const value = process.env[key];
                if (value === undefined || value === "") {
                    throw new Error(`${title} read ${key} where the tier does not run: a secret may only be read inside the suite`);
                }
                return value;
            },
        }),
    };
};
