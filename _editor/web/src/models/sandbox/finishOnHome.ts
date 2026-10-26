import { HOME_PATH } from "../../lib/routes/firstScreens";
import { ADD_SANDBOX_QUERY, ADD_SANDBOX_VALUE } from "./addSandbox";

/** The query naming a setup of the reader's own that Home is asked to finish in place, beside the new sandbox's ask. */
export const FINISH_QUERY = `finish`;

/**
 * Home's address asking to finish `sandboxId` in place: the new sandbox's tile and page, no dialog
 * (features/home/newSandbox/). Every "finish setting up" press goes here, wherever it is drawn: a setup page of its own
 * used to take the reader off Home for it (router/setupRoutes.ts keeps its old address landing here).
 */
export const finishOnHome = (sandboxId: string) => ({ path: HOME_PATH, query: { [ADD_SANDBOX_QUERY]: ADD_SANDBOX_VALUE, [FINISH_QUERY]: sandboxId } });
