import { type Persona, PersonaSchema } from "@intentic/sandbox-contract";
import { idListFile, type IdListStore } from "../store/id-list-file.js";

// Personas are tracked in git unlike the rest of .intentic, since a card holds no secret: name, capability ids,
// switches, folders. Not a credential store (a token belongs in the capability manifest, by id), and not a security
// boundary: an agent can read and edit it like any workspace file, guarding only against a wrong-account mistake.

// Every card, in file order. An entry that fails validation is dropped rather than failing the whole read, so one bad
// card can't take every persona down on the turn path.
export type PersonasStore = IdListStore<Persona>;

// An unreadable card is reported to both `onInvalid` (daemon log) and the manifest-problem registry (the screen it
// vanished from).
export const filePersonasStore = (path: string, onInvalid?: (id: string, reason: string) => void): PersonasStore =>
    idListFile(path, PersonaSchema, onInvalid);
