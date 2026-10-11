import type { NoticeModel } from "@intentic/ui";
import { type Operation, operationRunning } from "../../../workbench/operations/operations";
import { installsInFlight } from "./installsInFlight";

// Work on one installed extension, kept in the operations ledger under the extension's id rather than in the row or
// drawer that started it: a drawer collapses, the Browse pill replaces the list, and the daemon's swap and this
// browser's host reload run on regardless.
//   extensions/row/<id>                 the list's own verbs (the switch, back to pinned, approve, remove), said in the
//                                       section's notice region
//   extensions/drawer/<id>/update/<act> the drawer's offer: the staged preview, the apply, the revert
//   extensions/drawer/<id>/policy/<act> the drawer's Updates section
//   extensions/section/<act>            the section's own: reloading the host, checking for updates, creating one
// Browse's installs are filed by listing name (installsInFlight.ts).

export const ROWS = `extensions/row`;
export const drawerScope = (id: string): string => `extensions/drawer/${id}`;
export const SECTION = `extensions/section`;

/**
 * Whether anything is under way on this extension, from any surface: one at a time, as the daemon takes them. `name`
 * is what Browse files an update of it under, its manifest's identity.
 */
export const extensionBusy = (id: string, name?: string): boolean =>
    operationRunning(`${ROWS}/${id}`) || operationRunning(drawerScope(id)) || (name !== undefined && installsInFlight.value.has(name));

/** The failure of whichever of `operations` started last: a newer press is the thing happening now. */
export const latestFailure = <F>(operations: readonly ({ readonly order: number; readonly failure: F | undefined } | undefined)[]): F | undefined =>
    operations.filter((operation) => operation !== undefined).toSorted((a, b) => b.order - a.order)[0]?.failure;

/**
 * What an ended run says in a notice region: its failure, or its own sentence where it returned one. Carries the run's
 * key, so dismissing the notice can put the run away.
 */
export const endedNotice = (
    operation: Operation<NoticeModel | undefined> | Operation<unknown>,
    said?: NoticeModel,
): NoticeModel | undefined => {
    if (operation.state === `running`) {
        return undefined;
    }
    const notice = operation.failure ?? said;
    return notice === undefined ? undefined : { ...notice, key: operation.key };
};
