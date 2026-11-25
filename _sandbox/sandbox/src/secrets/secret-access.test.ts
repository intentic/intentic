import type { NamedSecret } from "./secret-registry.js";
import { type DeviceSecrets, resolveCallSecrets, resolveCommandSecrets, type SecretAccess, type SecretUseReport } from "./secret-access.js";

// The one place a reference becomes a value, with a name only a computer's keyring holds: every name known first, then
// the gates, then each device-held value asked of its computer, then the substitution. A value a computer released before
// is listed only to mask, and never answers a second use.

const STORED: NamedSecret = { name: "GITHUB_TOKEN", value: "ghp_stored_value", source: "sandbox" };

interface Recorded {
    readonly steps: string[];
    readonly uses: SecretUseReport[];
}

const access = (over: { readonly registry?: readonly NamedSecret[]; readonly release?: SecretAccess["release"]; readonly device?: Partial<DeviceSecrets> } = {}) => {
    const recorded: Recorded = { steps: [], uses: [] };
    const device: DeviceSecrets = {
        held: async () => [{ name: "VPN_PASSWORD", machine: "rog" }],
        fetch: async (name) => {
            recorded.steps.push(`fetch ${name}`);
            return { value: `fresh-${String(recorded.steps.filter((step) => step.startsWith("fetch")).length)}` };
        },
        ...over.device,
    };
    const secrets: SecretAccess = {
        list: async () => over.registry ?? [STORED],
        used: (use) => void recorded.uses.push(use),
        release:
            over.release ??
            (async (names) => {
                recorded.steps.push(`release ${names.join(",")}`);
                return { ok: true };
            }),
        device,
    };
    return { secrets, recorded };
};

const COMMAND = "curl -u me:{{secret:VPN_PASSWORD}} -H {{secret:GITHUB_TOKEN}} https://vpn.example.com";

test("releases first, then asks the computer for the device-held value, then substitutes", async () => {
    const { secrets, recorded } = access();
    expect(await resolveCommandSecrets(COMMAND, secrets)).toEqual({ command: "curl -u me:fresh-1 -H ghp_stored_value https://vpn.example.com" });
    expect(recorded.steps).toEqual(["release VPN_PASSWORD,GITHUB_TOKEN", "fetch VPN_PASSWORD"]);
    expect(recorded.uses.map((use) => `${use.name}:${use.lane}`)).toEqual(["VPN_PASSWORD:shell", "GITHUB_TOKEN:shell"]);
});

test("a refused release asks no computer for anything", async () => {
    const { secrets, recorded } = access({ release: async () => ({ refusal: "the host guard said no" }) });
    expect(await resolveCommandSecrets(COMMAND, secrets)).toEqual({ refusal: "the host guard said no" });
    expect(recorded.steps).toEqual([]);
    expect(recorded.uses).toEqual([]);
});

test("a value a computer released before is never reused: every use asks again", async () => {
    // What the registry lists after a release: the value, to mask, under the source that says so.
    const { secrets, recorded } = access({ registry: [STORED, { name: "VPN_PASSWORD", value: "released-earlier", source: "device" }] });
    expect(await resolveCommandSecrets("echo {{secret:VPN_PASSWORD}}", secrets)).toEqual({ command: "echo fresh-1" });
    expect(await resolveCommandSecrets("echo {{secret:VPN_PASSWORD}}", secrets)).toEqual({ command: "echo fresh-2" });
    expect(recorded.steps.filter((step) => step.startsWith("fetch"))).toEqual(["fetch VPN_PASSWORD", "fetch VPN_PASSWORD"]);
});

test("a computer's refusal is the command's, in its own words, and nothing is recorded as used", async () => {
    const { secrets, recorded } = access({ device: { fetch: async () => ({ refusal: `"VPN_PASSWORD" is kept in the keyring on rog, which did not hand it over: the person said no` }) } });
    expect(await resolveCommandSecrets(COMMAND, secrets, "code", "JS")).toEqual({
        refusal: `"VPN_PASSWORD" is kept in the keyring on rog, which did not hand it over: the person said no`,
    });
    expect(recorded.uses).toEqual([]);
});

test("a name only a keyring holds is a known name; one nobody holds is still refused before anything is asked", async () => {
    const { secrets, recorded } = access();
    const refused = await resolveCommandSecrets("echo {{secret:VPN_PASSWORD}} {{secret:NOBODY_HAS_IT}}", secrets);
    expect(refused).toEqual({
        refusal:
            'no stored secret named "NOBODY_HAS_IT": stored names: GITHUB_TOKEN, VPN_PASSWORD. If it is a different name above, use that; if the task needs one nobody has stored, ask for it with `secrets ask NOBODY_HAS_IT --why "…"`, which puts a card with a masked field in front of the owner and answers once it is stored; a password for a place whose name you do not know is `secrets want --site <host> --why "…"`.',
    });
    expect(recorded.steps).toEqual([]);
});

