import { type Persona, PersonaSchema } from "@intentic/sandbox-contract";
import { drop, nested, rename, retype } from "../store/evolution/conversions.js";
import { defineDocument } from "../store/evolution/documents.js";
import { idListFile, type IdListStore } from "../store/id-list-file.js";
import { stateRelPath } from "../state-paths.js";

// Personas are tracked in git unlike the rest of .intentic, since a card holds no secret: name, capability ids,
// switches, folders. Not a credential store (a token belongs in the capability manifest, by id), and not a security
// boundary: an agent can read and edit it like any workspace file, guarding only against a wrong-account mistake.

// Every card, in file order. An entry that fails validation is dropped rather than failing the whole read, so one bad
// card can't take every persona down on the turn path.
export type PersonasStore = IdListStore<Persona>;

export const personasDocument = defineDocument({
    path: stateRelPath(".intentic/config/personas.json"),
    schema: PersonaSchema,
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
});

// An unreadable card is reported to both `onInvalid` (daemon log) and the manifest-problem registry (the screen it
// vanished from).
export const filePersonasStore = (path: string, onInvalid?: (id: string, reason: string) => void): PersonasStore =>
    idListFile(path, PersonaSchema, onInvalid, personasDocument);
