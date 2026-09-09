import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFile } from '../../src/tools/read-file.js';

// Deterministic control over the PDF text layer: the extractor is mocked so the
// truncation logic under test does not depend on poppler/ghostscript existing
// in the environment (the live tests cover the real interaction).
const mocks = vi.hoisted(() => ({ extractPdfText: vi.fn() }));

vi.mock('../../src/tools/pdf-text.js', () => ({
  extractPdfText: mocks.extractPdfText,
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pdf-cap-'));
const pdfPath = path.join(tmp, 'doc.pdf');

beforeEach(() => {
  fs.writeFileSync(pdfPath, '%PDF-1.4 mock');   // content is irrelevant — extractor is mocked
});

describe('read_file PDF payload caps', () => {
  it('caps a long document at head + tail rows like the text path does', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `row ${i + 1} content`).join('\n');
    mocks.extractPdfText.mockResolvedValue({ text: rows, via: 'pdftotext' });

    const out = await readFile({ path: 'doc.pdf' }, tmp);
    expect(out).toContain('(300 lines, via pdftotext -layout');
    expect(out).toContain('showing first 120 + last 40');
    expect(out).toContain('rows omitted — pass start_line/end_line');
    expect(out).toContain('1\trow 1 content');
    expect(out).toContain('300\trow 300 content');
    // The middle rows are gone entirely, not re-sent.
    expect(out).not.toContain('row 150 content');
  });

  it('clips a single oversized layout row', async () => {
    const longRow = 'L'.repeat(2_000);
    mocks.extractPdfText.mockResolvedValue({ text: `short\n${longRow}\nend`, via: 'bundled pdf.js' });

    const out = await readFile({ path: 'doc.pdf' }, tmp);
    expect(out).toContain('…[row clipped]');
    expect(out).toContain('2\t' + 'L'.repeat(500) + ' …[row clipped]');
    // No run of more than 500 Ls survives.
    expect(out).not.toMatch(/L{501}/);
  });

  it('applies the row clip to range reads too', async () => {
    mocks.extractPdfText.mockResolvedValue({ text: `a\n${'R'.repeat(900)}\nc`, via: 'pdftotext' });
    const out = await readFile({ path: 'doc.pdf', start_line: 2, end_line: 2 }, tmp);
    expect(out).toContain('2\t' + 'R'.repeat(500) + ' …[row clipped]');
  });
});
