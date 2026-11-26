import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceStackManagedDeployInput, DeviceStacks } from "@intentic/sandbox-contract/schemas/device-stacks";
import type { DeviceFeature } from "@intentic/sandbox-contract/schemas/hosts";
import type { StackGrant } from "@intentic/sandbox-contract/schemas/stack-grants";
import { gitOut } from "../../harness/route-fakes.testing.js";
import { markerFor } from "../../secrets/marks/secret-marks.js";
import type { SecretUse } from "../../secrets/secret-uses.js";
import { memoryStackGrants } from "../../secrets/stack-grants/stack-grants.js";
import { STACK_DEVICE, stackDevice, type ToolAnswer, type ToolCall } from "./device-stacks.testing.js";
import { deployManaged, type ManagedDeployDeps } from "./managed-deploy.js";

// A managed deploy against real git and the fake computer (device-stacks.testing.ts): the grant checked before anything
// is filled, the `.env` and logins as the machine receives them, the marks and names it answers, how each way it can end
// reads by status, and that no secret value is in an answer, an error or the uses log.

let root: string;
let head: string;

const MANAGED: readonly DeviceFeature[] = ["stacks", "programs", "stacks-managed"];
const MARK_KEY = Buffer.alloc(32, 3);
// Values chosen to be found if they leak anywhere.
const STORED = { DB_PASSWORD: "pw-Zq8$x'y\"z", REGISTRY_PAT: "ghp_regpat0000xyz" } as const;
const HELD = new Map<string, string>(Object.entries(STORED));

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "intentic-managed-deploy-"));
    const dir = join(root, "shop");
    await mkdir(dir, { recursive: true });
    await gitOut(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "compose.yaml"), "services:\n  web:\n    image: ghcr.io/o/web:main\n");
    await gitOut(dir, "add", "-A");
    await gitOut(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work");
    head = await gitOut(dir, "rev-parse", "HEAD");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const NO_STACKS: DeviceStacks = { root: "/home/me/.intentic/stacks", stacks: [] };

// The machine: no stacks listed unless a suite says, and a deploy that came up and printed `printed`.
const machine =
    (over: { readonly stacks?: DeviceStacks; readonly deploy?: (call: ToolCall) => ToolAnswer; readonly printed?: string } = {}) =>
    async (call: ToolCall): Promise<ToolAnswer> => {
        if (call.tool === "list_stacks") {
            return { text: JSON.stringify(over.stacks ?? NO_STACKS) };
        }
        if (call.tool === "deploy_stack") {
            return over.deploy?.(call) ?? { text: JSON.stringify({ path: "/home/me/.intentic/stacks/web", output: over.printed ?? "", envDigest: "abc", healthySeconds: 4 }) };
        }
        return { text: "" };
    };

const fixture = (options: { readonly features?: readonly DeviceFeature[]; readonly tool?: (call: ToolCall) => Promise<ToolAnswer>; readonly grants?: readonly StackGrant[] } = {}) => {
    const computer = stackDevice({ root, features: options.features ?? MANAGED, tool: options.tool ?? machine() });
    const uses: SecretUse[] = [];
    const fetched: string[] = [];
    const deps: ManagedDeployDeps = {
        device: computer.services,
        grants: memoryStackGrants(options.grants ?? [{ repo: "shop", stack: "web", device: STACK_DEVICE, secrets: ["DB_PASSWORD", "REGISTRY_PAT"], grantedAt: "2026-11-25T00:00:00.000Z" }]),
        secrets: { own: async (name) => HELD.get(name), heldElsewhere: async () => undefined, gates: async () => [] },
        marks: { marker: async () => markerFor(MARK_KEY) },
        uses: {
            record: async (use) => {
                uses.push(use);
            },
        },
        fetchRemote: async (dir) => {
            fetched.push(dir);
            return "it has no remote";
        },
        now: () => 1_700_000_000_000,
    };
    return { ...computer, deps, uses, fetched };
};

const INPUT: DeviceStackManagedDeployInput = {
    id: STACK_DEVICE,
    name: "web",
    repo: "shop",
    mode: "images",
    env: { DB_PASSWORD: "{{secret:DB_PASSWORD}}", TAG: "0123abcd" },
    registries: [{ host: "ghcr.io", username: "ci", password: "{{secret:REGISTRY_PAT}}" }],
    health: { timeoutSeconds: 60, http: [] },
};

const noValueIn = (text: string): void => {
    for (const value of Object.values(STORED)) {
        expect(text).not.toContain(value);
    }
};

test("the stack's .env and logins reach deploy_stack filled, and the answer names and marks each secret without a value", async () => {
    const { deps, tools, uses } = fixture({ tool: machine({ printed: `logged in as ci with ${STORED.REGISTRY_PAT}` }) });

    const answer = await deployManaged(deps, INPUT);

    const mark = markerFor(MARK_KEY);
    expect(answer).toEqual({
        stack: "web",
        commit: head,
        path: "/home/me/.intentic/stacks/web",
        output: "logged in as ci with {{secret:REGISTRY_PAT}}",
        envDigest: "abc",
        healthySeconds: 4,
        secretNames: ["DB_PASSWORD", "REGISTRY_PAT"],
        secretMarks: { DB_PASSWORD: mark("DB_PASSWORD", STORED.DB_PASSWORD), REGISTRY_PAT: mark("REGISTRY_PAT", STORED.REGISTRY_PAT) },
    });
    noValueIn(JSON.stringify(answer));
    const deployed = tools.find((call) => call.tool === "deploy_stack");
    expect(deployed?.args).toEqual({
        source: expect.stringMatching(/^\/home\/me\/\.intentic\/runs\/stack-web\//u),
        name: "web",
        composeFile: "compose.yaml",
        commit: head,
        mode: "images",
        env: `DB_PASSWORD="pw-Zq8$$x'y\\"z"\nTAG=0123abcd\n`,
        registries: [{ host: "ghcr.io", username: "ci", password: STORED.REGISTRY_PAT }],
        health: { timeoutSeconds: 60, http: [] },
    });
    expect(uses).toEqual([
        { name: "DB_PASSWORD", lane: "deploy", detail: "web on rog", at: 1_700_000_000_000 },
        { name: "REGISTRY_PAT", lane: "deploy", detail: "web on rog", at: 1_700_000_000_000 },
    ]);
});

test("names the grant does not cover are refused by name before anything is filled, listed or carried", async () => {
    const { deps, tools, staging, uses } = fixture({
        grants: [{ repo: "shop", stack: "web", device: STACK_DEVICE, secrets: ["DB_PASSWORD"], grantedAt: "2026-11-25T00:00:00.000Z" }],
    });
    const refusal = deployManaged(deps, { ...INPUT, env: { ...INPUT.env, API: "{{secret:API_TOKEN}}" } });
    await expect(refusal).rejects.toMatchObject({
        code: "FORBIDDEN",
        message:
            `"API_TOKEN" and "REGISTRY_PAT" are not granted to "web" from "shop" on "rog": only the owner lets a stack receive a secret ` +
            "(`secrets grant-stack shop web rog API_TOKEN REGISTRY_PAT` asks them on a card).",
    });
    expect([tools, staging, uses]).toEqual([[], [], []]);
});

test("a value that cannot be filled is refused before the machine is asked, in words with no value in them", async () => {
    const { deps, tools, staging } = fixture({ grants: [{ repo: "shop", stack: "web", device: STACK_DEVICE, secrets: ["NOWHERE"], grantedAt: "2026-11-25T00:00:00.000Z" }] });
    await expect(deployManaged(deps, { ...INPUT, env: { A: "{{secret:NOWHERE}}" }, registries: [] })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: `No secret named "NOWHERE" is stored in this sandbox: store it (\`secrets ask NOWHERE\`, or \`secrets import NOWHERE --stdin\`), then deploy again.`,
    });
    expect([tools, staging]).toEqual([[], []]);
});

test("an agent that cannot take a managed stack is refused before anything is read, packed or carried", async () => {
    const { deps, tools, staging } = fixture({ features: ["stacks", "programs"] });
    await expect(deployManaged(deps, INPUT)).rejects.toMatchObject({
        code: "CONFLICT",
        message: `The agent on "${STACK_DEVICE}" is too old to take a stack this sandbox manages (its .env, registry logins, hooks, health checks and image pins): update it there (\`intentic-machine upgrade\`, or Update on its Devices card), then try again.`,
    });
    expect([tools, staging]).toEqual([[], []]);
});

test("a stack another sandbox deployed there is refused, and nothing is carried to it", async () => {
    const owned: DeviceStacks = {
        ...NO_STACKS,
        stacks: [{ name: "web", status: "running(1)", configFiles: [], managed: true, owner: { sandbox: "https://other.example.dev", you: false }, sandbox: false, services: [] }],
    };
    const { deps, staging, uses } = fixture({ tool: machine({ stacks: owned }) });
    await expect(deployManaged(deps, INPUT)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: `"web" on "rog" was deployed by another sandbox (https://other.example.dev): only that one may deploy it. Deploy it under another name, or have it taken down there first.`,
    });
    expect([staging, uses]).toEqual([[], []]);
});

test("the machine's own word that the deploy failed is 422, with every value it echoed put back as its reference", async () => {
    const said = `hook failed: echo ${STORED.DB_PASSWORD}`;
    const { deps } = fixture({ tool: machine({ deploy: () => ({ text: said, refused: true }) }) });
    const failure = await deployManaged(deps, INPUT).then(
        () => undefined,
        (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "UNPROCESSABLE_CONTENT", message: "hook failed: echo {{secret:DB_PASSWORD}}" });
    noValueIn(failure instanceof Error ? failure.message : "");
});

test("a named commit resolves to its full sha, and one the checkout lacks is fetched for before it is refused", async () => {
    const { deps, tools, fetched } = fixture();
    expect((await deployManaged(deps, { ...INPUT, commit: head.slice(0, 9) })).commit).toBe(head);
    await expect(deployManaged(deps, { ...INPUT, commit: "deadbeef00" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: `"shop" has no commit deadbeef00 here, and fetching its remote failed: it has no remote`,
    });
    expect(fetched).toEqual([join(root, "shop")]);
    expect(tools.filter((call) => call.tool === "deploy_stack")).toHaveLength(1);
});
