import "@intentic/testing/dom";
import type { DeviceSandboxGroup } from "@intentic/ui";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

// What the Devices page puts on its face (face.ts): Open on a sandbox the platform knows and that answers, into the
// workspace on that sandbox (or the face, which the app decides: machine_face.rs `local_sandbox_open`), and on one it
// never named that the face can open; and the masthead's ⋯, which holds Restart only while the agent is well. The app
// is Tauri's own IPC mock, answering for one signed-in PC with a running sandbox the platform named and one it never did.

// The kit's device readout (reached through ./machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

const SANDBOXES = [
    { slug: `574ea8038415`, container: `c1`, name: `shop`, running: true, image: `img`, platformId: `cm1shop` },
    { slug: `sandbox-82789f4106b4`, container: `c2`, running: true, image: `img`, platformId: null, sandboxId: `82789f4106b4`, localPort: 30559 },
    { slug: `8a8171848c91`, container: `c3`, name: `research`, running: false, image: `img`, platformId: `cm2research` },
];

const SIGNED_IN = { status: 200, body: JSON.stringify({ user: { email: `ada@example.com` }, session: {} }) };

const reportWith = (agentRunning: boolean): string =>
    JSON.stringify({
        version: `1.360.0`,
        summary: ``,
        device: { links: [] },
        sync: { hostname: `rog`, os: `win32`, pairings: [], ports: [], agent: { running: agentRunning, installed: `1.360.0`, build: `1.360.0` }, capturedAt: Date.now() },
    });

const machineWith = (agentRunning: boolean, session: { status: number; body: string } = SIGNED_IN) => {
    // Each local_sandbox_open's arguments as the app would receive them, and each sign-in asked for.
    const opened: string[] = [];
    const signIns: unknown[] = [];
    mockIPC((command, args) => {
        switch (command) {
            case `local_roster`:
                return { account: { email: `ada@example.com`, name: null }, sandboxes: [] };
            case `docker_listening`:
                return true;
            case `sandbox_list`:
                return SANDBOXES;
            case `machine_report`:
                return reportWith(agentRunning);
            case `machine_agents`:
                return [];
            case `account_relay`:
                return session;
            case `local_sandbox_open`:
                opened.push(JSON.stringify(args));
                return null;
            case `sign_in`:
                signIns.push(args);
                return null;
            default:
                return null;
        }
    });
    return { opened, signIns };
};

// One window's store, read again against whatever the mock answers now: face.ts reads the very same machine and roster.
const load = async () => {
    const [machine, roster, face] = await Promise.all([import(`./machine`), import(`./roster`), import(`./face`)]);
    await Promise.all([machine.refresh(), roster.followRoster()]);
    return { machine, face };
};

const groupOf = (machine: Awaited<ReturnType<typeof load>>[`machine`], slug: string): DeviceSandboxGroup => {
    const group = machine.groups.value.find((candidate) => candidate.sandbox?.slug === slug);
    if (group === undefined) {
        throw new Error(`no card for ${slug}`);
    }
    return group;
};

afterEach(() => clearMocks());

it(`offers Open on a running sandbox the platform named, and opens the workspace on it, or the face on it by the same id`, async () => {
    const { opened } = machineWith(true);
    const { machine, face } = await load();
    expect(face.openable(groupOf(machine, `574ea8038415`))).toBe(true);
    // Never named by the platform, on a build without the face: there is nothing to open it in.
    expect(face.openable(groupOf(machine, `sandbox-82789f4106b4`))).toBe(false);
    // Stopped: its card offers Start instead, since the workspace would only find it down.
    expect(face.openable(groupOf(machine, `8a8171848c91`))).toBe(false);
    await face.openSandbox(groupOf(machine, `574ea8038415`));
    // The app decides between the two: the workspace at the path while it answers, the face on the key while it does not.
    expect(opened).toEqual([JSON.stringify({ path: `/?sandbox=cm1shop`, sandbox: `cm1shop` })]);
});

it(`offers Open on a running sandbox the platform never named where the face can open it, and opens it there`, async () => {
    const { opened } = machineWith(true);
    const { machine, face } = await load();
    machine.info.value = {
        version: `1.360.0`,
        os: `windows`,
        appUrl: `https://app.intentic.dev`,
        platformUrl: `https://api.intentic.dev`,
        installId: `install-1`,
        analyticsAllowed: false,
        engineLimitSeconds: 150,
        fixLimitSeconds: 600,
    };
    try {
        expect(face.openable(groupOf(machine, `sandbox-82789f4106b4`))).toBe(true);
        // Stopped, it still has nothing to answer on.
        expect(face.openable(groupOf(machine, `8a8171848c91`))).toBe(false);
        await face.openSandbox(groupOf(machine, `sandbox-82789f4106b4`));
        expect(opened).toEqual([JSON.stringify({ path: null, sandbox: `machine-82789f4106b4` })]);
    } finally {
        machine.info.value = undefined;
    }
});

it(`asks for a sign-in instead when the platform answers that nobody is signed in`, async () => {
    const { opened, signIns } = machineWith(true, { status: 401, body: `{}` });
    const { machine, face } = await load();
    await face.openSandbox(groupOf(machine, `574ea8038415`));
    expect(signIns).toHaveLength(1);
    expect(opened).toEqual([]);
});

it(`keeps Restart behind the masthead's ⋯ while the agent is well, and hands it back to the face when it is not`, async () => {
    machineWith(true);
    const settled = await load();
    expect(settled.face.agentSettled.value).toBe(true);
    expect(settled.face.useMastheadMenu(async () => undefined).value.map((verb) => verb.label)).toEqual([`Restart agent`]);

    machineWith(false);
    const stopped = await load();
    expect(stopped.face.agentSettled.value).toBe(false);
    expect(stopped.face.useMastheadMenu(async () => undefined).value).toEqual([]);
});
