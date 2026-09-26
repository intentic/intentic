// A test that needs something of the machine (a binary, a kernel setting, a build output) and cannot run without it.
// Locally it stands down, and says so in its title; `suites` counts what stood down after the run. On CI it FAILS, since
// CI is where the condition is provided on purpose, and a skip there is a test that silently stopped running.
// A requirement CI goes without on purpose (a tool its image does not carry, a privilege its containers lack) says so
// with `absentOnCi`, and stands down there as it does locally, counted and titled, instead of failing.
// e2e.ts decides the opt-in tiers the same way for credentials; this is for the machine.
import { appendFileSync } from "node:fs";
import { STOOD_DOWN_FILE } from "../../constants/src/test-suites.mjs";

type Env = Readonly<Record<string, string | undefined>>;

// Set by every forge; `0`/`false` read as unset, as a leftover in a shell would.
const onCi = (env: Env): boolean => {
    const value = env["CI"];
    return value !== undefined && value !== "" && value !== "0" && value !== "false";
};

export interface Requirement {
    /** Whether the tests that need it run; feed to `test.skipIf(!needs.runs)` or `describe.skipIf(!needs.runs)`. */
    readonly runs: boolean;
    /** The test's title, annotated with what is missing when it stands down, and counted for `suites`. */
    readonly title: (title: string) => string;
}

export interface RequirementOptions {
    /** Why CI does not provide it on purpose; there it then stands down, counted and titled, rather than failing. */
    readonly absentOnCi?: string;
}

/** `requires` with its environment and test registration handed in, which is what its own suite needs. */
export const requirementOf = (
    condition: boolean,
    why: string,
    env: Env,
    register: (title: string, body: () => void) => void,
    { absentOnCi }: RequirementOptions = {},
): Requirement => {
    if (condition) {
        return { runs: true, title: (title) => title };
    }
    const ci = onCi(env);
    if (ci && absentOnCi === undefined) {
        register(`requires ${why}`, () => {
            throw new Error(`this machine lacks ${why}, which CI provides on purpose: the tests that need it would otherwise skip unseen`);
        });
        return { runs: false, title: (title) => title };
    }
    return {
        runs: false,
        title: (title) => {
            // One `why\ttitle` line per test, for `suites` to count after the run.
            const file = env[STOOD_DOWN_FILE];
            if (file !== undefined && file !== "") {
                appendFileSync(file, `${why}\t${title}\n`);
            }
            return ci ? `${title} (stood down: needs ${why}, which CI lacks: ${absentOnCi})` : `${title} (stood down: needs ${why})`;
        },
    };
};

/**
 * `condition` is whether the machine has what the tests need; `why` names it ("procps (pgrep) on PATH"). Unmet on CI, it
 * registers a failing test naming the requirement, where it is called, and the tests that need it skip beside it, unless
 * `absentOnCi` says why CI goes without it.
 */
export const requires = (condition: boolean, why: string, options?: RequirementOptions): Requirement =>
    requirementOf(condition, why, process.env, test, options);
