import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, positions, render, resourceName } from "./messages.mjs";

const android = (message, english = message) => {
    const order = positions(parse(english));
    return parse(message).map((form) => render(form, order, order.size > 0 || parse(message).length > 1));
};

test(`placeholders take their position from the English message, whatever order a translation uses`, () => {
    assert.deepEqual(android(`{count} file, {size} so far.`), [`%1$s file, %2$s so far.`]);
    assert.deepEqual(android(`Na razie {size}: {count} plik.`, `{count} file, {size} so far.`), [`Na razie %2$s: %1$s plik.`]);
    assert.throws(() => android(`{other}`, `{count}`), /not a placeholder of the English message/);
});

test(`a plural splits into its forms, the spaces around each bar dropped`, () => {
    assert.deepEqual(android(`{count} agent needs you | {count} agents need you`), [`%1$s agent needs you`, `%1$s agents need you`]);
});

test(`what Android reads specially is escaped`, () => {
    assert.deepEqual(android(`It's "here" & <b>`), [`It\\'s \\"here\\" &amp; &lt;b&gt;`]);
    assert.deepEqual(android(`you{'@'}example.com`), [`you@example.com`]);
    assert.deepEqual(android(`{'@'}handle`), [`\\@handle`]);
    assert.deepEqual(android(`? marks`), [`\\? marks`]);
    assert.deepEqual(android(`a\\b\nc`), [`a\\\\b\\nc`]);
    assert.deepEqual(android(`two  spaces`), [`"two  spaces"`]);
});

test(`a percent sign is doubled only where String.format will read it`, () => {
    assert.deepEqual(android(`100% done`), [`100% done`]);
    assert.deepEqual(android(`{n}% done`), [`%1$s%% done`]);
});

test(`a linked message or an unknown construct stops the run`, () => {
    assert.throws(() => parse(`see @:other.key`), /linked message/);
    assert.throws(() => parse(`{a b}`), /no Android reading/);
    assert.throws(() => parse(`{open`), /unclosed/);
});

test(`a dotted camelCase key becomes a snake_case resource name`, () => {
    assert.equal(resourceName(`auth.login.welcomeToIntentic`), `auth_login_welcome_to_intentic`);
    assert.equal(resourceName(`organisations.section.data-protection`), `organisations_section_data_protection`);
    assert.throws(() => resourceName(`9lives`), /no resource name/);
});
