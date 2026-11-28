import type { ContactToolGroup, MountedContact } from "../contacts/contact-mounts.js";
import { opt } from "../../opt.js";
import { type FarOperate, farOperateTools } from "./far-operate-tools.js";
import { type FarRecords, farRecordsTools } from "./far-records-tools.js";

// A CONTACT'S CALL TOOLS (2026-11-27, docs/architecture/messages.md "Calls"): the second group of a contact's tool server
// (s2s/contacts/contact-mounts.ts). For a contact that says it gives this sandbox its records, `conversations`,
// `conversation` and `diagnostics`; for a sandbox-scoped one that says it lets this sandbox operate it, `run_command`,
// `read_file` and `write_file`, which only a turn that may hand work on may use, exactly as a link card's are. The tools
// are the link cards' own (far-records-tools.ts, far-operate-tools.ts), reaching the far side by `records.*` and
// `operate.*` calls over the contact's session; what may be read or done there is that sandbox's word.

/** The contact's records, by call: a fleet refusal the far side worded (an unknown handle) is its answer, as a link's is. */
const contactRecords = (contact: MountedContact): FarRecords => ({
    fleet: async ({ handle, query }) => {
        const { q, ...rest } = query;
        const answer = handle === undefined ? await contact.call("records.fleet", { ...opt("q", q), query: rest }) : await contact.call("records.show", { handle, query });
        if (answer.ok) {
            return { ok: true, body: answer.value };
        }
        return answer.body === undefined ? { ok: false, message: answer.message } : { ok: true, body: answer.body };
    },
    diagnostics: (query) => contact.call("records.diagnostics", query),
});

/** The contact's operating doors, by call. */
const contactOperate = (contact: MountedContact): FarOperate => ({
    exec: (exec, signal) => contact.call("operate.exec", exec, signal),
    status: (id, waitS, signal) => contact.call("operate.status", { id, waitS }, signal),
    stop: (id) => contact.call("operate.stop", { id }),
    read: (read, signal) => contact.call("operate.read", read, signal),
    write: (write, signal) => contact.call("operate.write", write, signal),
});

export const contactCallTools: ContactToolGroup = (contact, turn) => {
    const { name, row } = contact;
    const theirs = row.theirGrants;
    const asPerson = row.scope.kind === "person" ? `, read as ${row.scope.person} and cut to what they may read there` : "";
    const records =
        theirs?.records === true
            ? farRecordsTools(contactRecords(contact), {
                  sandbox: name,
                  title: `The contact "${name}"`,
                  shared: `Only while "${name}" grants this sandbox its records${asPerson}; read-only, starts no turn there.`,
              })
            : [];
    // Operating is a sandbox's own contact's alone: a person's route never carries it.
    const operate =
        theirs?.operate === true && row.scope.kind === "sandbox"
            ? farOperateTools(
                  contactOperate(contact),
                  { sandbox: name, title: `the contact "${name}" (${row.address})`, allowed: `Only while "${name}" grants this sandbox operate; every call is logged over there.` },
                  turn.conversationId,
                  () => turn.supervisor() !== undefined,
              )
            : [];
    return [...records, ...operate];
};
