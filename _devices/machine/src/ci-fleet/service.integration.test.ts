import { join } from "node:path";
import { askFleet, FleetUnavailable } from "./client.js";
import { exec, fakeSys, runnerFiles, runnerPrograms, tempDir, testContext } from "./ci-fleet-testing.js";
import { listenOn } from "./fleet-service.js";

/* The socket between the person's agent and the fleet service, on a real unix socket in a temp folder: a request in, an
   answer out, a refusal in words, and a missing service told apart from a service that said no. */

const WORKER_1 = "actions.runner.intentic-intentic.z440-worker-1.service";
const runners = [{ unit: WORKER_1, dir: "/r/1", name: "z440-worker-1", worker: 9 }];

const serve = async () => {
    const sys = fakeSys({ programs: runnerPrograms(runners), files: runnerFiles(runners) });
    const { context } = await testContext(sys);
    const heard: string[] = [];
    const path = join(tempDir("ci-fleet-sock-"), "fleet.sock");
    const server = await listenOn(context, { heard: (version) => heard.push(version) }, path, process.getgid?.() ?? 0);
    return { path, server, heard, sys };
};

test("status and hello answer with the service's state, and hello is passed on to the updater", async () => {
    const { path, server, heard } = await serve();
    try {
        const answer = await askFleet({ verb: "hello", version: "1.501.0" }, 5_000, path);
        expect(answer.status?.version).toBe("1.500.0");
        expect(heard).toEqual(["1.501.0"]);
    } finally {
        server.close();
    }
});

test("a refused op comes back as an error in the service's words", async () => {
    const { path, server } = await serve();
    try {
        await expect(askFleet({ verb: "unit", name: "z440-worker-1", op: "stop" }, 5_000, path)).rejects.toThrow(/running a job/u);
    } finally {
        server.close();
    }
});

test("a request the protocol does not know is refused unread", async () => {
    const { path, server, sys } = await serve();
    try {
        // @ts-expect-error: a verb the protocol does not have, as an older or a hostile client would send
        await expect(askFleet({ verb: "shell", command: "id" }, 5_000, path)).rejects.toThrow(/does not take that request/u);
        expect(sys.calls).toEqual([]);
    } finally {
        server.close();
    }
});

test("no service at the socket is FleetUnavailable, saying how to set it up", async () => {
    const error = await askFleet({ verb: "status" }, 5_000, join(tempDir(), "absent.sock")).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(FleetUnavailable);
    expect(String(error)).toMatch(/ci-fleet install/u);
    expect(exec("x").stdout).toBe("x");
});
