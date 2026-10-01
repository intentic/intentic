import { DOCKER_ANSWER_MS, INSPECT_FORMAT, parsePublishedPorts, publishedPortsReader, readPublishedPorts, type RunDocker } from "../docker-ports.js";
import type { ExecResult } from "../exec.js";

// WHAT THIS MACHINE'S DOCKER PUBLISHES, read the way the port mirror reads it: the ports a container holds now, and the
// ones a container Docker starts again by itself will hold once it is back.

type Bindings = Readonly<Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[]>> | null;

// One container as `docker inspect --format INSPECT_FORMAT` printed it on Docker Desktop (Docker 28): a leading "/" on
// the name, the running flag, the restart policy, the bindings as JSON.
const container = (name: string, running: boolean, policy: string, bindings: Bindings): string =>
    `/${name}|${String(running)}|${policy}|${JSON.stringify(bindings)}`;

const on = (port: string, hostIp = ""): Bindings => ({ "5432/tcp": [{ HostIp: hostIp, HostPort: port }] });

describe("parsePublishedPorts", () => {
    it("counts every port a running container publishes, whatever its restart policy", () => {
        const printed = [
            container("intentic-postgres-1", true, "unless-stopped", on("5440")),
            container("qdrant", true, "no", {
                "6333/tcp": [{ HostIp: "", HostPort: "6333" }],
                "6334/tcp": [{ HostIp: "", HostPort: "6334" }],
            }),
        ].join("\n");
        expect(parsePublishedPorts(printed)).toEqual(
            new Map([
                [5440, "intentic-postgres-1"],
                [6333, "qdrant"],
                [6334, "qdrant"],
            ]),
        );
    });

    // Docker starts `always` and `unless-stopped` containers again by itself, its own restart included: that window is
    // where a bind probe finds their ports free.
    it("counts a stopped container's ports only when Docker brings it back by itself", () => {
        const printed = [
            container("db", false, "unless-stopped", on("5440")),
            container("cache", false, "always", on("6379")),
            container("old-db", false, "no", on("5432")),
            container("crashy", false, "on-failure", on("8080")),
            container("bare", false, "", on("9000")),
        ].join("\n");
        expect(parsePublishedPorts(printed)).toEqual(
            new Map([
                [5440, "db"],
                [6379, "cache"],
            ]),
        );
    });

    it("finds nothing in a container that publishes nothing, or only ports Docker picks at start", () => {
        const printed = [
            container("gated", true, "always", {}),
            container("bare", true, "always", null),
            container("ephemeral", true, "always", { "80/tcp": [{ HostIp: "", HostPort: "" }] }),
            container("zero", true, "always", on("0")),
        ].join("\n");
        expect(parsePublishedPorts(printed)).toEqual(new Map());
    });

    it("counts a port bound on both families once", () => {
        const twice = { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5440" }, { HostIp: "::", HostPort: "5440" }] };
        expect(parsePublishedPorts(container("db", true, "no", twice))).toEqual(new Map([[5440, "db"]]));
    });

    // A forward listens on 127.0.0.1: every address that holds that port counts, and one that leaves it free does not.
    it("counts bindings on loopback or every interface, and not one on another address", () => {
        const printed = [
            container("v4", true, "no", on("5001", "127.0.0.1")),
            container("v6", true, "no", on("5002", "::1")),
            container("any", true, "no", on("5003", "0.0.0.0")),
            container("lan", true, "no", on("5004", "192.168.1.20")),
        ].join("\n");
        expect(parsePublishedPorts(printed)).toEqual(
            new Map([
                [5001, "v4"],
                [5002, "v6"],
                [5003, "any"],
            ]),
        );
    });

    // Docker picks one port of a range when the container starts, so until then each of them is spoken for.
    it("counts every port of a range", () => {
        expect(parsePublishedPorts(container("web", false, "always", on("8000-8002")))).toEqual(
            new Map([
                [8000, "web"],
                [8001, "web"],
                [8002, "web"],
            ]),
        );
    });

    it("names every container that publishes one port", () => {
        const printed = [container("db", true, "no", on("5440")), container("db-before", false, "always", on("5440"))].join("\n");
        expect(parsePublishedPorts(printed)).toEqual(new Map([[5440, "db, db-before"]]));
    });

    it("skips a line it cannot read, and keeps every other", () => {
        const printed = ["WARNING: the engine is slow", "/broken|true|always|{not json", "/short|true", "", container("db", true, "no", on("5440")), ""].join("\r\n");
        expect(parsePublishedPorts(printed)).toEqual(new Map([[5440, "db"]]));
    });
});

// A docker that answers each call in turn, recording what it was asked.
const answering = (...answers: ExecResult[]) => {
    const asked: (readonly string[])[] = [];
    const docker: RunDocker = async (args) => {
        asked.push(args);
        const answer = answers.shift();
        if (answer === undefined) {
            throw new Error(`docker ${args.join(" ")} was asked once more than this test expects`);
        }
        return await Promise.resolve(answer);
    };
    return { docker, asked };
};

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });

