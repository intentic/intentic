// What the engine tier reads and builds, as pure functions: `ic engine status --json`, the `intentic-move:` lines, the
// isolated environment the tier runs ic in, and how its own `docker` reaches the engine under test.

/** The distro the tier's engine lives in: never the real one's name, so a developer's engine on this machine is safe. */
export const ENGINE_DISTRO = `intentic-engine-ci`;

/** The sandbox the tier moves between engines: its own hostname, so the setup tier's sandbox is never touched. */
export const ENGINE_SANDBOX_HOSTNAME = `winengine.e2e.test`;
export const ENGINE_CONNECT_TOKEN = `windows-engine-smoke-token`;

/** The Run key value a non-default distro's engine would register (ic's engine/windows.rs `autostart_value`). */
export const ENGINE_RUN_VALUE = `IntenticEngine-${ENGINE_DISTRO}`;

export interface EngineStatus {
    readonly engine: string;
    readonly installed: boolean;
    readonly running: boolean;
    readonly active: boolean;
    readonly held: boolean;
}

/** The status line out of whatever else ic printed, or undefined when there is none. */
export const engineStatusOf = (stdout: string): EngineStatus | undefined => {
    const line = stdout
        .split(/\r?\n/)
        .map((text) => text.trim())
        .reverse()
        .find((text) => text.startsWith(`{`));
    if (line === undefined) {
        return undefined;
    }
    try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value[`engine`] !== `string`) {
            return undefined;
        }
        return {
            engine: value[`engine`],
            installed: value[`installed`] === true,
            running: value[`running`] === true,
            active: value[`active`] === true,
            held: value[`held`] === true,
        };
    } catch {
        return undefined;
    }
};

/** Every `intentic-move:` line ic printed, parsed; anything else is left out. */
export const moveLines = (stdout: string): Record<string, unknown>[] =>
    stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`intentic-move:`))
        .flatMap((line) => {
            try {
                const value: unknown = JSON.parse(line.slice(`intentic-move:`.length).trim());
                return typeof value === `object` && value !== null ? [value as Record<string, unknown>] : [];
            } catch {
                return [];
            }
        });

/**
 * The environment ic runs in for this tier: its own home (so `~/.intentic`, the engine record and the TLS pair are the
 * tier's, never CI's own), its own LOCALAPPDATA (the distro's disk), its own distro name, no sign-in autostart, and the
 * engine built from this checkout.
 */
export const isolatedEnv = (root: string, tarball: string): Record<string, string> => {
    const home = `${root}\\home`;
    return {
        USERPROFILE: home,
        HOME: home,
        LOCALAPPDATA: `${root}\\localappdata`,
        INTENTIC_HOME: `${home}\\.intentic`,
        IC_ENGINE_DISTRO: ENGINE_DISTRO,
        IC_ENGINE_AUTOSTART: `0`,
        INTENTIC_ENGINE_TARBALL: tarball,
        INTENTIC_NO_PROMPT: `1`,
    };
};

/** What the tier's own `docker` needs to reach the engine under test, read off the record ic wrote: its CLI and TLS. */
export const engineDockerOf = (record: string): { readonly docker: string; readonly env: Record<string, string> } | undefined => {
    try {
        const value = JSON.parse(record) as Record<string, unknown>;
        const { host, certPath, bin } = value;
        if (typeof host !== `string` || typeof certPath !== `string` || typeof bin !== `string`) {
            return undefined;
        }
        return {
            docker: `${bin}\\docker.exe`,
            env: { DOCKER_HOST: host, DOCKER_TLS_VERIFY: `1`, DOCKER_CERT_PATH: certPath },
        };
    } catch {
        return undefined;
    }
};
