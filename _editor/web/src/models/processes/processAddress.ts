import { localPath } from "@intentic/sandbox-contract/app-routes";
import type { LocationQuery } from "vue-router";
import { z } from "zod";
import { toHome } from "../../lib/routes/links";

// WHERE A PROCESS'S PAGE IS, in each face (processReport.ts). On Home it stands in the chat's place, as the new
// sandbox's run does, asked for by `?process=<id>`; in a local window it is a route of the local shell. A press on its
// tile goes there, in the face the reader is in.

const PROCESS_QUERY = `process`;

/** Home's address showing a process's page. */
export const processOnHome = (id: string) => ({ path: toHome(), query: { [PROCESS_QUERY]: id } });

const Asked = z.string().min(1);

/** The process Home's address asks for, or undefined. */
export const processAskedBy = (route: { readonly name?: unknown; readonly query: LocationQuery }): string | undefined => {
    const asked = Asked.safeParse(route.query[PROCESS_QUERY]);
    return route.name === `home` && asked.success ? asked.data : undefined;
};

/** The local shell's route for a process's page. */
export const processOnThisComputer = (id: string): string => localPath(`process`, { id });

/** The head of that route's address, which the local shell tells a process's page by (local/LocalShell.vue). */
export const LOCAL_PROCESS_PATH = processOnThisComputer(`-`).slice(0, -`/-`.length);