describe("readPublishedPorts", () => {
    it("lists every container, then inspects them all in one call", async () => {
        const { docker, asked } = answering(ok("3f2f3116c2c7\na87c91dcfb9d\n"), ok(`${container("intentic-postgres-1", true, "unless-stopped", on("5440"))}\n`));
        expect(await readPublishedPorts(docker)).toEqual(new Map([[5440, "intentic-postgres-1"]]));
        expect(asked).toEqual([
            ["ps", "--all", "--quiet"],
            ["inspect", "--format", INSPECT_FORMAT, "3f2f3116c2c7", "a87c91dcfb9d"],
        ]);
    });

    it("answers that nothing is published by an engine with no containers, without inspecting", async () => {
        const { docker, asked } = answering(ok(""));
        expect(await readPublishedPorts(docker)).toEqual(new Map());
        expect(asked).toEqual([["ps", "--all", "--quiet"]]);
    });

    // "Unknown", never "nothing": an empty answer here would leave the mirror trusting the bind probe alone.
    it("answers unknown when docker is missing or past its bound, the engine is down or refuses, or the inspection fails", async () => {
        // Missing from PATH, and killed at its bound: no exit status at all.
        expect(await readPublishedPorts(answering({ status: null, stdout: "", stderr: "spawn docker ENOENT" }).docker)).toBeUndefined();
        expect(await readPublishedPorts(answering({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }).docker)).toBeUndefined();
        expect(await readPublishedPorts(answering({ status: 1, stdout: "", stderr: "permission denied while trying to connect" }).docker)).toBeUndefined();
        // A container removed between the two calls: the inspection exits non-zero.
        const vanished = answering(ok("3f2f3116c2c7\n"), { status: 1, stdout: "", stderr: "Error: No such object: 3f2f3116c2c7" });
        expect(await readPublishedPorts(vanished.docker)).toBeUndefined();
    });
});

describe("publishedPortsReader", () => {
    const T0 = 1_700_000_000_000;
    const published = new Map([[5440, "intentic-postgres-1"]]);

    it("asks Docker at most once per answer's lifetime, an unanswered ask included", async () => {
        let clock = T0;
        // The engine is still starting at the first ask, and answers by the second.
        const answers = [undefined, published];
        let asks = 0;
        const read = publishedPortsReader(
            () => {},
            async () => {
                asks += 1;
                return await Promise.resolve(answers[asks - 1]);
            },
            () => clock,
        );
        expect(await read()).toBeUndefined();
        clock = T0 + DOCKER_ANSWER_MS - 1;
        expect(await read()).toBeUndefined();
        expect(asks).toBe(1);
        clock = T0 + DOCKER_ANSWER_MS;
        expect(await read()).toEqual(published);
        expect(asks).toBe(2);
        expect(DOCKER_ANSWER_MS).toBe(30_000);
    });

    // A throw out of a pairing's pass reads as its sandbox being unreachable, so a failed ask is an unknown answer.
    it("never throws: a failed ask is an unknown answer, and the log says what failed", async () => {
        const said: string[] = [];
        const read = publishedPortsReader(
            (line) => void said.push(line),
            async () => await Promise.reject(new Error("docker went away mid-call")),
            () => T0,
        );
        expect(await read()).toBeUndefined();
        expect(said).toEqual(["  asking Docker which ports it publishes failed: docker went away mid-call"]);
    });
});
