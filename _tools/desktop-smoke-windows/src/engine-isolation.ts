import { STATE_DIR } from "@intentic/constants";
import { SANDBOX_HOSTNAME } from "./constants.js";
import { ENGINE_SANDBOX_HOSTNAME } from "./engine.js";
import { sandboxContainerName, SANDBOX_CONTAINER_PREFIX } from "./parse.js";
import { run } from "./run.js";

interface Container {
    readonly Name: string;
    readonly Mounts: readonly { readonly Type: string; readonly Source: string }[];
    readonly HostPlatform?: string;
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

/** A move switches this side's sandboxes, including unstamped legacy containers; other sides stay on Docker Desktop. */
export const engineIsolationOf = (containers: readonly Container[], root: string) => {
    const normalizedRoot = drivePath(root);
    const others = containers.filter((container) => !isFixture(container.Name.replace(/^\//, ``)));
    return {
        unexpected: others
            .filter((container) => !container.HostPlatform || container.HostPlatform.toLowerCase() === `windows`)
            .map((container) => container.Name.replace(/^\//, ``))
            .filter((name) => name.startsWith(SANDBOX_CONTAINER_PREFIX)),
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
    // Read only the keeper's platform out of Config.Env, never credentials held beside it.
    const format = `{{$platform := ""}}{{range .Config.Env}}{{if eq (index (split . "=") 0) "HOST_PLATFORM"}}{{$platform = index (split . "=") 1}}{{end}}{{end}}{"Name":{{json .Name}},"Mounts":{{json .Mounts}},"HostPlatform":{{json $platform}}}`;
    const inspected = await run(`docker`, [`inspect`, `--format`, format, ...ids], { timeoutMs: 30_000 });
    if (inspected.code !== 0) {
        throw new Error(`could not read the engine tier's isolation boundary: ${inspected.stderr}`);
    }
    // SAFETY: docker's template emits Name, Mounts and HostPlatform per container ID from `docker ps`; it omits
    // the container environment, which may hold credentials. Docker owns the shape of these fields.
    const containers = inspected.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)) as Container[];
    return engineIsolationOf(containers, root);
};
