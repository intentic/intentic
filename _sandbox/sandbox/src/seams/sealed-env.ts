// The container's own secrets arrive as environment variables (the runner's `docker run -e`), and every child inherits
// its parent's environment. Until 2026-10-06 that put CONNECT_TOKEN, both pairing tokens, the tunnel grant, the
// translator bearer and the provider fallback keys into every agent turn, check, panel, extension and service process,
// through the 32 sites that spread `process.env` and the tmux server every pane is forked from.
//
// The fix is at the source rather than at each spawn: the config schema is the one declaration of which variables are
// secret (env.config.ts, `secret: true`), and boot takes exactly those out of `process.env` the moment loadConfig has
// read them, before the first child exists. Nothing spawned afterwards can inherit one, including a spawn site written
// next year. The few a child genuinely needs are handed over by name, by the code that spawns it (containerKeyEnv).

// The provider keys a container may be started with, as the fallback credential of a turn no stored account serves.
// Each belongs to exactly one runtime, which is the only thing that is handed it.
export interface ContainerKeys {
    // Claude Code's own: an OAuth token, or a plain API key.
    readonly claude: Readonly<Record<string, string>>;
    // Native Codex's own, used when no ChatGPT account is connected.
    readonly codex: Readonly<Record<string, string>>;
}

const NO_KEYS: ContainerKeys = { claude: {}, codex: {} };

let held: ContainerKeys = NO_KEYS;

// Which secrets the container was started WITH, by name only. A sealed variable is gone from the environment, which a
// reader asking "was this container given X" must not take as "it never was": the reach report checks the started env
// for the grant, and reading the sealed one told every sandbox since 2026-10-06 that its setup predated public addresses.
let sealedNames: ReadonlySet<string> = new Set();

// What a sealed variable reads as in `startedEnv`: present, and not the value.
const SEALED = "(sealed)";

// Present-only: an empty config value is "not set", and an empty variable would read to a CLI as a set, empty key.
const present = (entries: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== ""));

export interface SealInput {
    // Every environment name the config schema marks secret (env.config.ts CONFIG_SECRET_ENV).
    readonly secretEnv: readonly string[];
    // The values the runtimes' fallback keys are taken from, as loadConfig read them (env, the dev .env, or flags).
    readonly keys: { readonly claudeCodeOauthToken: string; readonly anthropicApiKey: string; readonly openaiApiKey: string };
}

/**
 * Keeps the container's provider keys for the runtimes they belong to, then deletes every secret-classified variable from
 * `env`. Call once, right after loadConfig and before anything is spawned.
 */
export const sealConfigSecrets = (input: SealInput, env: NodeJS.ProcessEnv = process.env): void => {
    held = {
        claude: present({ CLAUDE_CODE_OAUTH_TOKEN: input.keys.claudeCodeOauthToken, ANTHROPIC_API_KEY: input.keys.anthropicApiKey }),
        codex: present({ OPENAI_API_KEY: input.keys.openaiApiKey }),
    };
    sealedNames = new Set(input.secretEnv.filter((name) => (env[name] ?? "").trim() !== ""));
    for (const name of input.secretEnv) {
        delete env[name];
    }
};

/**
 * The container's environment as it was started, for asking what it was GIVEN: what is left, plus every sealed secret
 * it was started with, standing in as a placeholder rather than its value. Presence checks only (containerDrift).
 */
export const startedEnv = (env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string | undefined>> => ({
    ...env,
    ...Object.fromEntries([...sealedNames].map((name) => [name, SEALED])),
});

/** The container's fallback key for one runtime, as the env that runtime reads it from; empty when none was given. */
export const containerKeyEnv = (runtime: keyof ContainerKeys): Readonly<Record<string, string>> => held[runtime];

/** Test-only: forget what a previous seal kept. */
export const resetSealedEnvForTests = (): void => {
    held = NO_KEYS;
    sealedNames = new Set();
};
