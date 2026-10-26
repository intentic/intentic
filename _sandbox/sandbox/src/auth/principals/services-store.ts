import { ServiceSchema } from "@intentic/sandbox-contract/schemas/services";
import { defineDocument } from "../../store/evolution/documents.js";
import type { IdListStore } from "../../store/plain-files/id-list-file.js";
import { openIdList } from "../../store/open-document.js";
import type { Service } from "@intentic/sandbox-contract/schemas/services";

// THE SERVICES unattended work runs as (docs/architecture/access.md), on the history volume beside the roster: each names
// a steward, a person whose authority its runs use, so the file decides authority the way the roster does and is kept
// off the workspace every turn writes.

export type ServicesStore = IdListStore<Service>;

export const servicesDocument = defineDocument({
    root: "history",
    path: "identity/services.json",
    // A steward is a person on this sandbox's roster; on another sandbox the address means nothing it decided.
    portability: "identity",
    note: "Write the services again on the target's Access page; automations that run as one are skipped until it exists there.",
    schema: ServiceSchema,
    granularity: "entries",
});

// An entry that does not parse is left out (and reported): whatever runs as it is skipped with that reason, never run on
// a guess.
export const fileServices = (path: string, onInvalid?: (id: string, reason: string) => void): ServicesStore =>
    openIdList(servicesDocument, path, onInvalid);
