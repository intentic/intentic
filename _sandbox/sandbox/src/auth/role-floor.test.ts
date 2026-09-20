import { ATTACHMENTS_DIR } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { deskReach, memberRefusal, routeFloor } from "./role-floor.js";

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
        // One's own passkeys are identity, like staying signed in; the handler holds another member's to the owner.
        expect(routeFloor("GET", "/system/passkeys")).toBe("viewer");
        expect(routeFloor("POST", "/system/passkeys/register/options")).toBe("viewer");
        expect(routeFloor("POST", "/system/passkeys/register")).toBe("viewer");
        expect(routeFloor("DELETE", "/system/passkeys/abc_123")).toBe("viewer");
    });

    test("driving agents is the collaborator tier", () => {
        expect(routeFloor("POST", "/agent")).toBe("collaborator");
        expect(routeFloor("POST", "/agent/steer")).toBe("collaborator");
        expect(routeFloor("POST", "/agents/abc/rename")).toBe("collaborator");
        expect(routeFloor("POST", "/agents/abc/request-land")).toBe("collaborator");
        expect(routeFloor("POST", "/agents/abc/assign")).toBe("collaborator");
        // Resuming is the same turn again, so it belongs to whoever may start one; arming auto-land does not.
        expect(routeFloor("POST", "/agent/resume")).toBe("collaborator");
        expect(routeFloor("POST", "/agents/abc/break-policy")).toBe("collaborator");
        expect(routeFloor("POST", "/agents/abc/auto-land")).toBe("maintainer");
        // An attachment is part of the message it travels with, so the upload route answers at this tier for
        // the address attachments land at — and only for that one (the workspace write below).
        expect(routeFloor("POST", "/workspace/upload", `${ATTACHMENTS_DIR}/u1/shot.png`)).toBe("collaborator");
        expect(routeFloor("POST", "/system/ws-ticket")).toBe("collaborator");
        expect(routeFloor("POST", "/system/sync/pair")).toBe("collaborator");
    });

    test("changing files in the shared tree is the writer tier", () => {
        expect(routeFloor("POST", "/workspace/dir")).toBe("writer");
        expect(routeFloor("DELETE", "/workspace/entry")).toBe("writer");
        expect(routeFloor("POST", "/workspace/move")).toBe("writer");
        expect(routeFloor("POST", "/workspace/copy")).toBe("writer");
        expect(routeFloor("POST", "/workspace/extract")).toBe("writer");
        // Writing bytes into the shared tree is that same edit, whichever door it uses: the upload route only
        // drops to collaborator for an attachment address, so a plain file, a missing target, and a path that
        // climbs back out of the attachments dir all land here with move and delete. Where in the tree any of
        // them may land is the fence's answer, not this one (areas/area-fence.integration.test.ts).
        expect(routeFloor("POST", "/workspace/upload", "app/main.ts")).toBe("writer");
        expect(routeFloor("POST", "/workspace/upload")).toBe("writer");
        expect(routeFloor("POST", "/workspace/upload", `${ATTACHMENTS_DIR}/u1/../../../../config/hooks/lint.mjs`)).toBe("writer");
    });

    test("what leaves the sandbox floors at maintainer: land, discard, approvals", () => {
        expect(routeFloor("POST", "/agents/abc/land")).toBe("maintainer");
        expect(routeFloor("POST", "/agents/abc/discard")).toBe("maintainer");
        expect(routeFloor("POST", "/approvals")).toBe("maintainer");
        expect(routeFloor("DELETE", "/approvals/d1")).toBe("maintainer");
    });

    test("operating the tree is not editing it, and stays at maintainer", () => {
        expect(routeFloor("POST", "/workspace/setup")).toBe("maintainer");
        expect(routeFloor("POST", "/workspace/setup/install")).toBe("maintainer");
        expect(routeFloor("POST", "/workspace/repos")).toBe("maintainer");
        expect(routeFloor("POST", "/workspace/repos/new")).toBe("maintainer");
        expect(routeFloor("POST", "/workspace/sync")).toBe("maintainer");
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
        // The require-passkey switch and its recovery codes keep the mutation default under their ownership gate.
        expect(routeFloor("POST", "/system/passkeys/policy")).toBe("maintainer");
        expect(routeFloor("POST", "/system/passkeys/recovery")).toBe("maintainer");
    });
});

