import { HOST_STATE_ROOT } from "@intentic/constants";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { workspaceSwapScript } from "./workspace-swap.js";

// The shell transaction runs against one fake Docker executable, so assertions cover what the host does after each
// refusal, including created-but-stopped containers. No Docker daemon or sandbox is contacted.
const mockDocker = `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.SWAP_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
let code = 0, out = '';
const name = args.at(-1);
state.stopped ??= [];
const stopped = (id) => state.stopped.includes(id);
if (args[0] === 'inspect') {
    if (!state.containers[name]) code = 1;
    else if (args.includes('{{.Id}}')) out = state.containers[name];
    else if (args.includes('{{.RestartCount}}')) out = state.crash ? '3' : '0';
    else if (args.includes('{{.State.Status}} {{.State.ExitCode}}')) out = stopped(state.containers[name]) ? 'exited 0' : 'running 0';
} else if (args[0] === 'rename') {
    state.containers[args[2]] = state.containers[args[1]];
    delete state.containers[args[1]];
} else if (args[0] === 'rm') {delete state.containers[name];}
else if (args[0] === 'stop') {state.stopped.push(state.containers[name]);}
else if (args[0] === 'start') {state.stopped = state.stopped.filter((id) => id !== state.containers[name]);}
else if (args[0] === 'run') {
    state.containers['box'] = 'new';
    if (state.failAll || (args.includes('--gpus=all') && state.failGpu)) code = 125;
} else if (args[0] === 'exec') {
    const target = args.find((arg) => state.containers[arg] !== undefined);
    code = target !== undefined && stopped(state.containers[target]) ? 1 : state.notReady && state.containers.box === 'new' ? 2 : 0;
}
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write(out);
process.exit(code);
`;

interface Arrangement {
    failGpu?: boolean;
    failAll?: boolean;
    notReady?: boolean;
    containers?: Record<string, string>;
    stopped?: string[];
}

const arrange = async (options: Arrangement = {}) => {
    const dir = await mkdtemp(join(tmpdir(), "workspace-swap-"));
    const stateFile = join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ containers: { box: "old" }, calls: [], ...options }));
    await writeFile(join(dir, "docker"), mockDocker, { mode: 0o755 });
    // Capture the probation program without leaving a test process running after the suite ends.
    await writeFile(join(dir, "nohup"), '#!/bin/sh\nprintf "%s" "$3" > "$SWAP_WATCH"\nprintf "%s" "$expected" > "$SWAP_READY"\n', { mode: 0o755 });
    await writeFile(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = {
        ...process.env,
        PATH: `${dir}:${process.env["PATH"]}`,
        SWAP_STATE: stateFile,
        SWAP_WATCH: join(dir, "watch.sh"),
        SWAP_READY: join(dir, "workspace-watch.ready"),
    };
    const script = workspaceSwapScript("box", "docker run --gpus=all img", "docker run img", 8787).replaceAll(HOST_STATE_ROOT, dir);
    const run = async () => {
        const result = spawnSync("sh", ["-c", script], { env, encoding: "utf8" });
        if (result.status === 0) {
            // The host watch detaches; wait only for our fake to have captured its program.
            for (let attempt = 0; attempt < 100; attempt += 1) {
                if (await readFile(env.SWAP_WATCH, "utf8").catch(() => "")) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        return result;
    };
    const state = async (): Promise<{ containers: Record<string, string>; calls: string[][]; crash?: boolean }> =>
        JSON.parse(await readFile(stateFile, "utf8"));
    return { dir, stateFile, env, run, state };
};

test("a rejected GPU request retries without optional flags, keeping the old container parked", async () => {
    const fake = await arrange({ failGpu: true });
    try {
        expect((await fake.run()).status).toBe(0);
        const state = await fake.state();
        expect(state.containers).toEqual({ box: "new", "box-previous": "old" });
        expect(state.calls.filter((call) => call[0] === "run")).toEqual([
            ["run", "--gpus=all", "img"],
            ["run", "img"],
        ]);
        expect(state.calls.findIndex((call) => call[0] === "rename")).toBeLessThan(state.calls.findIndex((call) => call[0] === "run"));
    } finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});

test.each([{ failAll: true }, { notReady: true }])("a failed launch or readiness gate restores the predecessor: %j", async (options) => {
    const fake = await arrange(options);
    try {
        expect((await fake.run()).status).toBe(1);
        const state = await fake.state();
        expect(state.containers).toEqual({ box: "old" });
        expect(state.calls.at(-1)).toEqual(["start", "box"]);
    } finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});

test("probation restores a crashing replacement after apply has returned", async () => {
    const fake = await arrange();
    try {
        expect((await fake.run()).status).toBe(0);
        const state = await fake.state();
        state.crash = true;
        await writeFile(fake.stateFile, JSON.stringify(state));
        const watched = spawnSync("sh", [join(fake.dir, "watch.sh")], { env: { ...fake.env, expected: "new" }, encoding: "utf8" });
        expect(watched.status).toBe(1);
        expect((await fake.state()).containers).toEqual({ box: "old" });
    } finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});

test("an older probation watch never rolls back a later deployment", async () => {
    const fake = await arrange();
    try {
        expect((await fake.run()).status).toBe(0);
        const watched = spawnSync("sh", [join(fake.dir, "watch.sh")], { env: { ...fake.env, expected: "superseded" }, encoding: "utf8" });
        expect(watched.status).toBe(0);
        expect((await fake.state()).containers).toEqual({ box: "new", "box-previous": "old" });
    } finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});

// The version in place, stopped on purpose (an owner's docker stop) while still on probation, read as a failed one: the
// next apply put back its 24-hour-old predecessor, destroyed the stopped version, and parked the older one as the way back.
test("a deliberately stopped version on probation stays the way back", async () => {
    const fake = await arrange({ containers: { box: "current", "box-previous": "old" }, stopped: ["current"] });
    try {
        expect((await fake.run()).status).toBe(0);
        expect((await fake.state()).containers).toEqual({ box: "new", "box-previous": "current" });
    } finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
