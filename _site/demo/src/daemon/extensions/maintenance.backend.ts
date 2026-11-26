import type { RawContext } from "@intentic/contract-serve";
import { ChoreLedgerEntrySchema, ChoreProbeRequestSchema } from "@intentic/sandbox-contract/schemas/maintenance";
import { choresReport, reprobe, writeLedger } from "../../fixture/chores";
import { json } from "../../transport";

// The maintenance extension's backend namespace (its src/server/routes.ts), which its views read through `api.backend`
// since its probes left the daemon (2026-11-26): the report computed from fixture/chores.ts, a re-measure, a ledger write.
// The vendored maintenance (vendor/extensions.json) reads these once its pin reaches a commit with that backend; one
// pinned before it still asks the daemon's GET /chores, which no daemon of this build serves.
const MAINTENANCE = `/x/intentic.maintenance`;

// How long a retaken probe (pnpm audit, knip, the churn read) takes here before its reading moves.
const PROBE_MS = 2_500;

const refused = (status: number, message: string): Response => json({ message }, status);

export const maintenanceBackend = {
    [`GET ${MAINTENANCE}/report`]: (): Response => json(choresReport(Date.now())),
    [`POST ${MAINTENANCE}/probe`]: async ({ request }: RawContext): Promise<Response> => {
        const asked = ChoreProbeRequestSchema.safeParse(await request.json());
        if (!asked.success) {
            return refused(400, `expected { repo, id }`);
        }
        await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
        return reprobe(Date.now(), asked.data.repo, asked.data.id) ? json({ ok: true }) : refused(404, `No ${asked.data.id} probe is measured on ${asked.data.repo}.`);
    },
    [`POST ${MAINTENANCE}/ledger`]: async ({ request }: RawContext): Promise<Response> => {
        const written = ChoreLedgerEntrySchema.safeParse(await request.json());
        if (!written.success) {
            return refused(400, `expected a ledger entry`);
        }
        writeLedger(Date.now(), written.data);
        return json({ ok: true });
    },
} satisfies Readonly<Record<string, (context: RawContext) => Response | Promise<Response>>>;
