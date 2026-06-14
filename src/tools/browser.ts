import type { ToolDefinition } from '../providers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Browser — headless Chrome automation via Puppeteer
// ─────────────────────────────────────────────────────────────────────────────

let browser: import('puppeteer-core').Browser | null = null;
let page: import('puppeteer-core').Page | null = null;

export interface BrowserInput {
  action: 'launch' | 'goto' | 'screenshot' | 'click' | 'type' | 'evaluate' | 'get_text' | 'get_html' | 'wait_for' | 'scroll' | 'close';
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  full_page?: boolean;
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  timeout_ms?: number;
  x?: number;
  y?: number;
}

export const BROWSER_DEFINITION: ToolDefinition = {
  name: 'browser',
  description:
    'Automate a headless Chrome browser. Actions: launch, goto, screenshot, click, type, evaluate (JS), get_text, get_html, wait_for, scroll, close. ' +
    'Use for scraping SPAs, testing web apps, filling forms, taking screenshots. Call launch first, then goto to navigate.',
  parameters: {
    type: 'object',
    properties: {
      action:      { type: 'string', description: 'The browser action to perform' },
      url:         { type: 'string', description: 'URL to navigate to (for goto)' },
      selector:    { type: 'string', description: 'CSS selector for click/type/get_text/get_html/wait_for' },
      text:        { type: 'string', description: 'Text to type (for type action)' },
      script:      { type: 'string', description: 'JavaScript to evaluate (for evaluate action)' },
      full_page:   { type: 'boolean', description: 'Take full page screenshot (default: false, viewport only)' },
      wait_until:  { type: 'string', description: 'Navigation wait condition: load, domcontentloaded, networkidle0, networkidle2 (default: load)' },
      timeout_ms:  { type: 'number', description: 'Timeout in ms (default: 30000)' },
      x:           { type: 'number', description: 'Horizontal scroll pixels (for scroll action, negative = up)' },
      y:           { type: 'number', description: 'Vertical scroll pixels (for scroll action, negative = up)' },
    },
    required: ['action'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Browser management
// ─────────────────────────────────────────────────────────────────────────────

async function ensureBrowser(): Promise<import('puppeteer-core').Browser> {
  if (browser?.connected) return browser;

  const puppeteer = await import('puppeteer-core');
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Install google-chrome or chromium-browser.',
    );
  }

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  browser.on('disconnected', () => {
    browser = null;
    page = null;
  });

  return browser;
}

async function ensurePage(): Promise<import('puppeteer-core').Page> {
  if (page && !page.isClosed()) return page;
  const b = await ensureBrowser();
  page = await b.newPage();
  page.setDefaultTimeout(30_000);
  return page;
}

function findChrome(): string | null {
  const { execSync } = require('child_process');
  const candidates = [
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  for (const cmd of candidates) {
    try {
      execSync(`which ${cmd}`, { stdio: 'pipe' });
      return cmd;
    } catch {
      // not found, try next
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function doLaunch(): Promise<string> {
  const b = await ensureBrowser();
  return `Browser launched (Chrome). Connected: ${b.connected}`;
}

async function doGoto(url: string, waitUntil?: string, timeout?: number): Promise<string> {
  const p = await ensurePage();
  const waitOpt = (waitUntil ?? 'load') as any;
  const response = await p.goto(url, { waitUntil: waitOpt, timeout: timeout ?? 30_000 });
  const status = response?.status() ?? 0;
  const title = await p.title();
  const currentUrl = p.url();
  return `Navigated to: ${currentUrl}\nHTTP ${status}\nTitle: ${title}`;
}

async function doScreenshot(fullPage?: boolean): Promise<string> {
  const p = await ensurePage();
  const buffer = await p.screenshot({ fullPage: fullPage ?? false, type: 'png' });
  const base64 = buffer.toString('base64');
  return `Screenshot taken (${buffer.length} bytes, base64 length: ${base64.length}). Data:\ndata:image/png;base64,${base64.slice(0, 200)}... [truncated — full base64 is ${base64.length} chars]`;
}

async function doClick(selector: string, timeout?: number): Promise<string> {
  const p = await ensurePage();
  await p.waitForSelector(selector, { timeout: timeout ?? 10_000 });
  await p.click(selector);
  return `Clicked: ${selector}`;
}

async function doType(selector: string, text: string, timeout?: number): Promise<string> {
  const p = await ensurePage();
  await p.waitForSelector(selector, { timeout: timeout ?? 10_000 });
  await p.type(selector, text);
  return `Typed "${text}" into ${selector}`;
}

async function doEvaluate(script: string): Promise<string> {
  const p = await ensurePage();
  const result = await p.evaluate(script);
  const serialized = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return `JS result:\n${serialized}`;
}

async function doGetText(selector: string, timeout?: number): Promise<string> {
  const p = await ensurePage();
  await p.waitForSelector(selector, { timeout: timeout ?? 10_000 });
  const text = await p.$eval(selector, (el: any) => el.textContent?.trim() ?? '');
  return `Text content of ${selector}:\n${text}`;
}

async function doGetHtml(selector: string, timeout?: number): Promise<string> {
  const p = await ensurePage();
  await p.waitForSelector(selector, { timeout: timeout ?? 10_000 });
  const html = await p.$eval(selector, (el: any) => el.innerHTML);
  return `HTML content of ${selector}:\n${html.slice(0, 20_000)}`;
}

async function doWaitFor(selector: string, timeout?: number): Promise<string> {
  const p = await ensurePage();
  await p.waitForSelector(selector, { timeout: timeout ?? 10_000 });
  return `Element appeared: ${selector}`;
}

async function doScroll(x?: number, y?: number): Promise<string> {
  const p = await ensurePage();
  await p.evaluate((dx: number, dy: number) => window.scrollBy(dx, dy), x ?? 0, y ?? 500);
  return `Scrolled by (${x ?? 0}, ${y ?? 500})`;
}

async function doClose(): Promise<string> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
  return 'Browser closed.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main executor
// ─────────────────────────────────────────────────────────────────────────────

export async function browserTool(input: BrowserInput): Promise<string> {
  try {
    switch (input.action) {
      case 'launch':
        return await doLaunch();

      case 'goto':
        if (!input.url) return 'Error: url is required for goto';
        return await doGoto(input.url, input.wait_until, input.timeout_ms);

      case 'screenshot':
        return await doScreenshot(input.full_page);

      case 'click':
        if (!input.selector) return 'Error: selector is required for click';
        return await doClick(input.selector, input.timeout_ms);

      case 'type':
        if (!input.selector) return 'Error: selector is required for type';
        if (input.text === undefined) return 'Error: text is required for type';
        return await doType(input.selector, input.text, input.timeout_ms);

      case 'evaluate':
        if (!input.script) return 'Error: script is required for evaluate';
        return await doEvaluate(input.script);

      case 'get_text':
        if (!input.selector) return 'Error: selector is required for get_text';
        return await doGetText(input.selector, input.timeout_ms);

      case 'get_html':
        if (!input.selector) return 'Error: selector is required for get_html';
        return await doGetHtml(input.selector, input.timeout_ms);

      case 'wait_for':
        if (!input.selector) return 'Error: selector is required for wait_for';
        return await doWaitFor(input.selector, input.timeout_ms);

      case 'scroll':
        return await doScroll(input.x, input.y);

      case 'close':
        return await doClose();

      default:
        return `Error: Unknown browser action: ${input.action}`;
    }
  } catch (e: any) {
    return `Browser error (${input.action}): ${e?.message ?? String(e)}`;
  }
}
