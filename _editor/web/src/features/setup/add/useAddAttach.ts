import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import type { Ref } from "vue";
import type { probeDaemon } from "../setupAttach";
import { type AttachLaneHost, useAttachLane } from "../flow/useAttachLane";
import type { SetupRow, SetupRowHost } from "../flow/useSetupRow";

// AN ADDRESS A SANDBOX ALREADY ANSWERS ON, as Home's new sandbox takes one (flow/useAttachLane.ts, the lane /setup ran):
// probed from this browser first, and the row made under the typed name only once the sandbox there let this account in,
// so a typo leaves nothing behind. A row made and then refused its address goes again. An address this account already
// lists opens that sandbox instead of naming it twice.

export interface AddAttachHost {
    readonly host: {
        readonly sandbox: AttachLaneHost[`sandbox`] & Pick<SetupRowHost[`sandbox`], `create`>;
        readonly getIdToken: () => Promise<string | undefined>;
        readonly probe: typeof probeDaemon;
    };
    readonly row: SetupRow;
    readonly error: Ref<NoticeModel | null>;
    readonly name: Readonly<Ref<string>>;
    readonly started: Ref<{ readonly kind: `attach` } | { readonly kind: string } | undefined>;
    // The address minted for this row, which probes as unreachable when pasted back.
    readonly minted: () => string | undefined;
}

export const useAddAttach = ({ host, row, error, name, started, minted }: AddAttachHost) => {
    const { sandbox } = host;
    // The row, made once the probe let this account in, under the name the form holds.
    const createNamed = async (): Promise<void> => {
        try {
            row.created.value = await sandbox.create(name.value.trim());
            row.createdHere.value = true;
        } catch (err) {
            error.value = noticeFrom(err, t(`setup.setup.couldNotCreateSandbox`));
        }
    };
    // Recorded and in: the run's page takes over from the form, and what is left is the sandbox's first start.
    const connected = async (id: string, detail?: { readonly attached?: true }): Promise<void> => {
        started.value = { kind: `attach` };
        await row.connected(id, detail);
    };
    const lane = useAttachLane({
        sandbox,
        row: { created: row.created, error, autoCreate: createNamed, connected },
        minted,
        getIdToken: host.getIdToken,
        probe: host.probe,
        // The same daemon already on the list: that sandbox opens, as a new one would, and no row is made for it.
        reopen: async (id) => {
            const listed = sandbox.sandboxes.value.find((entry) => entry.id === id);
            if (listed !== undefined) {
                row.created.value = listed;
                row.createdHere.value = false;
            }
            await connected(id, { attached: true });
        },
    });

    // The press: probe, then record. A row made for an address that then refused it is taken back.
    const connect = async (): Promise<void> => {
        await lane.connectDomain();
        if (started.value === undefined && row.created.value !== null && row.createdHere.value) {
            await row.discardDraft(false);
        }
    };

    return {
        domain: lane.domain,
        attachToken: lane.attachToken,
        attaching: lane.attaching,
        outcome: lane.attachOutcome,
        notice: lane.attachNotice,
        originHelp: lane.originHelp,
        normalizedDomain: lane.normalizedDomain,
        ownAddress: lane.ownAddress,
        domainProblem: lane.domainProblem,
        connect,
    };
};

export type AddAttach = ReturnType<typeof useAddAttach>;
