import { ATTACHMENTS_DIR } from "@intentic/sandbox-contract";
import { guestReach, memberRefusal, routeFloor } from "./role-floor.js";

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

describe("guestReach", () => {
    test("the chat a guest drives, the cards it holds, and the reads a composer needs", () => {
        expect(guestReach("POST", "/agent")).toBe(true);
        expect(guestReach("POST", "/agent/attach")).toBe(true);
        expect(guestReach("POST", "/agent/reply")).toBe(true);
        expect(guestReach("GET", "/agents")).toBe(true);
        expect(guestReach("GET", "/agents/abc/transcript")).toBe(true);
        expect(guestReach("GET", "/personas")).toBe(true);
        expect(guestReach("GET", "/providers")).toBe(true);
        expect(guestReach("GET", "/events")).toBe(true);
        expect(guestReach("POST", "/system/session")).toBe(true);
        expect(guestReach("POST", "/speech/transcribe")).toBe(true);
        expect(guestReach("DELETE", "/members/self")).toBe(true);
        expect(guestReach("DELETE", "/system/passkeys/abc_123")).toBe(true);
        expect(guestReach("POST", "/workspace/upload", `${ATTACHMENTS_DIR}/u1/shot.png`)).toBe(true);
    });

    // Every guest holds an area — the roster refuses one that names none (auth.ts MemberSchema) — and each route below
    // applies that fence itself, so none of them can answer with the whole tree.
    test("a guest reads the workspace, which its own fence then cuts", () => {
        expect(guestReach("GET", "/workspace/tree")).toBe(true);
        expect(guestReach("GET", "/workspace/file")).toBe(true);
        expect(guestReach("GET", "/workspace/search")).toBe(true);
        expect(guestReach("GET", "/workspace/raw")).toBe(true);
        expect(guestReach("GET", "/areas")).toBe(true);
        // Reads only: the tier writes nothing but the attachment that rides with its own message.
        expect(guestReach("POST", "/workspace/upload", "support/note.md")).toBe(false);
        expect(guestReach("DELETE", "/workspace/file")).toBe(false);
        expect(guestReach("POST", "/areas")).toBe(false);
    });

    test("the past, the box, and every ship control stay shut, and so does anything unnamed", () => {
        expect(guestReach("POST", "/workspace/upload", "app/main.ts")).toBe(false);
        expect(guestReach("POST", "/workspace/upload")).toBe(false);
        expect(guestReach("GET", "/sessions")).toBe(false);
        expect(guestReach("GET", "/agents/search")).toBe(false);
        expect(guestReach("POST", "/agent/route-chat")).toBe(false);
        expect(guestReach("POST", "/personas")).toBe(false);
        expect(guestReach("GET", "/secrets")).toBe(false);
        expect(guestReach("POST", "/agents/abc/land")).toBe(false);
        expect(guestReach("POST", "/agents/abc/request-land")).toBe(false);
        expect(guestReach("POST", "/system/ws-ticket")).toBe(false);
        expect(guestReach("GET", "/no/such/route")).toBe(false);
    });
});

describe("memberRefusal", () => {
    test("a tier below the floor is refused with the floor named; a guest off its list with its own sentence", () => {
        expect(memberRefusal({ role: "viewer" }, "POST", "/agent")).toEqual({ error: "collaborator access required", floor: "collaborator" });
        expect(memberRefusal({ role: "collaborator" }, "POST", "/agent")).toBeUndefined();
        expect(memberRefusal({ role: "guest", areas: ["support"] }, "POST", "/agent")).toBeUndefined();
        expect(memberRefusal({ role: "guest", areas: ["support"] }, "POST", "/workspace/move")).toEqual({
            error: "not open to a guest member",
            floor: "viewer",
        });
        // A guest never clears a floor by rank: the list is the whole of its admission.
        expect(memberRefusal({ role: "guest", areas: ["support"] }, "GET", "/no/such/route")).toEqual({
            error: "not open to a guest member",
            floor: "viewer",
        });
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
