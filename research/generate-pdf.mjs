/**
 * Generates PDF from the cancer-deep-dive.html using Puppeteer.
 * Usage: node research/generate-pdf.mjs
 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'cancer-deep-dive.html');
const pdfPath = path.join(__dirname, 'cancer-deep-dive.pdf');

if (!fs.existsSync(htmlPath)) {
  console.error('HTML file not found:', htmlPath);
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

  await page.pdf({
    path: pdfPath,
    format: 'A4',
    margin: { top: '15mm', right: '12mm', bottom: '15mm', left: '12mm' },
    printBackground: true,
    displayHeaderFooter: false,
    preferCSSPageSize: false,
  });

  const stats = fs.statSync(pdfPath);
  console.log(`PDF generated: ${pdfPath}`);
  console.log(`File size: ${(stats.size / 1024).toFixed(1)} KB`);
} finally {
  await browser.close();
}
