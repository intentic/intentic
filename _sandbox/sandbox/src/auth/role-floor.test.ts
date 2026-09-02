import { describe, expect, test } from "vitest";
import { routeFloor } from "./role-floor.js";

describe("routeFloor", () => {
    test("reads floor at viewer: fleet, transcripts, workspace files, git log", () => {
        expect(routeFloor("GET", "/agents")).toBe("viewer");
        expect(routeFloor("GET", "/agents/abc/transcript")).toBe("viewer");
        expect(routeFloor("GET", "/workspace/file")).toBe("viewer");
        expect(routeFloor("GET", "/events")).toBe("viewer");
    });

    test("watching and being present are viewer despite being POSTs", () => {
        expect(routeFloor("POST", "/agent/attach")).toBe("viewer");
        expect(routeFloor("POST", "/system/session")).toBe("viewer");
        expect(routeFloor("POST", "/system/presence")).toBe("viewer");
        expect(routeFloor("POST", "/workspace/media-ticket")).toBe("viewer");
        expect(routeFloor("DELETE", "/members/self")).toBe("viewer");
    });

    test("driving agents is the collaborator tier", () => {
        expect(routeFloor("POST", "/agent")).toBe("collaborator");
        expect(routeFloor("POST", "/agent/steer")).toBe("collaborator");
        expect(routeFloor("POST", "/agents/abc/rename")).toBe("collaborator");
        expect(routeFloor("POST", "/agents/abc/request-land")).toBe("collaborator");
        expect(routeFloor("POST", "/workspace/upload")).toBe("collaborator");
        expect(routeFloor("POST", "/system/ws-ticket")).toBe("collaborator");
        expect(routeFloor("POST", "/system/sync/pair")).toBe("collaborator");
    });

    test("what leaves the sandbox floors at maintainer: land, discard, approvals, workspace writes", () => {
        expect(routeFloor("POST", "/agents/abc/land")).toBe("maintainer");
        expect(routeFloor("POST", "/agents/abc/discard")).toBe("maintainer");
        expect(routeFloor("POST", "/approvals")).toBe("maintainer");
        expect(routeFloor("DELETE", "/approvals/d1")).toBe("maintainer");
        expect(routeFloor("POST", "/workspace/move")).toBe("maintainer");
    });

    test("operator reads outrank the GET default: logs, usage, capabilities", () => {
        expect(routeFloor("GET", "/logs")).toBe("maintainer");
        expect(routeFloor("GET", "/system/usage")).toBe("maintainer");
        expect(routeFloor("GET", "/capabilities")).toBe("maintainer");
    });

    test("the secrets surface belongs to the operating tier, reads included", () => {
        expect(routeFloor("GET", "/secrets")).toBe("maintainer");
        expect(routeFloor("POST", "/secrets")).toBe("maintainer");
        expect(routeFloor("GET", "/secrets/inventory")).toBe("maintainer");
    });

    test("an unclassified route falls to the fail-safe defaults: viewer for reads, maintainer for mutations", () => {
        expect(routeFloor("GET", "/no/such/route")).toBe("viewer");
        expect(routeFloor("POST", "/no/such/route")).toBe("maintainer");
        expect(routeFloor("POST", "/members")).toBe("maintainer");
        expect(routeFloor("POST", "/system/sessions/revoke")).toBe("maintainer");
    });
});
