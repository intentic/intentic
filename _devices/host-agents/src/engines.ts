import { STATE_DIR } from "@intentic/constants";
import type { AdapterSpec, HarnessSpec } from "./harnesses.js";
import type { PlaceHost } from "./place.js";

// HOW ONE HARNESS IS STARTED IN ONE PLACE: its own program on PATH, its adapter on PATH, or the adapter this package
// fetched. Looked for again on every start rather than remembered, since a reader installs and removes these in a
// terminal this process never sees.

// What starts a harness's ACP process: its argv, run with no shell, and the variables laid over the place's own.
export interface HarnessLaunch {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    // Where it came from, for the words a card says about it.
    readonly source: `path` | `fetched`;
}

// How a harness stands in a place before anything is started.
export type HarnessState =
    | { readonly state: `ready`; readonly launch: HarnessLaunch }
    // Its adapter can be fetched; nothing of it is here yet.
    | { readonly state: `fetchable` }
    // Nothing here runs it and nothing can be fetched: the reader installs the harness themselves.
    | { readonly state: `missing`; readonly why: string };

// The variable that makes a program compiled by Bun act as Bun itself: how this process, the desktop app's sidecar,
// stands in for the JavaScript runtime a computer may not have.
const AS_BUN = { BUN_BE_BUN: `1` };

interface Runtime {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

// What runs a script there: the place's own Node, else this process as Bun where the place is this process's own side.
const scriptRuntime = async (host: PlaceHost): Promise<Runtime | undefined> => {
    const node = await host.which(`node`);
    if (node !== undefined) {
        return { argv: [node], env: {} };
    }
    return host.key === `native` && process.versions[`bun`] !== undefined ? { argv: [process.execPath], env: AS_BUN } : undefined;
};

// The folder one adapter version is fetched into, under the reader's home in that place.
const engineDir = async (host: PlaceHost, harness: string, adapter: AdapterSpec): Promise<string> =>
    host.join(await host.home(), STATE_DIR, `engines`, `host-agents`, harness, adapter.version);

// Written last, so a fetch that was cut short is never read as an adapter.
const FETCHED_MARK = `.fetched`;

const fetchedLaunch = async (host: PlaceHost, harness: HarnessSpec, adapter: AdapterSpec): Promise<HarnessLaunch | undefined> => {
    const dir = await engineDir(host, harness.id, adapter);
    if (!(await host.exists(host.join(dir, FETCHED_MARK)))) {
        return undefined;
    }
    const entry = adapter.entry(host);
    const program = host.join(dir, `node_modules`, ...entry.path);
    if (!(await host.exists(program))) {
        return undefined;
    }
    if (entry.kind === `program`) {
        return { argv: [program], env: {}, source: `fetched` };
    }
    const runtime = await scriptRuntime(host);
    return runtime === undefined ? undefined : { argv: [...runtime.argv, program], env: runtime.env, source: `fetched` };
};

export const harnessState = async (host: PlaceHost, harness: HarnessSpec): Promise<HarnessState> => {
    const { adapter, cli } = harness;
    if (adapter !== undefined) {
        const onPath = await host.which(adapter.bin);
        if (onPath !== undefined) {
            return { state: `ready`, launch: { argv: [onPath], env: {}, source: `path` } };
        }
        const fetched = await fetchedLaunch(host, harness, adapter);
        if (fetched !== undefined) {
            return { state: `ready`, launch: fetched };
        }
    }
    if (cli !== undefined) {
        const onPath = await host.which(cli.bin);
        if (onPath !== undefined) {
            return { state: `ready`, launch: { argv: [onPath, ...cli.args], env: {}, source: `path` } };
        }
    }
    if (adapter === undefined) {
        return { state: `missing`, why: `${harness.label} isn't installed on this computer.` };
    }
    // A script adapter needs something to run it; a program needs only fetching.
    if (adapter.entry(host).kind === `script` && (await scriptRuntime(host)) === undefined) {
        return { state: `missing`, why: `${harness.label} needs Node.js here to run. Install Node.js, then try again.` };
    }
    return (await fetcher(host)) === undefined
        ? { state: `missing`, why: `${harness.label} can't be set up here: there is no npm to fetch it with. Install Node.js, then try again.` }
        : { state: `fetchable` };
};

// What fetches a package there: this process as Bun on its own side, else the place's npm.
const fetcher = async (host: PlaceHost): Promise<((spec: string) => { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> }) | undefined> => {
    if (host.key === `native` && process.versions[`bun`] !== undefined) {
        return (spec) => ({ argv: [process.execPath, `add`, `--exact`, spec], env: AS_BUN });
    }
    const npm = await host.which(`npm`);
    return npm === undefined ? undefined : (spec) => ({ argv: [npm, `install`, `--no-audit`, `--no-fund`, `--no-package-lock`, spec], env: {} });
};

const FETCH_LIMIT_MS = 10 * 60_000;

/** Fetches a harness's adapter into its folder. Throws with words a card can show when it cannot. */
export const fetchAdapter = async (host: PlaceHost, harness: HarnessSpec, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> => {
    const { adapter } = harness;
    if (adapter === undefined) {
        throw new Error(`${harness.label} isn't something Intentic can set up: install it yourself, then try again.`);
    }
    const fetch = await fetcher(host);
    if (fetch === undefined) {
        throw new Error(`There is no npm here to fetch ${harness.label} with. Install Node.js, then try again.`);
    }
    const dir = await engineDir(host, harness.id, adapter);
    await host.mkdirs(dir);
    await host.write(host.join(dir, `package.json`), `${JSON.stringify({ name: `intentic-host-agent-${harness.id}`, private: true }, null, 2)}\n`);
    const { argv, env } = fetch(`${adapter.pkg}@${adapter.version}`);
    const ran = await host.run(argv, { cwd: dir, env, timeoutMs: FETCH_LIMIT_MS, signal, onLine });
    if (ran.code !== 0) {
        const said = (ran.stderr.trim() || ran.stdout.trim()).split(`\n`).slice(-4).join(`\n`);
        throw new Error(`Fetching ${harness.label} failed${said === `` ? `.` : `: ${said}`}`);
    }
    await host.write(host.join(dir, FETCHED_MARK), `${adapter.pkg}@${adapter.version}\n`);
};
