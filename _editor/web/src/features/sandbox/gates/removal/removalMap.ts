import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// THE REMOVAL AS A PICTURE: who loses the sandbox, the sandbox, and what runs it, with the links the press cuts. It
// replaced a paragraph per lane that said the same in sentences nobody read. Pure, so each lane is pinned by a test.

export interface RemovalNode {
    readonly icon: IconName;
    readonly label: string;
    /** What happens to it, in two or three words: "loses access", "keeps running". */
    readonly fate: string;
    /** Drawn in danger ink when the press takes it away, quiet when the press leaves it be. */
    readonly lost: boolean;
}

export interface RemovalPicture {
    /** The whole picture in one sentence, for a reader who cannot see it. */
    readonly label: string;
    readonly nodes: readonly [RemovalNode, RemovalNode, RemovalNode];
    /** Whether each of the two links between them is cut. */
    readonly cuts: readonly [boolean, boolean];
}

export const removalMap = (
    /** The account row, of which only its name, the reader's role on it and whether it is hosted are read. */
    row: { readonly name: string; readonly role: string; readonly hosted: object | null },
    /** Whether the press also deletes the container on the reader's own machine, and that machine's name when known. */
    machine: { readonly deletes: boolean; readonly label: string | undefined },
): RemovalPicture => {
    if (row.role !== `owner`) {
        return {
            label: t(`sandbox.removeAsk.mapLeave`),
            cuts: [true, false],
            nodes: [
                { icon: `user`, label: t(`sandbox.removeAsk.you`), fate: t(`sandbox.removeAsk.youFate`), lost: true },
                { icon: `box`, label: row.name, fate: t(`sandbox.removeAsk.keepsRunning`), lost: false },
                { icon: `users`, label: t(`sandbox.removeAsk.others`), fate: t(`sandbox.removeAsk.othersFate`), lost: false },
            ],
        };
    }
    const hosted = row.hosted !== null;
    // A hosted machine always goes with its sandbox; a box of the reader's own only when they tick it.
    const machineGoes = hosted || machine.deletes;
    const machineFate = hosted ? t(`sandbox.removeAsk.stops`) : machineGoes ? t(`sandbox.removeAsk.deletesIt`) : t(`sandbox.removeAsk.stillRunsIt`);
    return {
        label: hosted ? t(`sandbox.removeAsk.mapHosted`) : machineGoes ? t(`sandbox.removeAsk.mapOwnDeleting`) : t(`sandbox.removeAsk.mapOwn`),
        cuts: [true, machineGoes],
        nodes: [
            { icon: `users`, label: t(`sandbox.removeAsk.everyone`), fate: t(`sandbox.removeAsk.everyoneFate`), lost: true },
            { icon: `box`, label: row.name, fate: t(`sandbox.removeAsk.offAccount`), lost: true },
            {
                icon: hosted ? `cloud` : `server`,
                label: hosted ? t(`sandbox.removeAsk.hostedMachine`) : (machine.label ?? t(`sandbox.removeAsk.itsComputer`)),
                fate: machineFate,
                lost: machineGoes,
            },
        ],
    };
};
