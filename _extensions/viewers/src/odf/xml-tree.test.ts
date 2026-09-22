import { describe, it, expect } from "bun:test";
import { attr, child, descendant, descendants, parseXml, textOf } from "./xml-tree";

/* The parse every document viewer stands on. */

const parse = (source: string) => {
    const root = parseXml(source);
    if (root === undefined) {
        throw new Error(`nothing parsed`);
    }
    return root;
};

describe(`parseXml`, () => {
    it(`keys tags by namespace, not by the prefix the file happened to choose`, () => {
        // The same document written with different prefixes has to read identically; a file may bind any prefix.
        const usual = parse(`<office:body xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:text/></office:body>`);
        const odd = parse(`<x:body xmlns:x="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><x:text/></x:body>`);
        expect(usual.tag).toBe(`office:body`);
        expect(odd.tag).toBe(`office:body`);
        expect(descendant(odd, `office:text`)).toMatchObject({ tag: `office:text` });
    });

    it(`keys a tag from an unknown namespace by its URI, so it cannot collide with one in no namespace`, () => {
        // Two vendors may both bind the prefix `v`; the URI is what tells their elements apart.
        const root = parse(`<root xmlns:v="urn:vendor"><v:thing/><thing/></root>`);
        expect(root.children.filter((node) => `tag` in node).map((node) => (`tag` in node ? node.tag : ``))).toEqual([`urn:vendor:thing`, `thing`]);
    });

    it(`reads attributes, including a prefixed one, and leaves an unprefixed one in no namespace`, () => {
        const root = parse(`<p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" text:style-name="P1" id="x"/>`);
        expect(attr(root, `text:style-name`)).toBe(`P1`);
        expect(attr(root, `id`)).toBe(`x`);
    });

    it(`decodes entities and character references in text and in attributes`, () => {
        const root = parse(`<p title="a &amp; b">5 &lt; 6 &#65; &#x42;</p>`);
        expect(textOf(root)).toBe(`5 < 6 A B`);
        expect(attr(root, `title`)).toBe(`a & b`);
    });

    it(`takes CDATA as text with markup switched off`, () => {
        expect(textOf(parse(`<p><![CDATA[<not a tag> & co]]></p>`))).toBe(`<not a tag> & co`);
    });

    it(`ignores the prolog, comments and the doctype`, () => {
        const root = parse(`<?xml version="1.0"?><!DOCTYPE html><!-- note --><p>text<!-- inner --></p>`);
        expect(root.tag).toBe(`p`);
        expect(textOf(root)).toBe(`text`);
    });

    it(`handles self-closing tags and single-quoted attributes`, () => {
        const root = parse(`<p><br/><span class='big'>x</span></p>`);
        expect(child(root, `br`)?.children).toEqual([]);
        expect(attr(child(root, `span`), `class`)).toBe(`big`);
    });

    it(`keeps what parsed when the file is cut off mid-document`, () => {
        // Half a spreadsheet beats an error page: an unclosed tag is closed at the end rather than thrown away.
        const root = parse(`<table><row><cell>kept</cell></row>`);
        expect(textOf(root)).toBe(`kept`);
        expect(descendants(root, `cell`)).toHaveLength(1);
    });

    it(`finds descendants in document order and stops at the first when asked for one`, () => {
        const root = parse(`<a><b><c>1</c></b><c>2</c></a>`);
        expect(descendants(root, `c`).map((node) => textOf(node))).toEqual([`1`, `2`]);
        expect(textOf(descendant(root, `c`) ?? root)).toBe(`1`);
    });

    it(`answers with nothing for input holding no element at all`, () => {
        expect(parseXml(`   `)).toBeUndefined();
        expect(parseXml(`<!-- just a comment -->`)).toBeUndefined();
    });
});
