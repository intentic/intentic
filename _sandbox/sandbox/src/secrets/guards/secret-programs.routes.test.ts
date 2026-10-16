import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { errorCode, rejectForbidden } from "../../harness/route-client.testing.js";
import { fakeDevices, fakeKeyring, pointerOf } from "../device/keyring.testing.js";
import type { ProgramWidenRequest, ProgramWidenVerdict } from "../gates/program-guard-gate.js";
import { createSecretProgramRoutes, type SecretProgramRoutesDeps } from "./secret-programs.routes.js";
import { secretsSliceFake } from "../secrets-slice.testing.js";

// Who may change a secret's program guard turns on the change, as for the host guard: taking a program off or turning
// any-field off is open to every caller the route admits; adding a program or an app, or turning any-field on, is the
// owner's, asked on a card when the agent's CLI wants it. A secret a computer's keyring holds keeps its list there.

interface Setup {
    readonly routes: ReturnType<typeof createSecretProgramRoutes>;
    readonly slice: ReturnType<typeof secretsSliceFake>;
    readonly widened: ProgramWidenRequest[];
}

const setup = async (options: { readonly owner: boolean; readonly widen?: ProgramWidenVerdict }): Promise<Setup> => {
    const rog = fakeKeyring([pointerOf("VPN_PASSWORD", { programs: ["FortiClient.exe"] })]);
    const slice = secretsSliceFake(fakeDevices({ rog }));
    await slice.keyringLink.refresh();
    await slice.sandboxSecrets.set("RDP_PASSWORD", "rdp-password-value");
    const widened: ProgramWidenRequest[] = [];
    const deps: SecretProgramRoutesDeps = {
        auth: options.owner ? undefined : unstubbed<NonNullable<SecretProgramRoutesDeps["auth"]>>("auth", { authorizeOwner: rejectForbidden }),
        secretRegistry: slice.secretRegistry,
        secretProgramGuards: slice.secretProgramGuards,
        deviceSecrets: slice.deviceSecrets,
        programGuardGate: {
            widen: async (request) => {
                widened.push(request);
                return options.widen ?? { refusal: "nobody was asked" };
            },
        },
    };
    return { routes: createSecretProgramRoutes(deps), slice, widened };
};

const signedIn: OrpcContext = { headers: new Headers(), method: "PUT", url: "/secrets/programs/RDP_PASSWORD" };
const agentCli: OrpcContext = { ...signedIn, headers: new Headers({ "x-intentic-agent": "agent-token", "x-intentic-conversation": "conv-7" }) };

const MSTSC = { subject: "RDP_PASSWORD", programs: ["mstsc.exe"], packages: [], anyField: false };

test("anybody the route admits may take programs off and turn any-field off, asking nobody", async () => {
    const { routes, slice, widened } = await setup({ owner: false });
    await slice.secretProgramGuards.set("RDP_PASSWORD", { programs: ["mstsc.exe", "putty.exe"], packages: ["com.microsoft.rdc.androidx"], anyField: true });
    expect(await call(routes.setPrograms, MSTSC, { context: signedIn })).toEqual({ programs: ["mstsc.exe"], packages: [], anyField: false });
    expect(await call(routes.programs, undefined, { context: signedIn })).toEqual({ guards: [MSTSC] });
    // Down to nothing, it asks before every typing, which is what no list at all means.
    await call(routes.setPrograms, { ...MSTSC, programs: [] }, { context: signedIn });
    expect(await call(routes.programs, undefined, { context: signedIn })).toEqual({ guards: [] });
    expect(widened).toEqual([]);
});

test("adding a program or turning any-field on is refused to a signed-in person who is not the owner, and nothing changes", async () => {
    const { routes, slice } = await setup({ owner: false });
    expect(await errorCode(call(routes.setPrograms, MSTSC, { context: signedIn }))).toBe("FORBIDDEN");
    await slice.secretProgramGuards.set("RDP_PASSWORD", { programs: ["mstsc.exe"], packages: [], anyField: false });
    expect(await errorCode(call(routes.setPrograms, { ...MSTSC, anyField: true }, { context: signedIn }))).toBe("FORBIDDEN");
    expect(await slice.programGuardFor("RDP_PASSWORD")).toEqual({ programs: ["mstsc.exe"], packages: [], anyField: false });
});

test("a widening from the agent's CLI asks the owner in its conversation, and is stored only on their yes", async () => {
    const approved = await setup({ owner: false, widen: { approvedBy: "owner@corp.com" } });
    expect(await call(approved.routes.setPrograms, MSTSC, { context: agentCli })).toEqual({ programs: ["mstsc.exe"], packages: [], anyField: false, approvedBy: "owner@corp.com" });
    expect(approved.widened).toEqual([
        {
            subject: "RDP_PASSWORD",
            from: { programs: [], packages: [], anyField: false },
            to: { programs: ["mstsc.exe"], packages: [], anyField: false },
            conversationId: "conv-7",
            signal: expect.any(AbortSignal),
        },
    ]);
    const declined = await setup({ owner: false, widen: { refusal: "The owner kept RDP_PASSWORD's program guard as it is." } });
    expect(await errorCode(call(declined.routes.setPrograms, MSTSC, { context: agentCli }))).toBe("FORBIDDEN");
    expect(await declined.slice.programGuardFor("RDP_PASSWORD")).toEqual({ programs: [], packages: [], anyField: false });
});

test("the owner widens without a card; a program already listed in another case is no widening", async () => {
    const { routes, widened, slice } = await setup({ owner: true });
    await call(routes.setPrograms, MSTSC, { context: signedIn });
    const other = await setup({ owner: false });
    await other.slice.secretProgramGuards.set("RDP_PASSWORD", { programs: ["mstsc.exe"], packages: [], anyField: false });
    expect(await call(other.routes.setPrograms, { ...MSTSC, programs: ["MSTSC.EXE"] }, { context: signedIn })).toEqual({ programs: ["MSTSC.EXE"], packages: [], anyField: false });
    expect([widened, other.widened, await slice.programGuardFor("RDP_PASSWORD")]).toEqual([[], [], { programs: ["mstsc.exe"], packages: [], anyField: false }]);
});

test("a secret a computer's keyring holds is changed on that computer, and a name nothing holds is not found", async () => {
    const { routes } = await setup({ owner: true });
    await expect(call(routes.setPrograms, { subject: "VPN_PASSWORD", programs: [], packages: [], anyField: false }, { context: signedIn })).rejects.toThrow(
        "VPN_PASSWORD is kept in the keyring on rog, which keeps its program list: change it on rog: intentic-machine keyring edit VPN_PASSWORD",
    );
    expect(await errorCode(call(routes.setPrograms, { subject: "NOPE", programs: [], packages: [], anyField: false }, { context: signedIn }))).toBe("NOT_FOUND");
});
