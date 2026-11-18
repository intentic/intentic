import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { type Role, RoleSchema } from "@intentic/sandbox-contract/schemas/roles";
import { drop, nested, rename, retype } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import type { IdListStore } from "../store/plain-files/id-list-file.js";
import { openIdList } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// Roles are tracked in git unlike the rest of .intentic, since a card holds no secret: name, account ids, where it
// opens, what it is told. Not a credential store (a token belongs in the capability manifest, by id), and not a
// security boundary: an agent can read and edit it like any workspace file, which is why what a card may reach is an
// access profile on the history volume that lists it, never a field here.

// Every card, in file order. An entry that fails validation is dropped rather than failing the whole read, so one bad
// card can't take every role down on the turn path.
export type RolesStore = IdListStore<Role>;

export const rolesDocument = defineDocument({
    path: stateRelPath(".intentic/config/roles.json"),
    // Personas were renamed roles on 2026-11-18, the file with them; each kit folder moves in roles-folder-step.ts.
    movedFrom: [join(STATE_DIR, "config", "personas.json")],
    schema: RoleSchema,
    granularity: "entries",
    history: [
        // For two days before 2026-09-06 a card named a context shelf by name; shelves were withdrawn with their files, so
        // the name points at nothing and goes.
        retype(
            "context",
            (value): value is string => typeof value === "string",
            () => undefined,
            "drops the context shelf a card named; shelves were withdrawn",
        ),
        // Found by the vanished-key check (2026-09-25), each gone from the schema with no conversion. `powers.computers`
        // was renamed `devices` on 2026-09-05 with the subsystem: a restriction enforced by absence, so a card that lost
        // it silently widened to every device. The rest retired with their features: `posture`, `voice` and
        // `workspace.copy` (gone by v1.200.0), and the top-level `repos` (a preference chip, not the `context.repos` a
        // checkout carries; gone by v1.248.0).
        ...nested("powers", [rename("computers", "devices")]),
        drop("posture"),
        drop("voice"),
        drop("repos"),
        ...nested("workspace", [drop("copy")]),
    ],
    // A card's own limits became access on 2026-11-18: the step moves them into a profile that lists the card
    // (role-access-step.ts).
    movedByStep: ["powers", "workspace.folders"],
});

// An unreadable card is reported to both `onInvalid` (daemon log) and the manifest-problem registry (the screen it
// vanished from).
export const fileRolesStore = (path: string, onInvalid?: (id: string, reason: string) => void): RolesStore =>
    openIdList(rolesDocument, path, onInvalid);
