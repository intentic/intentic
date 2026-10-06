import type { PushNotification } from "@intentic/sandbox-contract";
import type { TunnelReport } from "../netd/netd-link.js";
import type { PreviewDeps } from "../panels/preview-routes.js";
import { netdDoorRefusal, netdDoorServer, generationOf, tunnelReports } from "./netd-door.js";

describe(`the netd door's HTTP server`, () => {
    // A stall past a keep-alive timer let Node close a pooled socket netd had just written a request into; the
    // netd answered that request 502 (reproduced with a 5 s timer and an 8 s stall ending in the check phase).
    it(`leaves idleness and pace to netd, keeping no timer of its own`, () => {
        const server = netdDoorServer({} as PreviewDeps, { warn: () => undefined })({}, () => undefined);
        expect(server.keepAliveTimeout).toBe(0);
        expect(server.requestTimeout).toBe(0);
    });
});

describe(`who may take netd's sockets`, () => {
    const container = { role: { container: true, roots: true }, traits: { convergeHome: true } };
    const guest = { role: { container: false, roots: true }, traits: { convergeHome: true } };
    const netd = "/run/intentic/netd.sock";

    it(`lets the container's own daemon, and a local one, take them whatever else runs`, () => {
        expect(netdDoorRefusal({ ...container, controlPath: netd, ownerControlPath: () => netd })).toBeUndefined();
        const local = { role: { container: false, roots: true }, traits: { convergeHome: false } };
        expect(netdDoorRefusal({ ...local, controlPath: netd, ownerControlPath: () => netd })).toBeUndefined();
    });

    // 2026-10-05: a guest ran startNetdDoor, removed the owner's HTTP socket and listened in its place.
    it(`refuses a guest netd the live owner dials, or one it cannot tell`, () => {
        expect(netdDoorRefusal({ ...guest, controlPath: netd, ownerControlPath: () => netd })).toContain("guest");
        expect(netdDoorRefusal({ ...guest, controlPath: netd, ownerControlPath: () => null })).toContain("guest");
    });

    it(`lets a guest serve under a netd of its own, or where no live daemon owns the container`, () => {
        expect(netdDoorRefusal({ ...guest, controlPath: "/tmp/agent-run/netd.sock", ownerControlPath: () => netd })).toBeUndefined();
        expect(netdDoorRefusal({ ...guest, controlPath: netd, ownerControlPath: () => undefined })).toBeUndefined();
    });
});

describe(`the start netd says this daemon is`, () => {
    it(`is a positive whole number, or none from a netd that predates generations`, () => {
        expect(generationOf({ INTENTIC_NODE_GENERATION: "3" })).toBe(3);
        expect(generationOf({})).toBeUndefined();
        expect(generationOf({ INTENTIC_NODE_GENERATION: "0" })).toBeUndefined();
        expect(generationOf({ INTENTIC_NODE_GENERATION: "x" })).toBeUndefined();
    });
});

describe(`netd's tunnel reports`, () => {
    const watch = () => {
        const lines: [string, string, unknown][] = [];
        const pushed: PushNotification[] = [];
        const withdrawn: PushNotification[] = [];
        const record =
            (level: string) =>
            (first: unknown, second?: string): void => {
                lines.push(typeof first === "string" ? [level, first, undefined] : [level, second ?? "", first]);
            };
        const report = tunnelReports({ info: record("info"), warn: record("warn"), error: record("error") } as never, {
            notifyIfAway: (notification) => {
                pushed.push(notification);
                return Promise.resolve({ delivered: 1, failed: 0 });
            },
            withdraw: (notification) => {
                withdrawn.push(notification);
                return Promise.resolve({ delivered: 1, failed: 0 });
            },
        });
        return { lines, pushed, withdrawn, report };
    };
    const dropped = (reason: string, refused?: TunnelReport["refused"]): TunnelReport => ({
        kind: "tunnel",
        connected: false,
        reason,
        ...(refused === undefined ? {} : { refused }),
    });

    // 2026-10-05: Node logged "the ingress tunnel dropped" with no reason, once a minute for four hours.
    it(`logs each drop with netd's reason, once per change`, () => {
        const { lines, report } = watch();
        report(true, { kind: "tunnel", connected: true });
        report(false, dropped("no frame from the far end in 46s"));
        report(false, dropped("no frame from the far end in 46s"));
        report(false, dropped("could not dial the edge: connection refused"));
        expect(lines).toEqual([
            ["info", "reachable: the ingress tunnel is registered", undefined],
            ["warn", "the ingress tunnel dropped", { reason: "no frame from the far end in 46s" }],
            ["warn", "the ingress tunnel dropped", { reason: "could not dial the edge: connection refused" }],
        ]);
    });

    it(`raises one notification while another copy holds the tunnel, and replaces it once this one holds it again`, () => {
        const { lines, pushed, withdrawn, report } = watch();
        const elsewhere = { refusal: "elsewhere" as const, host: "omen (windows)" };
        report(false, dropped("held by another copy of this sandbox on omen (windows)", elsewhere));
        report(false, dropped("held by another copy of this sandbox on omen (windows)", elsewhere));
        expect(pushed).toHaveLength(1);
        expect(pushed[0]).toMatchObject({ tag: "tunnel-elsewhere", requireInteraction: true });
        expect(pushed[0]?.body).toContain("omen (windows)");
        expect(lines.some(([level, line]) => level === "warn" && line.includes("another copy of this sandbox is running on omen (windows)"))).toBe(
            true,
        );

        report(true, { kind: "tunnel", connected: true });
        expect(withdrawn).toHaveLength(1);
        expect(withdrawn[0]).toMatchObject({ tag: "tunnel-elsewhere", silent: true });
        report(true, { kind: "tunnel", connected: true });
        expect(withdrawn).toHaveLength(1);
    });

    it(`says once that the platform deleted this sandbox`, () => {
        const { lines, report } = watch();
        report(false, dropped("the platform deleted this sandbox", { refusal: "deleted" }));
        report(false, dropped("the platform deleted this sandbox", { refusal: "deleted" }));
        expect(lines.filter(([level]) => level === "error")).toHaveLength(1);
    });
});
