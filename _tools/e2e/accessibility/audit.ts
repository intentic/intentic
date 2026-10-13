import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export const WCAG_21_AA = [`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`];

export interface Finding {
    rule: string;
    impact: string;
    target: string;
    help: string;
}

export async function auditPage(page: Page): Promise<Finding[]> {
    const result = await new AxeBuilder({ page }).withTags(WCAG_21_AA).analyze();
    return result.violations.flatMap((violation) => violation.nodes.map((node) => ({
        rule: violation.id,
        impact: violation.impact ?? `unknown`,
        target: node.target.join(`, `),
        help: violation.help,
    })));
}

export function printFindings(screen: string, findings: Finding[]): void {
    const counts = new Map<string, number>();
    for (const finding of findings) {
        const key = `${finding.rule} (${finding.impact})`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(`[axe] ${screen}: ${findings.length} nodes; ${[...counts].map(([key, count]) => `${key}: ${count}`).join(`; `) || `no violations`}`);
}
