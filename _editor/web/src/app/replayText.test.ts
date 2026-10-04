import "@intentic/testing/dom";
import { registerCatalog } from "@intentic/ui/i18n";
import { isAppCopy, maskText, scrubDiagnostic } from "./replayText";

// The interface's own wording, as a real catalog registers it: what a replay may show. The two forms of `files` render as
// written; the link cannot, so it must not count as words we wrote. The rest are our sentences around values.
await registerCatalog({
    namespace: `probe`,
    base: {
        save: `Save`,
        files: `no file | one file`,
        count: `{n} changed`,
        again: `@:probe.save again`,
        spaced: `Open   the\n menu`,
        press: `Fix the above, then press "{button}" again.`,
        installing: `Installing {what} on this device`,
        joined: `{a} and {b}`,
        slotted: `Starts your sandbox in {docker}, no inbound ports`,
        deleting: `Probe forgets {name} for good?`,
        updating: `Probe moves to {version} now`,
        booting: `Probe boots: {step}`,
    },
    load: () => Promise.reject(new Error(`unused`)),
});

const element = (html: string, selector: string): Element => {
    const host = document.createElement(`div`);
    host.innerHTML = html;
    return host.querySelector(selector)!;
};

// What a masked value must look like: not one character of it left, whatever it was.
const blank = (value: string): string => value.replace(/\S/g, `*`);

describe(`the interface's own wording`, () => {
    it(`keeps a word the interface wrote and stars out a word anyone else wrote`, () => {
        expect(maskText(`Save`)).toBe(`Save`);
        expect(maskText(`src/checkout.ts`)).toBe(blank(`src/checkout.ts`));
        expect(maskText(`Save the plan`)).toBe(`**** *** ****`);
    });

    // A text node arrives with whatever whitespace the template around it left, so it is compared as words.
    it(`compares words, not whitespace, and keeps the whitespace it was given`, () => {
        expect(maskText(`  Save\n`)).toBe(`  Save\n`);
        expect(maskText(`Open the menu`)).toBe(`Open the menu`);
        expect(maskText(` a  b `)).toBe(` *  * `);
    });

    it(`treats every form of a plural message as words we wrote`, () => {
        expect(isAppCopy(`no file`)).toBe(true);
        expect(isAppCopy(`one file`)).toBe(true);
        expect(isAppCopy(`many files`)).toBe(false);
    });

    it(`does not count a filled-in or linked message as written`, () => {
        expect(isAppCopy(`3 changed`)).toBe(false);
        expect(isAppCopy(`{n} changed`)).toBe(false);
        expect(isAppCopy(`Save again`)).toBe(false);
        expect(isAppCopy(`@:probe.save again`)).toBe(false);
        expect(maskText(`Save again`)).toBe(`**** *****`);
    });

    it(`has nothing to hide in an empty node, a separator or the product's name`, () => {
        expect(maskText(``)).toBe(``);
        expect(maskText(`\n   `)).toBe(`\n   `);
        expect(maskText(` · `)).toBe(` · `);
        expect(maskText(`.`)).toBe(`.`);
        expect(maskText(`(—)`)).toBe(`(—)`);
        expect(maskText(`intentic`)).toBe(`intentic`);
    });
});

describe(`our sentence around a value`, () => {
    it(`keeps the wording and judges each value on its own`, () => {
        expect(maskText(`3 changed`)).toBe(`3 changed`);
        expect(maskText(`src/a.ts changed`)).toBe(`******** changed`);
        expect(maskText(`Installing my-laptop on this device`)).toBe(`Installing ********* on this device`);
    });

    // A placeholder's name says what may fill it: a count only as a number, a name never, a version only as one.
    it(`judges a value by what its placeholder is for`, () => {
        expect(maskText(`Save changed`)).toBe(`**** changed`);
        expect(maskText(`Probe forgets Save for good?`)).toBe(`Probe forgets **** for good?`);
        expect(maskText(`Probe moves to 2.5.1 now`)).toBe(`Probe moves to 2.5.1 now`);
        expect(maskText(`Probe moves to my-fork now`)).toBe(`Probe moves to ******* now`);
        expect(maskText(`Probe boots: pulling the image`)).toBe(`Probe boots: pulling the image`);
        expect(maskText(`Probe boots: reading /home/grace`)).toBe(`Probe boots: reading ***********`);
    });

    // The button's label is a message too, so the sentence that names it replays whole.
    it(`keeps a value that is itself our wording`, () => {
        expect(maskText(`Fix the above, then press "Save" again.`)).toBe(`Fix the above, then press "Save" again.`);
        expect(maskText(`Fix the above, then press "Grace" again.`)).toBe(`Fix the above, then press "*****" again.`);
    });

    // An `<i18n-t>` renders the wording between its slots as nodes of their own.
    it(`keeps a piece of a template rendered on its own`, () => {
        expect(maskText(`Starts your sandbox in`)).toBe(`Starts your sandbox in`);
        expect(maskText(` , no inbound ports`)).toBe(` , no inbound ports`);
    });

    // "{a} and {b}" would match anybody's sentence and keep its "and".
    it(`does not lend a template with almost no wording to someone else's sentence`, () => {
        expect(maskText(`cats and dogs`)).toBe(`**** *** ****`);
    });

    it(`judges each part of text joined by a separator`, () => {
        expect(maskText(`Save · src/a.ts · 3 changed`)).toBe(`Save · ******** · 3 changed`);
    });
});

