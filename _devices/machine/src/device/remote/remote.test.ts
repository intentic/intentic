import { DeviceScopesSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { ORPCError } from "@orpc/server";
import { peopleItems, uplinkItems } from "./commands.js";
import { createRemote, NOTHING_ALLOWED, onScreen, peopleMoved, type RemoteSeams } from "./remote.js";
import type { RemotedPerson } from "./remoted-files.js";

/* The coordinator's decisions that need no remoted: the refusal while a link lets people do nothing, and who came and
   went between two statuses. The process and its config are remote.integration.test.ts's. */

const ALPHA = "https://alpha.example.dev";

// Every seam that would reach past the refusal throws with its own name, so a refusal that touched anything says what.
const untouched = (audited: { tool: string; ok: boolean; detail: string }[]): RemoteSeams => {
    const reached = (what: string) => () => {
        throw new Error(`${what} was reached`);
    };
    return {
        binary: reached("the binary"),
        resolveBase: reached("the sandbox's address"),
        spawn: reached("spawn"),
        paused: reached("the pause"),
        people: reached("the notice"),
        audit: async (entry) => void audited.push(entry),
        configPath: "/nonexistent/remoted.json",
        statusPath: "/nonexistent/remoted-status.json",
        now: () => 0,
    };
};

test("a link whose three people switches are all off is refused as FORBIDDEN, naming them, before anything is touched", async () => {
    const audited: { tool: string; ok: boolean; detail: string }[] = [];
    const remote = createRemote(untouched(audited), () => undefined);
    // The agents' switches all on: none of them is a people switch.
    const scopes = DeviceScopesSchema.parse({
        shell: "on",
        write: "on",
        screen: "on",
        control: "on",
        sandboxes: "on",
        destructive: "on",
        programs: "on",
    });
    const started = remote.start(
        { sandboxUrl: ALPHA, scopes, log: () => undefined },
        { device: "rog", uplinkToken: "secret-token", mediaKey: "k".repeat(43) },
    );
    await expect(started).rejects.toBeInstanceOf(ORPCError);
    await expect(started).rejects.toMatchObject({ code: "FORBIDDEN", message: NOTHING_ALLOWED });
    expect(NOTHING_ALLOWED).toBe(
        'Refused: "Let people see the screen", "Let people use the mouse and keyboard" and "Let people open terminals" are all switched off for this device. Turn one on in its capability card to let people reach it.',
    );
    // Audited without the token or the key.
    expect(audited).toEqual([
        {
            tool: "remoteStart",
            ok: false,
            detail: "alpha.example.dev as device rog, view off, control off, terminals off: refused, every people switch is off",
        },
    ]);
});

test("a grant pushed on a link that holds no uplink touches nothing", async () => {
    const audited: { tool: string; ok: boolean; detail: string }[] = [];
    const remote = createRemote(untouched(audited), () => undefined);
    await remote.scopesChanged(ALPHA, DeviceScopesSchema.parse({ remoteView: "on" }));
    expect(audited).toEqual([]);
});

describe("people between two statuses", () => {
    const one = (kind: string, session: string, uplink = ALPHA): RemotedPerson => ({ uplink, kind, session, readOnly: false, since: 1 });

    test("a session is the same person while its uplink, kind and id stay, and a new one otherwise", () => {
        const before = [one("terminal", "t-1"), one("view", "v-1")];
        const after = [one("terminal", "t-1"), one("control", "v-1"), one("terminal", "t-1", "https://beta.example.dev")];
        expect(peopleMoved(before, after)).toEqual({
            came: [one("control", "v-1"), one("terminal", "t-1", "https://beta.example.dev")],
            went: [one("view", "v-1")],
        });
        expect(peopleMoved(after, after)).toEqual({ came: [], went: [] });
    });

    test("a kind this agent does not know yet is shown as someone viewing", () => {
        expect(onScreen(one("control", "c-1"))).toEqual({ kind: "control", sandboxUrl: ALPHA });
        expect(onScreen(one("file-transfer", "f-1"))).toEqual({ kind: "view", sandboxUrl: ALPHA });
    });
});

test("`remote status` draws each uplink by its state, one a newer remoted names as something to look at, and each person", () => {
    const status = {
        type: "status" as const,
        version: "1.2.3",
        pid: 4242,
        uplinks: [
            { id: ALPHA, state: "up", since: 0 },
            { id: "https://beta.example.dev", state: "refused", since: 0, error: "HTTP 403" },
            { id: "https://gamma.example.dev", state: "parked", since: 0 },
        ],
        people: [{ uplink: ALPHA, kind: "terminal", session: "t-abc", readOnly: true, since: 0 }],
        terminals: 1,
        environments: ["native"],
        monitors: [],
    };
    expect(uplinkItems(status)).toEqual([
        { tone: "ok", name: "alpha.example.dev", meta: "up since 1970-01-01T00:00:00.000Z" },
        { tone: "fail", name: "beta.example.dev", meta: "refused since 1970-01-01T00:00:00.000Z: HTTP 403" },
        { tone: "warn", name: "gamma.example.dev", meta: "parked since 1970-01-01T00:00:00.000Z" },
    ]);
    expect(peopleItems(status)).toEqual([
        { tone: "ok", name: "terminal t-abc", meta: "from alpha.example.dev since 1970-01-01T00:00:00.000Z, read-only" },
    ]);
});
