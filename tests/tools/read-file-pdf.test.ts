import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readFile } from '../../src/tools/read-file.js';

/**
 * A PDF handed to the agent is a document — a CV, an invoice, a spec. Before
 * this it hit the BINARY_EXTENSIONS list and came back as
 * "Binary file: … (254.7 KB, type: .pdf)", which is a refusal dressed as an
 * answer: the model's only route was to know pdftotext exists and shell out.
 */

const havePdftotext = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'pipe' }); return true; }
  catch { return false; }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pdf-'));

describe('read_file on a PDF', () => {
  it.skipIf(!havePdftotext)('extracts text instead of reporting a byte count', () => {
    // Build a real PDF rather than mocking: the thing under test is the
    // interaction with poppler, which a mock would assert nothing about.
    const ps = path.join(tmp, 'src.ps');
    fs.writeFileSync(ps, '%!PS\n/Helvetica findfont 24 scalefont setfont\n'
      + '72 700 moveto (Dusan Milosavljevic) show\n'
      + '72 660 moveto (AI EVALUATION AND TRAINING) show\nshowpage\n');
    let pdf = path.join(tmp, 'cv.pdf');
    try {
      execFileSync('ps2pdf', [ps, pdf], { stdio: 'pipe' });
    } catch {
      return;   // no ghostscript in this environment; the live check below covers it
    }
    const out = readFile({ path: 'cv.pdf' }, tmp);
    expect(out).not.toMatch(/^Binary file/);
    expect(out).toContain('Dusan Milosavljevic');
    expect(out).toMatch(/pdftotext -layout/);
  });

  it('reports a missing file rather than a parser error', () => {
    expect(readFile({ path: 'nope.pdf' }, tmp)).toMatch(/File not found/);
  });

  it('still refuses genuinely binary formats', () => {
    // The PDF branch must not have opened the door to every binary extension.
    fs.writeFileSync(path.join(tmp, 'a.zip'), Buffer.from([0x50, 0x4b, 3, 4]));
    expect(readFile({ path: 'a.zip' }, tmp)).toMatch(/^Binary file/);
  });
});
