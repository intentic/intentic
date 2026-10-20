import type { PeerLink } from "@intentic/sandbox-contract/peer-dial";
import type { HostLink } from "../device/config.js";
import { type KeptCheck, reconcileLinks, redialSandbox, stillKeeping } from "./resident.js";

const link = (url: string, token = `token-for-${url}`): HostLink => ({
    sandboxUrl: url,
    id: `device-for-${url}`,
    token,
    scopes: { shell: "off", write: "off", screen: "off", control: "off", sandboxes: "off", destructive: "off", programs: "off" },
});

// A stand-in socket per dial, recording whether it was closed or told to dial at once: the test reads which sandboxes are
// being dialled.
const dialer = () => {
    const dialled: string[] = [];
    const stopped: string[] = [];
    const retried: string[] = [];
    const dial = (held: HostLink): PeerLink =>
        ({
            done: new Promise(() => undefined),
            stop: () => void stopped.push(held.sandboxUrl),
            state: () => "open",
            outage: () => undefined,
            retryNow: () => void retried.push(held.sandboxUrl),
        }) as unknown as PeerLink;
    return {
        dialled,
        stopped,
        retried,
        dial: (held: HostLink) => {
            dialled.push(held.sandboxUrl);
            return dial(held);
        },
    };
};

// Setup, uninstall and a revocation all change the link list under a running agent; none of them may restart it.
describe("reconcileLinks", () => {
    it("dials a link that was added and closes one that was removed, leaving the rest connected", () => {
        const connections = new Map();
        const { dialled, stopped, dial } = dialer();
        reconcileLinks(connections, [link("https://one.example"), link("https://two.example")], dial, () => undefined);
        reconcileLinks(connections, [link("https://two.example"), link("https://three.example")], dial, () => undefined);

        expect(dialled).toEqual(["https://one.example", "https://two.example", "https://three.example"]);
        expect(stopped).toEqual(["https://one.example"]);
        expect([...connections.keys()].toSorted()).toEqual(["https://three.example", "https://two.example"]);
    });

    // A re-enrollment rotates the token; the old socket authenticated with the old one and must be replaced.
    it("redials a link whose enrollment changed", () => {
        const connections = new Map();
        const { dialled, stopped, dial } = dialer();
        reconcileLinks(connections, [link("https://one.example", "old")], dial, () => undefined);
        reconcileLinks(connections, [link("https://one.example", "rotated")], dial, () => undefined);

        expect(dialled).toEqual(["https://one.example", "https://one.example"]);
        expect(stopped).toEqual(["https://one.example"]);
    });

    // Scopes are pushed on every connect and written back to the same file; redialling for that would loop forever.
    it("leaves a connection alone when only its cached scopes changed", () => {
        const connections = new Map();
        const { dialled, stopped, dial } = dialer();
        reconcileLinks(connections, [link("https://one.example")], dial, () => undefined);
        reconcileLinks(
            connections,
            [{ ...link("https://one.example"), scopes: { ...link("https://one.example").scopes, shell: "on" } }],
            dial,
            () => undefined,
        );

        expect(dialled).toEqual(["https://one.example"]);
        expect(stopped).toEqual([]);
    });
});

// With nothing linked, paired or held, the agent stays only while this machine hosts a sandbox the keeper looks after:
// asked at once the first time, then at most every five minutes, and said when it starts to be the reason.
// The keeper has just woken a sandbox, or found it woken: its links are dialled now, not when their ladder comes round.
describe("redialSandbox", () => {
    it("tells every link naming the slug, by its hostname or by its sandbox id, to dial at once, and no other", () => {
        const connections = new Map();
        const { retried, dial } = dialer();
        const byHost = "https://sandbox-0123456789ab.sbx.intentic.dev";
        const other = "https://sandbox-fedcba987654.sbx.intentic.dev";
        reconcileLinks(connections, [link(byHost), link(other)], dial, () => undefined);
        redialSandbox(connections, "sandbox-0123456789ab");
        expect(retried).toEqual([byHost]);
        // ic names a sandbox with no public hostname by the id its connect token derives, which the hostname carries.
        redialSandbox(connections, "fedcba987654");
        expect(retried).toEqual([byHost, other]);
        redialSandbox(connections, "sandbox-not-linked");
        expect(retried).toEqual([byHost, other]);
    });
});

describe("stillKeeping", () => {
    const NOW = 1_800_000_000_000;

    it("asks at once when it never has, and says when the sandboxes here become the reason to stay", async () => {
        const lines: string[] = [];
        const asked: number[] = [];
        const check: KeptCheck = { at: Number.NEGATIVE_INFINITY, kept: [] };
        const ask = async () => {
            asked.push(NOW);
            return await Promise.resolve(["work"]);
        };
        expect(await stillKeeping(check, (line) => lines.push(line), { ask, now: () => NOW })).toBe(true);
        expect(asked).toEqual([NOW]);
        expect(lines).toEqual([
            "nothing is linked or paired here any more, but this device runs 1 sandbox (work), so the agent stays to bring it back after a restart; turning the sandbox keeper off lets it go.",
        ]);
    });

    it("keeps its answer for five minutes, then asks again and lets the agent go once nothing is hosted", async () => {
        const lines: string[] = [];
        let hosted: readonly string[] = [];
        const check: KeptCheck = { at: NOW, kept: ["work"] };
        const ask = async () => await Promise.resolve(hosted);
        expect(await stillKeeping(check, (line) => lines.push(line), { ask, now: () => NOW + 5 * 60_000 - 1 })).toBe(true);
        expect(await stillKeeping(check, (line) => lines.push(line), { ask, now: () => NOW + 5 * 60_000 })).toBe(false);
        hosted = ["work"];
        expect(await stillKeeping(check, (line) => lines.push(line), { ask, now: () => NOW + 5 * 60_000 + 1 })).toBe(false);
        expect(lines).toEqual([]);
    });
});