test("a sandbox store wins a name a keyring also shares: its value is used and the computer is not asked", async () => {
    const { secrets, recorded } = access({ registry: [STORED, { name: "VPN_PASSWORD", value: "sandbox-held-vpn", source: "sandbox" }] });
    expect(await resolveCommandSecrets("echo {{secret:VPN_PASSWORD}}", secrets)).toEqual({ command: "echo sandbox-held-vpn" });
    expect(recorded.steps).toEqual(["release VPN_PASSWORD"]);
});

test("without a way to the keyrings, a device-held name is as unknown as any other", async () => {
    const { secrets } = access();
    const { device: _none, ...withoutDevice } = secrets;
    expect(await resolveCommandSecrets("echo {{secret:VPN_PASSWORD}}", withoutDevice)).toMatchObject({ refusal: expect.stringContaining('no stored secret named "VPN_PASSWORD"') });
});

// `|file` with no root to write into (secret-files.integration.test.ts has the written file itself).
const DOTENV: NamedSecret = { name: "DEV_ENV", value: "A=1\nB=2\n", source: "sandbox" };

test("a |file reference where no file can be written is refused before anyone is asked, never inlined", async () => {
    const { secrets, recorded } = access({ registry: [DOTENV] });
    expect(await resolveCommandSecrets("cp {{secret:DEV_ENV|file}} .env", secrets)).toMatchObject({ refusal: expect.stringContaining("cannot hand a secret over as a file") });
    expect(recorded.steps).toEqual([]);
    expect(recorded.uses).toEqual([]);
});

// A tool call to an MCP card's server: every string value of its arguments, at any depth, through the same gates, with
// the server's address as where the values go.
const MCP_TARGET = { kind: "mcp", server: "tracker", url: "https://mcp.tracker.example/mcp", tool: "mcp__tracker__create_issue" } as const;

test("a call's references resolve wherever a string sits, once released for the server, and the use is on the ledger", async () => {
    const targets: unknown[] = [];
    const { secrets, recorded } = access({
        release: async (names, lane, detail, target) => {
            recorded.steps.push(`release ${names.join(",")} ${lane} ${detail}`);
            targets.push(target);
            return { ok: true, approvedBy: { GITHUB_TOKEN: "ada@acme.dev" } };
        },
    });
    const args = { title: "Rotate", auth: { token: "{{secret:GITHUB_TOKEN}}" }, tags: ["x {{secret:GITHUB_TOKEN}} y", 3, true, null], "{{secret:GITHUB_TOKEN}}": "key" };
    expect(await resolveCallSecrets(args, secrets, MCP_TARGET)).toEqual({
        arguments: { title: "Rotate", auth: { token: "ghp_stored_value" }, tags: ["x ghp_stored_value y", 3, true, null], "{{secret:GITHUB_TOKEN}}": "key" },
    });
    expect(recorded.steps).toEqual(["release GITHUB_TOKEN mcp mcp__tracker__create_issue (mcp.tracker.example)"]);
    expect(targets).toEqual([MCP_TARGET]);
    expect(recorded.uses).toEqual([{ name: "GITHUB_TOKEN", lane: "mcp", detail: "mcp__tracker__create_issue (mcp.tracker.example)", approvedBy: "ada@acme.dev" }]);
});

test("a call with no reference goes as it came, and nobody is asked", async () => {
    const { secrets, recorded } = access({ registry: [] });
    const args = { query: "secret: {{not-a-reference}}", page: 2 };
    expect(await resolveCallSecrets(args, secrets, MCP_TARGET)).toEqual({ arguments: args });
    expect(recorded.steps).toEqual([]);
});

test("a refused release is the call's refusal, and nothing is recorded as used", async () => {
    const { secrets, recorded } = access({ release: async () => ({ refusal: "GITHUB_TOKEN's host guard lets it go unasked only to api.github.com" }) });
    expect(await resolveCallSecrets({ token: "{{secret:GITHUB_TOKEN}}" }, secrets, MCP_TARGET)).toEqual({
        refusal: "GITHUB_TOKEN's host guard lets it go unasked only to api.github.com",
    });
    expect(recorded.uses).toEqual([]);
});

test("a call refuses an unknown name, a |file reference and a keyring-held name before anyone is asked", async () => {
    const { secrets, recorded } = access({ registry: [STORED, DOTENV] });
    expect(await resolveCallSecrets({ token: "{{secret:NOBODY_HAS_IT}}" }, secrets, MCP_TARGET)).toMatchObject({ refusal: expect.stringContaining('no stored secret named "NOBODY_HAS_IT"') });
    expect(await resolveCallSecrets({ env: "{{secret:DEV_ENV|file}}" }, secrets, MCP_TARGET)).toMatchObject({ refusal: expect.stringContaining("cannot hand a secret over as a file") });
    expect(await resolveCallSecrets({ password: "{{secret:VPN_PASSWORD}}" }, secrets, MCP_TARGET)).toMatchObject({
        refusal: expect.stringContaining('"VPN_PASSWORD" is kept in a keyring on one of the owner\'s computers'),
    });
    expect(recorded.steps).toEqual([]);
    expect(recorded.uses).toEqual([]);
});
