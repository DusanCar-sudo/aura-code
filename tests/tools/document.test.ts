import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { documentTool, DOCUMENT_DEFINITION } from '../../src/tools/document.js';
import { findChrome } from '../../src/util/chrome.js';
import { TOOL_DEFINITIONS, selectTools } from '../../src/tools/index.js';

const haveChrome = findChrome() !== null;

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-doc-')); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, html: string) => { fs.writeFileSync(path.join(dir, name), html); return name; };

describe('argument handling', () => {
  it('refuses a missing path, an absent file, and an unknown action', async () => {
    expect(await documentTool({ action: 'to_pdf' }, dir)).toMatch(/needs a path/);
    expect(await documentTool({ action: 'to_pdf', path: 'nope.html' }, dir)).toMatch(/not found/);
    write('x.html', '<p>x</p>');
    expect(await documentTool({ action: 'teleport', path: 'x.html' }, dir)).toMatch(/unknown document action/);
  });

  it('rejects a bad page format by name', async () => {
    write('y.html', '<p>y</p>');
    const r = await documentTool({ action: 'to_pdf', path: 'y.html', format: 'A9' }, dir);
    expect(r).toMatch(/unknown format "A9"/);
    expect(r).toMatch(/A4/);
  });

  it('refuses to escape the project root', async () => {
    // Rendering writes files, so the path jail matters as much as it does for
    // write_file — an unchecked output path is an arbitrary-write primitive.
    expect(await documentTool({ action: 'to_pdf', path: '../../etc/passwd' }, dir)).toMatch(/Error/);
  });

  it('inspect refuses a non-PDF instead of guessing', async () => {
    write('z.html', '<p>z</p>');
    expect(await documentTool({ action: 'inspect', path: 'z.html' }, dir)).toMatch(/is not one/);
  });
});

describe.skipIf(!haveChrome)('rendering', () => {
  it('renders a real document and confirms the content survived', { timeout: 90_000 }, async () => {
    write('good.html', '<!doctype html><html><body><h1>Report</h1>'
      + '<p>Substantial body text that will certainly extract from the PDF.</p></body></html>');
    const out = await documentTool({ action: 'to_pdf', path: 'good.html' }, dir);
    expect(out).toMatch(/Rendered good\.pdf/);
    expect(out).toMatch(/1 page/);
    expect(out).toMatch(/Content verified/);
    expect(fs.existsSync(path.join(dir, 'good.pdf'))).toBe(true);
  });

  it('reports a blank render as a PROBLEM rather than a success', { timeout: 90_000 }, async () => {
    // The failure this whole tool is shaped around: the file exists, has a
    // page, and a byte count — every signal says success except the content.
    write('blank.html', '<!doctype html><html><body>'
      + '<script>document.body.innerHTML="";throw new Error("BOOM")</script></body></html>');
    const out = await documentTool({ action: 'to_pdf', path: 'blank.html' }, dir);
    expect(out).toMatch(/Rendered blank\.pdf/);   // it does look like success…
    expect(out).toMatch(/PROBLEM/);               // …and is caught anyway
    expect(out).toMatch(/printed blank/i);
    expect(out).toMatch(/BOOM/);                  // with the cause attached
  });

  it('warns when content will be clipped by the page edge', { timeout: 90_000 }, async () => {
    write('wide.html', '<!doctype html><html><body><p>text</p>'
      + '<table style="width:3000px"><tr><td>far too wide</td></tr></table></body></html>');
    const out = await documentTool({ action: 'to_pdf', path: 'wide.html' }, dir);
    expect(out).toMatch(/WARNING/);
    expect(out).toMatch(/clipped/);
  });

  it('inspect reports pages, characters and embedded fonts', { timeout: 90_000 }, async () => {
    write('insp.html', '<!doctype html><html><body><h1>Inspect me</h1>'
      + '<p>Enough prose here to be clearly extractable text.</p></body></html>');
    await documentTool({ action: 'to_pdf', path: 'insp.html' }, dir);
    const out = await documentTool({ action: 'inspect', path: 'insp.pdf' }, dir);
    expect(out).toMatch(/1 page/);
    expect(out).toMatch(/characters of text/);
    expect(out).toMatch(/Content verified/);
  });

  it('renders PNG to the given output path', { timeout: 90_000 }, async () => {
    write('img.html', '<!doctype html><html><body><h1>Infographic</h1></body></html>');
    const out = await documentTool({ action: 'to_png', path: 'img.html', output: 'card.png' }, dir);
    expect(out).toMatch(/Rendered card\.png/);
    expect(fs.existsSync(path.join(dir, 'card.png'))).toBe(true);
  });
});

describe('registration', () => {
  it('is reachable by the model', () => {
    expect(TOOL_DEFINITIONS.some(d => d.name === 'document')).toBe(true);
  });

  it('ships only for printable-deliverable tasks', () => {
    const has = (t: string) => selectTools(t, []).some(d => d.name === 'document');
    expect(has('build my resume as a pdf')).toBe(true);
    expect(has('make a slide deck for the client')).toBe(true);
    expect(has('export the report to PDF')).toBe(true);
    // The trap: "document" is in half of all coding tasks, and matching it
    // would ship this schema on every single run.
    expect(has('document this function and add tests')).toBe(false);
    expect(has('refactor the parser')).toBe(false);
  });

  it('tells the model to verify, since a bad PDF looks like a good one', () => {
    expect(DOCUMENT_DEFINITION.description).toMatch(/inspect/);
    expect(DOCUMENT_DEFINITION.description).toMatch(/blank|fallback fonts/);
  });
});
