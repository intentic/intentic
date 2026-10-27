import { json, type RawRoutes, refuse } from "@intentic/contract-serve";
import { EngineChannelInputSchema, EngineRevertInputSchema, EngineUpdateInputSchema } from "@intentic/sandbox-contract/schemas/engines";
import {
    EnvironmentApproveSchema,
    EnvironmentDevSwapWhenIdleSchema,
    EnvironmentRebuildWhenIdleSchema,
    EnvironmentRemoveSchema,
    EnvironmentRuntimeDecisionSchema,
} from "@intentic/sandbox-contract/schemas/environment";
import { WorkspacePublishSchema } from "@intentic/sandbox-contract/state/definition";
import { ArrivalApplySchema, ArrivalScanSchema } from "@intentic/sandbox-contract/state/arrival";
import { SpeechWakeClaimSchema } from "@intentic/sandbox-contract/schemas/speech";
import { EnrollCodeRequestSchema, SyncPairRequestSchema } from "@intentic/sandbox-contract/schemas/short-codes";
import { PhoneWakeRegistrationSchema } from "@intentic/sandbox-contract/schemas/phone";
import { removeDemoBlock } from "../../fixture/sandbox";
import { enginesView, revertEngine, setEngineChannel, updateEngine } from "./engines";
import {
    approveProposal,
    cancelDevSwapWhenIdle,
    cancelRebuildWhenIdle,
    decideRuntimeInstall,
    devSwapWhenIdle,
    environmentContentsNow,
    environmentNow,
    rebuildWhenIdle,
    rejectProposal,
} from "./environment";
import { answer, inputOf } from "./machineKit";
import { abandonArrival, applyArrival, arrivalHosts, planFromBundle, planFromHost } from "./arrivals";
import { bundleDownload, bundleExports, bundleTicket, removeBundle, startBundle } from "./bundles";
import {
    enrollCode,
    forgetRunner,
    pairPhone,
    phonesList,
    registerPhoneWake,
    revokeSyncMachine,
    runnersList,
    syncPairing,
    syncRunnerDefinition,
    syncStatus,
    unpairPhone,
} from "./peers";
import { claimWake, prepareSpeech, speechStatus, transcribe } from "./speech";
import { definitionDiff, definitionNow, publishWorkspace, workspaceRemote } from "./definition";

// The sandbox's own machine as the editor drives it: its engines, its environment's image, bundles, arrivals, its definition, speech, sync, runners, phones, enrolment and the desktop's picture.
// Spread into daemon/raw.ts's table; a route answered here is taken out of unserved.ts.

// The engines and the environment's image (daemon/engines.ts, daemon/environment.ts): every write answers the view
// after it, as the daemon's do.
const imageRoutes = {
    "GET /engines": () => answer(`GET /engines`, enginesView()),
    "POST /engines/update": async ({ request }) => {
        const { id, version, floor } = await inputOf(EngineUpdateInputSchema, request);
        return answer(`POST /engines/update`, await updateEngine(id, version, floor));
    },
    "POST /engines/revert": async ({ request }) => answer(`POST /engines/revert`, await revertEngine((await inputOf(EngineRevertInputSchema, request)).id)),
    "POST /engines/channel": async ({ request }) => {
        const { id, kind, version } = await inputOf(EngineChannelInputSchema, request);
        return answer(`POST /engines/channel`, await setEngineChannel(id, kind, version));
    },
    "GET /environment": () => answer(`GET /environment`, environmentNow()),
    "GET /environment/contents": () => answer(`GET /environment/contents`, environmentContentsNow()),
    "POST /environment/approve": async ({ request }) =>
        answer(`POST /environment/approve`, approveProposal((await inputOf(EnvironmentApproveSchema, request)).hash)),
    "POST /environment/reject": () => answer(`POST /environment/reject`, rejectProposal()),
    "POST /environment/runtime-install": async ({ request }) =>
        answer(`POST /environment/runtime-install`, decideRuntimeInstall(await inputOf(EnvironmentRuntimeDecisionSchema, request))),
    // Taking a tool out answers as the daemon does, with the environment it leaves; remembered for the tab.
    "POST /environment/remove": async ({ request }) => {
        const { block } = await inputOf(EnvironmentRemoveSchema, request);
        return removeDemoBlock(block)
            ? answer(`POST /environment/remove`, environmentNow())
            : refuse(`nothing by that name is in the environment or waiting to join it`, 404);
    },
    "POST /environment/rebuild-when-idle": async ({ request }) => {
        const { host, hash } = await inputOf(EnvironmentRebuildWhenIdleSchema, request);
        return answer(`POST /environment/rebuild-when-idle`, rebuildWhenIdle(host, hash));
    },
    "DELETE /environment/rebuild-when-idle": () => answer(`DELETE /environment/rebuild-when-idle`, cancelRebuildWhenIdle()),
    "POST /environment/dev-swap-when-idle": async ({ request }) =>
        answer(`POST /environment/dev-swap-when-idle`, devSwapWhenIdle((await inputOf(EnvironmentDevSwapWhenIdleSchema, request)).host)),
    "DELETE /environment/dev-swap-when-idle": () => answer(`DELETE /environment/dev-swap-when-idle`, cancelDevSwapWhenIdle()),
} satisfies RawRoutes;

