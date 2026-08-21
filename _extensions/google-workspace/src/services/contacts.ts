import { limit as readLimit } from "../cli/args.js";
import { type Command, type CommandGroup, printJson } from "../cli/command.js";
import { count, row, tally } from "../cli/format.js";
import { call, paginate } from "../google/request.js";

const API = "https://people.googleapis.com/v1";
const FIELDS = "names,emailAddresses,phoneNumbers,organizations";

interface Person {
    readonly resourceName?: string;
    readonly names?: readonly { readonly displayName?: string }[];
    readonly emailAddresses?: readonly { readonly value?: string }[];
    readonly phoneNumbers?: readonly { readonly value?: string }[];
    readonly organizations?: readonly { readonly name?: string; readonly title?: string }[];
}

const personLine = (person: Person): string =>
    row(
        person.names?.[0]?.displayName ?? "(no name)",
        person.emailAddresses?.[0]?.value,
        person.phoneNumbers?.[0]?.value,
        [person.organizations?.[0]?.title, person.organizations?.[0]?.name].filter((part) => part !== undefined).join(" @ ") || undefined,
    );

const search: Command = {
    name: "search",
    summary: "Look someone up by name, email or company",
    usage: "gw contacts search <text> [-n 10]",
    run: async (ctx) => {
        const query = ctx.args.positional.slice(1).join(" ");
        if (query === "") {
            throw new Error("Say who to look for.");
        }
        const max = readLimit(ctx.args, 10, 30);
        /* People's search index is built per session: the documented first step is a warm-up call with an
         * empty query, and without it the first real search of a process reliably answers with nothing. It is
         * one request and it is the difference between this command working and appearing to find no one. */
        await call(ctx.session, { url: `${API}/people:searchContacts`, query: { query: "", readMask: FIELDS } }).catch(() => undefined);
        const found = await call<{ results?: { person?: Person }[] }>(ctx.session, {
            url: `${API}/people:searchContacts`,
            query: { query, readMask: FIELDS, pageSize: max },
        });
        const people = (found.results ?? []).map((result) => result.person).filter((person): person is Person => person !== undefined);
        if (ctx.json) {
            printJson(ctx, people);
            return;
        }
        for (const person of people) {
            ctx.out(personLine(person));
        }
        ctx.out(count(people.length, "contacts"));
    },
};

const listContacts: Command = {
    name: "list",
    summary: "Everyone in the account's contacts",
    usage: "gw contacts list [-n 100]",
    run: async (ctx) => {
        const max = readLimit(ctx.args, 100, 500);
        const people = await paginate<Person>(
            ctx.session,
            { url: `${API}/people/me/connections`, query: { personFields: FIELDS, sortOrder: "LAST_MODIFIED_DESCENDING" } },
            { itemsOf: (page) => page["connections"] as Person[] | undefined, limit: max, sizeKey: "pageSize", maxPageSize: 200 },
        );
        if (ctx.json) {
            printJson(ctx, people);
            return;
        }
        for (const person of people) {
            ctx.out(personLine(person));
        }
        ctx.out(tally(people.length, max, "contacts"));
    },
};

export const contactsGroup: CommandGroup = {
    name: "contacts",
    summary: "Contacts, find an address before writing to it",
    commands: [search, listContacts],
};
