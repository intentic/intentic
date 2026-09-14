import type { AgentSummary } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { waitingRows } from "./waiting.js";

const agent = (id: string, status: AgentSummary["status"], over: Partial<AgentSummary> = {}): AgentSummary =>
    ({ id, status, updatedAt: 1_000, unread: false, ...over }) as AgentSummary;

describe(`what waits on the owner`, () => {
    it(`lists a question first, then a held draft, then the errands, and nothing that is simply working or done`, () => {
        const rows = waitingRows([
            agent(`done`, `landed`),
            agent(`busy`, `running`),
            agent(`held`, `ready`, { title: `Add pricing` }),
            agent(`misfit`, `conflict`),
            agent(`asks`, `awaiting`),
            agent(`broke`, `error`),
        ]);
        expect(rows.map((row) => row.id)).toEqual([`asks`, `held`, `misfit`, `broke`]);
        expect(rows[1]).toMatchObject({ title: `Add pricing`, tone: `info` });
        expect(rows[2]?.tone).toBe(`warning`);
    });

    it(`leaves an archived agent out, whatever its status`, () => {
        expect(waitingRows([agent(`old`, `ready`, { archivedAt: 5 })])).toEqual([]);
    });

    it(`names an untitled agent rather than showing a blank`, () => {
        expect(waitingRows([agent(`x`, `ready`)])[0]?.title).toBe(`An assistant`);
    });
});