// Moving out and moving in (daemon/bundles.ts, definition.ts, arrivals.ts): exports that pack while the list watches,
// sandbox.toml derived from what is here, and a plan held under its token until it is applied or put away.
const moveRoutes = {
    "GET /bundles": () => answer(`GET /bundles`, { exports: bundleExports() }),
    "POST /bundles": ({ url }) => answer(`POST /bundles`, startBundle(url.searchParams.get(`secrets`) === `1`)),
    "DELETE /bundles": ({ url }) => answer(`DELETE /bundles`, removeBundle(url.searchParams.get(`name`) ?? ``)),
    "POST /bundles/ticket": ({ url }) => answer(`POST /bundles/ticket`, bundleTicket(url.searchParams.get(`name`) ?? ``)),
    "GET /bundles/download": ({ url }) => bundleDownload(url.searchParams.get(`name`) ?? ``, url.searchParams.get(`ticket`) ?? ``),
    "GET /definition": () => answer(`GET /definition`, definitionNow()),
    "POST /definition/diff": async ({ request }) => answer(`POST /definition/diff`, definitionDiff(await request.text())),
    "GET /definition/workspace": () => answer(`GET /definition/workspace`, workspaceRemote()),
    "POST /definition/workspace/publish": async ({ request }) =>
        answer(`POST /definition/workspace/publish`, await publishWorkspace(await inputOf(WorkspacePublishSchema, request))),
    "GET /arrivals/hosts": () => answer(`GET /arrivals/hosts`, { hosts: arrivalHosts() }),
    "POST /arrivals/scan": async ({ request }) => answer(`POST /arrivals/scan`, await planFromHost((await inputOf(ArrivalScanSchema, request)).host)),
    "POST /arrivals/plan": () => answer(`POST /arrivals/plan`, planFromBundle()),
    "POST /arrivals/apply": async ({ request }) => {
        const { token, items, includeSecrets } = await inputOf(ArrivalApplySchema, request);
        return answer(`POST /arrivals/apply`, await applyArrival(token, items, includeSecrets));
    },
    "DELETE /arrivals": () => answer(`DELETE /arrivals`, abandonArrival()),
} satisfies RawRoutes;

// Speech over HTTP (daemon/speech.ts): the model's readiness, arming it, one phrase heard, and a wake word claimed.
const speechRoutes = {
    "GET /speech/status": ({ url }) => answer(`GET /speech/status`, speechStatus(url.searchParams.get(`lang`))),
    "POST /speech/prepare": ({ url }) => answer(`POST /speech/prepare`, prepareSpeech(url.searchParams.get(`lang`))),
    "POST /speech/transcribe": ({ url }) => answer(`POST /speech/transcribe`, transcribe(url.searchParams.get(`lang`))),
    "POST /speech/wake": async ({ request }) => {
        const { device, holdMs } = await inputOf(SpeechWakeClaimSchema, request);
        return answer(`POST /speech/wake`, claimWake(device, holdMs));
    },
} satisfies RawRoutes;

// The machines on this sandbox's other doors (daemon/peers.ts): desktop sync, runners, phones, and a server's code.
const peerRoutes = {
    "GET /system/sync": () => answer(`GET /system/sync`, syncStatus()),
    "POST /system/sync/pair": async ({ request, url }) => {
        await inputOf(SyncPairRequestSchema, request);
        return answer(`POST /system/sync/pair`, syncPairing(url.searchParams.get(`mode`) === `mirror`));
    },
    "DELETE /system/authorized-key/{machine}": ({ param }) => answer(`DELETE /system/authorized-key/{machine}`, revokeSyncMachine(param(`machine`))),
    "POST /system/enroll/code": async ({ request }) => {
        await inputOf(EnrollCodeRequestSchema, request);
        return answer(`POST /system/enroll/code`, enrollCode());
    },
    "GET /system/runners": () => answer(`GET /system/runners`, { runners: runnersList() }),
    "DELETE /system/runners/{id}": ({ param }) => answer(`DELETE /system/runners/{id}`, forgetRunner(param(`id`))),
    "POST /system/runners/{id}/definition/sync": async ({ param }) =>
        answer(`POST /system/runners/{id}/definition/sync`, await syncRunnerDefinition(param(`id`))),
    "GET /system/phones": () => answer(`GET /system/phones`, { phones: phonesList() }),
    // A pairing for the phone card's QR code; the recording's Pixel scans it a few seconds later (daemon/peers.ts).
    "POST /system/phones/pair": ({ url }) => answer(`POST /system/phones/pair`, pairPhone(url.searchParams.get(`id`) ?? `phone`)),
    "DELETE /system/phones/{id}": ({ param }) => answer(`DELETE /system/phones/{id}`, unpairPhone(param(`id`))),
    "POST /system/phones/{id}/wake": async ({ param, request }) => {
        await inputOf(PhoneWakeRegistrationSchema, request);
        return answer(`POST /system/phones/{id}/wake`, registerPhoneWake(param(`id`)));
    },
} satisfies RawRoutes;

// The other computers paired with this sandbox as hosts, and the browsers connected through the extension: the
// Capabilities and Browsers views ask for both. The demo pairs none of either, so both lists are there and empty.
const connectionRoutes = {
    "GET /system/hosts": () => json({ hosts: [] }),
    "GET /system/webext": () => json({ browsers: [] }),
} satisfies RawRoutes;

export const machineRoutes = {
    ...connectionRoutes,
    ...imageRoutes,
    ...moveRoutes,
    ...speechRoutes,
    ...peerRoutes,
} satisfies RawRoutes;