describe(`a quantity standing alone`, () => {
    it(`keeps a count, a share, a size, a duration and a step`, () => {
        for (const quantity of [`3`, `42%`, `1.5 GB`, `1024 MB`, `12 h`, `about 3 min left`, `2 hours ago`, `4 / 10`, `1h 20m`, `1,234`, `(7)`]) {
            expect(maskText(quantity)).toBe(quantity);
        }
    });

    // Every one of these is a number someone could be identified or reached by.
    it(`does not take a PIN, a year, a postcode, a phone number, an address or a card for a quantity`, () => {
        // Built rather than written out, so neither reads as anybody's.
        const phone = [`+48`, `600`, `700`, `800`].join(` `);
        const card = `4111 `.repeat(4).trim();
        for (const value of [`4829`, `2026`, `12345`, `00-950`, `555 1234`, phone, `10.0.0.1`, card, `15:04`]) {
            expect(maskText(value)).toBe(blank(value));
        }
    });
});

describe(`where it sits`, () => {
    it(`keeps nothing inside code, where commands carry setup codes`, () => {
        expect(maskText(`3`, element(`<pre><span>x</span></pre>`, `span`))).toBe(`*`);
        expect(maskText(`3 changed`, element(`<code>x</code>`, `code`))).toBe(`* *******`);
    });

    it(`keeps the words of what a machine reported, and stars what names someone`, () => {
        const report = element(`<ul data-replay="diagnostic"><li><span>x</span></li></ul>`, `span`);
        expect(maskText(`the network broke, see C:\\Users\\grace\\log.txt`, report)).toBe(`the network broke, see ${blank(`C:\\Users\\grace\\log.txt`)}`);
    });

    it(`masks as before anywhere else`, () => {
        expect(maskText(`the network broke`, element(`<p><span>x</span></p>`, `span`))).toBe(`*** ******* *****`);
    });
});

describe(`what a machine's report keeps`, () => {
    // The report that left a user retrying for eleven minutes (2026-10-04), shortened: every word of it must survive.
    it(`keeps a setup failure readable`, () => {
        const said =
            `ghcr.io/intentic/sandbox:stable did not finish downloading in 3 attempts. The registry answered and the transfer broke, ` +
            `re-run when it is steadier. Docker said: Error response from daemon: error from registry: denied. Run 'docker logout ghcr.io' ` +
            `or see https://docs.docker.com/engine/.`;
        expect(scrubDiagnostic(said)).toBe(said);
    });

    it(`stars an email, a path, an address, a hostname and an identifier`, () => {
        expect(scrubDiagnostic(`mailed grace@example.com about /home/grace/.docker/config.json`)).toBe(
            `mailed ${blank(`grace@example.com`)} about ${blank(`/home/grace/.docker/config.json`)}`,
        );
        expect(scrubDiagnostic(`could not reach https://my-box.intentic.dev/health or my-box.intentic.dev.`)).toBe(
            `could not reach ${blank(`https://my-box.intentic.dev/health`)} or ${blank(`my-box.intentic.dev`)}.`,
        );
        expect(scrubDiagnostic(`daemon at 192.168.1.20:2375 refused`)).toBe(`daemon at ***************** refused`);
        expect(scrubDiagnostic(`container 'intentic-workspace-runner-omen' exited`)).toBe(`container '${blank(`intentic-workspace-runner-omen`)}' exited`);
        expect(scrubDiagnostic(`token ghp_0123456789abcdefghijABCDEFGHIJ is stale`)).toBe(`token ${blank(`ghp_0123456789abcdefghijABCDEFGHIJ`)} is stale`);
    });
});
