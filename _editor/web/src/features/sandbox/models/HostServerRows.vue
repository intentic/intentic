<script setup lang="ts">
import type { HostModelServer } from "@intentic/sandbox-contract/contracts/endpoints.contract";
import { Button, RowNote } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useOperation } from "../../../workbench/operations/operations";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import ConnectionRow from "../secrets/ConnectionRow.vue";

// The model servers already running on the computer that hosts this sandbox (Ollama, LM Studio, llama.cpp, vLLM), each
// one press from being a model endpoint. This is where a GPU model comes from: the sandbox runs models on its CPU only,
// and a server on the host talks to the GPU itself. A server already pointed at is listed above as a connection, so it
// is not offered again; when none answers, one line says how to start one so it does.

const t = useT();

const { query } = useSandboxQuery(rpcQuery(`endpoints.hostServers`));
const { capabilities, add } = useCapabilities();

const offered = computed(() => (query.data.value?.servers ?? []).filter((server) => server.capability === undefined));
const answered = computed(() => query.data.value !== undefined);

// Kept in the operations ledger rather than here: this list sits in a panel the reader can leave while the endpoint is
// written and checked, and coming back has to show it under way, or why it failed, under the server it was for. One at a
// time, tagged with the server's address.
const using = useOperation(`models/host-server/use`);
const busy = computed(() => (using.busy.value ? using.operation.value?.tag : undefined));
const failure = computed(() => {
    const operation = using.operation.value;
    return operation?.failure === undefined || operation.tag === undefined
        ? undefined
        : { server: operation.tag, message: operation.failure.detail ?? operation.failure.title };
});

// The connection's name: the program's, numbered only when taken (a second Ollama elsewhere, say).
const nameFor = (server: HostModelServer): string => {
    const taken = new Set(capabilities.value.map((entry) => entry.id));
    let name: string = server.kind;
    for (let n = 2; taken.has(name); n += 1) {
        name = `${server.kind}-${n}`;
    }
    return name;
};

const MODELS_SHOWN = 3;
const modelsLine = (server: HostModelServer): string => {
    if (server.models.length === 0) {
        return t(`connect.hostServers.noModels`);
    }
    const shown = server.models.slice(0, MODELS_SHOWN).join(`, `);
    const more = server.models.length - MODELS_SHOWN;
    return more > 0 ? t(`connect.hostServers.modelsAndMore`, { models: shown, count: more }) : shown;
};

// The row leaves the list once added (it is listed above as a connection), so the end shows itself: no receipt.
const use = async (server: HostModelServer): Promise<void> => {
    if (busy.value !== undefined) {
        return;
    }
    await using.run({
        what: t(`connect.hostServers.adding`, { server: server.label }),
        tag: server.baseUrl,
        quiet: true,
        failed: t(`connect.hostServers.couldntAdd`, { server: server.label }),
        task: async () => {
            await add({ id: nameFor(server), kind: `endpoint`, config: { baseUrl: server.baseUrl, protocol: `openai` } });
            await query.refetch();
        },
    });
};
</script>

<template>
    <div>
        <!-- Drawn inside LocalModelsPanel's <RowGroup>, which this template cannot see: its tier, said here. -->
        <ConnectionRow
            v-for="server in offered"
            :key="server.baseUrl"
            density="compact"
            :title="t(`connect.hostServers.title`, { server: server.label })"
            state="missing"
            :note="t(`connect.hostServers.running`)"
            :description="failure?.server === server.baseUrl ? failure.message : modelsLine(server)"
        >
            <template #control>
                <Button
                    size="small"
                    :label="t(`connect.hostServers.use`)"
                    :loading="busy === server.baseUrl"
                    :disabled="busy !== undefined"
                    @click="use(server)"
                />
            </template>
        </ConnectionRow>
        <RowNote v-if="answered && offered.length === 0 && (query.data.value?.servers.length ?? 0) === 0" variant="block">
            <p class="text-2xs text-subtle">{{ t(`connect.hostServers.noneFound`) }}</p>
        </RowNote>
    </div>
</template>