describe("deskReach", () => {
    test("the chat a desk drives, the cards it holds, and the reads a composer needs", () => {
        expect(deskReach("POST", "/agent")).toBe(true);
        expect(deskReach("POST", "/agent/attach")).toBe(true);
        expect(deskReach("POST", "/agent/reply")).toBe(true);
        expect(deskReach("GET", "/agents")).toBe(true);
        expect(deskReach("GET", "/agents/abc/transcript")).toBe(true);
        expect(deskReach("GET", "/personas")).toBe(true);
        expect(deskReach("GET", "/providers")).toBe(true);
        expect(deskReach("GET", "/events")).toBe(true);
        expect(deskReach("POST", "/system/session")).toBe(true);
        expect(deskReach("POST", "/speech/transcribe")).toBe(true);
        expect(deskReach("DELETE", "/members/self")).toBe(true);
        expect(deskReach("DELETE", "/system/passkeys/abc_123")).toBe(true);
        expect(deskReach("POST", "/workspace/upload", `${ATTACHMENTS_DIR}/u1/shot.png`)).toBe(true);
    });

    // A desk reaches the workspace only while it actually holds an area of it; granting the whole tree to every desk
    // would widen the narrowest tier, and naming an area is how somebody asks for the part they meant.
    test("a fenced desk reads the workspace, and an unfenced one still cannot", () => {
        expect(deskReach("GET", "/workspace/tree", undefined, true)).toBe(true);
        expect(deskReach("GET", "/workspace/file", undefined, true)).toBe(true);
        expect(deskReach("GET", "/workspace/search", undefined, true)).toBe(true);
        expect(deskReach("GET", "/workspace/raw", undefined, true)).toBe(true);
        expect(deskReach("GET", "/areas", undefined, true)).toBe(true);
        // Reads only: the tier writes nothing but the attachment that rides with its own message.
        expect(deskReach("POST", "/workspace/upload", "support/note.md", true)).toBe(false);
        expect(deskReach("DELETE", "/workspace/file", undefined, true)).toBe(false);
        expect(deskReach("POST", "/areas", undefined, true)).toBe(false);
    });

    test("the tree, the past, the box, and every ship control stay shut, and so does anything unnamed", () => {
        expect(deskReach("GET", "/workspace/tree")).toBe(false);
        expect(deskReach("GET", "/workspace/file")).toBe(false);
        expect(deskReach("GET", "/areas")).toBe(false);
        expect(deskReach("POST", "/workspace/upload", "app/main.ts")).toBe(false);
        expect(deskReach("POST", "/workspace/upload")).toBe(false);
        expect(deskReach("GET", "/sessions")).toBe(false);
        expect(deskReach("GET", "/agents/search")).toBe(false);
        expect(deskReach("POST", "/personas/route")).toBe(false);
        expect(deskReach("POST", "/personas")).toBe(false);
        expect(deskReach("GET", "/secrets")).toBe(false);
        expect(deskReach("POST", "/agents/abc/land")).toBe(false);
        expect(deskReach("POST", "/agents/abc/request-land")).toBe(false);
        expect(deskReach("POST", "/system/ws-ticket")).toBe(false);
        expect(deskReach("GET", "/no/such/route")).toBe(false);
    });
});

describe("memberRefusal", () => {
    test("a tier below the floor is refused with the floor named; a desk off its list with its own sentence", () => {
        expect(memberRefusal({ role: "viewer" }, "POST", "/agent")).toEqual({ error: "collaborator access required", floor: "collaborator" });
        expect(memberRefusal({ role: "collaborator" }, "POST", "/agent")).toBeUndefined();
        expect(memberRefusal({ role: "desk" }, "POST", "/agent")).toBeUndefined();
        expect(memberRefusal({ role: "desk" }, "GET", "/workspace/tree")).toEqual({ error: "not open to a desk member", floor: "viewer" });
        // A desk never clears a floor by rank: the list is the whole of its admission.
        expect(memberRefusal({ role: "desk" }, "GET", "/no/such/route")).toEqual({ error: "not open to a desk member", floor: "viewer" });
        expect(memberRefusal({ role: "viewer" }, "GET", "/no/such/route")).toBeUndefined();
    });

    test("a writer clears the file routes and nothing that ships or operates", () => {
        expect(memberRefusal({ role: "writer", areas: ["support"] }, "POST", "/workspace/move")).toBeUndefined();
        expect(memberRefusal({ role: "writer", areas: ["support"] }, "POST", "/workspace/upload", "support/note.md")).toBeUndefined();
        expect(memberRefusal({ role: "collaborator" }, "POST", "/workspace/move")).toEqual({ error: "writer access required", floor: "writer" });
        expect(memberRefusal({ role: "writer", areas: ["support"] }, "POST", "/agents/abc/land")).toEqual({
            error: "maintainer access required",
            floor: "maintainer",
        });
        expect(memberRefusal({ role: "writer", areas: ["support"] }, "GET", "/secrets")).toEqual({
            error: "maintainer access required",
            floor: "maintainer",
        });
    });
});
