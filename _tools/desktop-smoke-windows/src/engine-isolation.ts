import { STATE_DIR } from "@intentic/constants";
import { SANDBOX_HOSTNAME } from "./constants.js";
import { ENGINE_SANDBOX_HOSTNAME } from "./engine.js";
import { sandboxContainerName, SANDBOX_CONTAINER_PREFIX } from "./parse.js";
import { run } from "./run.js";

interface Container {
    readonly Name: string;
    readonly Mounts: readonly { readonly Type: string; readonly Source: string }[];
}

const fixtures = [SANDBOX_HOSTNAME, ENGINE_SANDBOX_HOSTNAME].map(sandboxContainerName);
const isFixture = (name: string): boolean => fixtures.some((fixture) => name === fixture || name === `${fixture}.moved` || name === `${fixture}.previous`);

// Docker Desktop and our engine report different spellings of the same Windows drive path.
const drivePath = (path: string): string => path
    .replaceAll(`\\`, `/`)
    .replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt|mnt)\//, `/`)
    .replace(/^([a-z]):/i, `/$1`)
    .replace(/\/+$/, ``)
    .toLowerCase();

/** A move switches every sandbox of this side, including stopped legacy containers. Only CI's fixtures may be here. */
export const engineIsolationOf = (containers: readonly Container[], root: string) => {
    const normalizedRoot = drivePath(root);
    const others = containers.filter((container) => !isFixture(container.Name.replace(/^\//, ``)));
    return {
        unexpected: others.map((container) => container.Name.replace(/^\//, ``)).filter((name) => name.startsWith(SANDBOX_CONTAINER_PREFIX)),
        homeUsers: others.filter((container) => container.Mounts.some((mount) => {
            const source = drivePath(mount.Source);
            return mount.Type === `bind` && (source === normalizedRoot || source.startsWith(`${normalizedRoot}/`));
        })).map((container) => container.Name.replace(/^\//, ``)),
    };
};

/** Read stopped containers too: their keys must survive cleanup even while nothing is running. Throws on uncertainty. */
export const readEngineIsolation = async (root: string): Promise<ReturnType<typeof engineIsolationOf>> => {
    const listed = await run(`docker`, [`ps`, `-aq`], { timeoutMs: 30_000 });
    if (listed.code !== 0) {
        throw new Error(`could not check which containers use the engine tier's ${STATE_DIR} home: ${listed.stderr}`);
    }
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) {
        return { unexpected: [], homeUsers: [] };
    }
    const inspected = await run(`docker`, [`inspect`, `--format`, `{"Name":{{json .Name}},"Mounts":{{json .Mounts}}}`, ...ids], { timeoutMs: 30_000 });
    if (inspected.code !== 0) {
        throw new Error(`could not read the engine tier's isolation boundary: ${inspected.stderr}`);
    }
    // SAFETY: docker's template emits one object with Name and Mounts per container ID from `docker ps`; it omits
    // the container environment, which may hold credentials. Docker owns the shape of these fields.
    const containers = inspected.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)) as Container[];
    return engineIsolationOf(containers, root);
};
