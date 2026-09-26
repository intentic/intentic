import { type HostConnection, parseHostConnection } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";

// Which card and environment a connection is, off its enrollment's own record. A key with no record is a card that has
// never been paired, whose key is the card itself; the parser only answers for that, and for nothing a record says.
export const hostConnectionOf = async (services: Pick<Services, "hosts">, id: string): Promise<HostConnection> => {
    const record = (await services.hosts.list()).find((entry) => entry.id === id);
    return record === undefined ? parseHostConnection(id) : { card: record.card, environment: record.environment };
};
