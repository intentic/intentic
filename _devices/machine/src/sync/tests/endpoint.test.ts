import {
    dockerEndpointAnswers,
    type InspectContainer,
    liveIdentity,
    localSandboxContainer,
    mutagenForwardUrl,
    mutagenUrl,
    pairingEndpoint,
    remoteShell,
    servesSandbox,
} from "../endpoint.js";

// WHERE A PAIRING'S SANDBOX SIDE IS REACHED: over ssh, or through this machine's own Docker engine, and how a container
// is recognised as the sandbox it claims to be before a folder is ever synced into it.

const URL_A = "https://sandbox-0123456789ab.sbx.example.dev";
const CONTAINER_A = "intentic-sandbox-sandbox-0123456789ab";

// An engine that holds exactly these containers, each answering what `docker inspect` would.
const engine =
    (containers: Readonly<Record<string, { readonly running: boolean; readonly url?: string }>>): InspectContainer =>
    async (name) => {
        const held = containers[name];
        if (held === undefined) {
            return undefined;
        }
        return { running: held.running, env: ["PATH=/usr/bin", ...(held.url === undefined ? [] : [`SANDBOX_PUBLIC_URL=${held.url}`])] };
    };

describe("pairingEndpoint", () => {
    it("reaches every pairing over ssh unless it is a docker pairing naming its container", () => {
        expect(pairingEndpoint({ sandboxId: "box" })).toEqual({ kind: "ssh", alias: "intentic-sync-box" });
        expect(pairingEndpoint({ sandboxId: "box", transport: "docker", container: CONTAINER_A })).toEqual({ kind: "docker", container: CONTAINER_A });
        // A docker pairing that lost its container name cannot be reached through Docker, so it falls back to ssh.
        expect(pairingEndpoint({ sandboxId: "box", transport: "docker" })).toEqual({ kind: "ssh", alias: "intentic-sync-box" });
    });
});

describe("Mutagen's spellings", () => {
    const ssh = { kind: "ssh", alias: "intentic-sync-box" } as const;
    const docker = { kind: "docker", container: CONTAINER_A } as const;

    it("names a folder on the sandbox's side as an ssh host path or a docker:// URL", () => {
        expect(mutagenUrl(ssh, "/work/my-app")).toBe("intentic-sync-box:/work/my-app");
        expect(mutagenUrl(docker, "/work/my-app")).toBe(`docker://${CONTAINER_A}/work/my-app`);
    });

    it("names a forward's destination the same two ways", () => {
        expect(mutagenForwardUrl(ssh, "tcp:127.0.0.1:5173")).toBe("intentic-sync-box:tcp:127.0.0.1:5173");
        expect(mutagenForwardUrl(docker, "tcp:[::1]:5173")).toBe(`docker://${CONTAINER_A}:tcp:[::1]:5173`);
    });

    // As `sync list --template {{json .}}` printed them against Mutagen 0.18.1.
    it("knows each endpoint by the protocol and host a live session reports", () => {
        expect(liveIdentity(ssh)).toEqual({ protocol: "ssh", host: "intentic-sync-box" });
        expect(liveIdentity(docker)).toEqual({ protocol: "docker", host: CONTAINER_A });
    });
});

describe("remoteShell", () => {
    it("hands ssh the command as its last argument, and calls the transport that never connected by name", () => {
        const shell = remoteShell({ kind: "ssh", alias: "intentic-sync-box" }, "/usr/bin/ssh", ["-o", "BatchMode=yes"]);
        expect([shell.command, ...shell.argsFor("echo hi")]).toEqual(["/usr/bin/ssh", "-o", "BatchMode=yes", "intentic-sync-box", "echo hi"]);
        expect(shell.unreachable).toEqual({ status: 255, sentence: "ssh could not reach the sandbox" });
    });

    it("runs the same command through `docker exec -i … sh -c`, with no ssh option and no status of its own", () => {
        const shell = remoteShell({ kind: "docker", container: CONTAINER_A }, "/usr/bin/ssh", ["-o", "BatchMode=yes"]);
        expect([shell.command, ...shell.argsFor("echo hi")]).toEqual(["docker", "exec", "-i", CONTAINER_A, "sh", "-c", "echo hi"]);
        expect(shell.unreachable).toBeUndefined();
    });
});

describe("servesSandbox", () => {
    it("recognises the sandbox by the public address ic started it with, whatever trailing slash either side has", () => {
        expect(servesSandbox({ running: true, env: [`SANDBOX_PUBLIC_URL=${URL_A}/`] }, URL_A)).toBe(true);
        expect(servesSandbox({ running: true, env: [`SANDBOX_PUBLIC_URL=${URL_A}`] }, `${URL_A}/`)).toBe(true);
    });

    it("refuses a stopped container, another sandbox, one with no address, and one docker does not have", () => {
        expect(servesSandbox({ running: false, env: [`SANDBOX_PUBLIC_URL=${URL_A}`] }, URL_A)).toBe(false);
        expect(servesSandbox({ running: true, env: ["SANDBOX_PUBLIC_URL=https://sandbox-ffffffffffff.sbx.example.dev"] }, URL_A)).toBe(false);
        expect(servesSandbox({ running: true, env: ["PATH=/usr/bin"] }, URL_A)).toBe(false);
        expect(servesSandbox(undefined, URL_A)).toBe(false);
    });
});

describe("localSandboxContainer", () => {
    it("finds the container ic named after the URL's slug when it runs this sandbox", async () => {
        expect(await localSandboxContainer(URL_A, engine({ [CONTAINER_A]: { running: true, url: URL_A } }))).toBe(CONTAINER_A);
    });

    // ic names a sandbox with no hostname of its own by the bare id, the second slug a pairing's URL carries.
    it("tries the bare id's container when the hostname's is not there", async () => {
        const bare = "intentic-sandbox-0123456789ab";
        expect(await localSandboxContainer(URL_A, engine({ [bare]: { running: true, url: URL_A } }))).toBe(bare);
    });

    it("answers nothing for a sandbox this engine does not run, a stopped one, or a namesake serving another address", async () => {
        expect(await localSandboxContainer(URL_A, engine({}))).toBeUndefined();
        expect(await localSandboxContainer(URL_A, engine({ [CONTAINER_A]: { running: false, url: URL_A } }))).toBeUndefined();
        expect(await localSandboxContainer(URL_A, engine({ [CONTAINER_A]: { running: true, url: "https://sandbox-0123456789ab.other.dev" } }))).toBeUndefined();
    });
});

describe("dockerEndpointAnswers", () => {
    // Asked before every session is made through the container: the name can outlive the sandbox it was paired with.
    it("answers only while the named container is still this sandbox", async () => {
        expect(await dockerEndpointAnswers(CONTAINER_A, URL_A, engine({ [CONTAINER_A]: { running: true, url: URL_A } }))).toBe(true);
        expect(await dockerEndpointAnswers(CONTAINER_A, URL_A, engine({ [CONTAINER_A]: { running: true, url: "https://sandbox-new.sbx.example.dev" } }))).toBe(false);
        expect(await dockerEndpointAnswers(CONTAINER_A, URL_A, engine({}))).toBe(false);
    });
});
