import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { browserTool, BROWSER_DEFINITION } from '../src/tools/browser.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock puppeteer-core
// ─────────────────────────────────────────────────────────────────────────────

const mockPage = {
  goto: vi.fn().mockResolvedValue({ status: () => 200 }),
  title: vi.fn().mockResolvedValue('Test Page'),
  url: vi.fn().mockReturnValue('https://example.com'),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
  click: vi.fn().mockResolvedValue(undefined),
  type: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue('eval-result'),
  $eval: vi.fn().mockResolvedValue('element text'),
  waitForSelector: vi.fn().mockResolvedValue({}),
  isClosed: vi.fn().mockReturnValue(false),
  close: vi.fn().mockResolvedValue(undefined),
  setDefaultTimeout: vi.fn(),
};

const mockBrowser = {
  connected: true,
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock('puppeteer-core', () => ({
  default: { launch: vi.fn().mockResolvedValue(mockBrowser) },
  launch: vi.fn().mockResolvedValue(mockBrowser),
}));

// Mock child_process for findChrome
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('/usr/bin/google-chrome'),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

describe('BROWSER_DEFINITION', () => {
  it('has correct name', () => {
    expect(BROWSER_DEFINITION.name).toBe('browser');
  });

  it('requires action parameter', () => {
    expect(BROWSER_DEFINITION.parameters.required).toEqual(['action']);
  });

  it('has action property', () => {
    expect(BROWSER_DEFINITION.parameters.properties).toHaveProperty('action');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Action validation
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — validation', () => {
  it('returns error for unknown action', async () => {
    const result = await browserTool({ action: 'nonexistent' as any });
    expect(result).toContain('Error: Unknown browser action');
  });

  it('requires url for goto', async () => {
    const result = await browserTool({ action: 'goto' });
    expect(result).toContain('Error: url is required');
  });

  it('requires selector for click', async () => {
    const result = await browserTool({ action: 'click' });
    expect(result).toContain('Error: selector is required');
  });

  it('requires selector for type', async () => {
    const result = await browserTool({ action: 'type', text: 'hello' });
    expect(result).toContain('Error: selector is required');
  });

  it('requires text for type', async () => {
    const result = await browserTool({ action: 'type', selector: '#input' });
    expect(result).toContain('Error: text is required');
  });

  it('requires script for evaluate', async () => {
    const result = await browserTool({ action: 'evaluate' });
    expect(result).toContain('Error: script is required');
  });

  it('requires selector for get_text', async () => {
    const result = await browserTool({ action: 'get_text' });
    expect(result).toContain('Error: selector is required');
  });

  it('requires selector for get_html', async () => {
    const result = await browserTool({ action: 'get_html' });
    expect(result).toContain('Error: selector is required');
  });

  it('requires selector for wait_for', async () => {
    const result = await browserTool({ action: 'wait_for' });
    expect(result).toContain('Error: selector is required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Launch
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — launch', () => {
  it('launches browser and returns success', async () => {
    const result = await browserTool({ action: 'launch' });
    expect(result).toContain('Browser launched');
    expect(result).toContain('Connected: true');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Goto
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — goto', () => {
  it('navigates to URL and returns status', async () => {
    const result = await browserTool({ action: 'goto', url: 'https://example.com' });
    expect(result).toContain('Navigated to');
    expect(result).toContain('HTTP 200');
    expect(result).toContain('Test Page');
  });

  it('uses custom wait_until', async () => {
    await browserTool({ action: 'goto', url: 'https://example.com', wait_until: 'networkidle0' });
    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ waitUntil: 'networkidle0' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Screenshot
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — screenshot', () => {
  it('takes screenshot and returns base64', async () => {
    const result = await browserTool({ action: 'screenshot' });
    expect(result).toContain('Screenshot taken');
    expect(result).toContain('base64');
  });

  it('supports full_page option', async () => {
    await browserTool({ action: 'screenshot', full_page: true });
    expect(mockPage.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Click
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — click', () => {
  it('clicks element by selector', async () => {
    const result = await browserTool({ action: 'click', selector: '#button' });
    expect(result).toContain('Clicked: #button');
    expect(mockPage.waitForSelector).toHaveBeenCalledWith('#button', expect.anything());
    expect(mockPage.click).toHaveBeenCalledWith('#button');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — type', () => {
  it('types text into element', async () => {
    const result = await browserTool({ action: 'type', selector: '#input', text: 'hello world' });
    expect(result).toContain('Typed "hello world"');
    expect(mockPage.type).toHaveBeenCalledWith('#input', 'hello world');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evaluate
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — evaluate', () => {
  it('evaluates JavaScript and returns result', async () => {
    const result = await browserTool({ action: 'evaluate', script: 'document.title' });
    expect(result).toContain('JS result');
    expect(result).toContain('eval-result');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Get text
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — get_text', () => {
  it('gets text content of element', async () => {
    const result = await browserTool({ action: 'get_text', selector: '.content' });
    expect(result).toContain('Text content of .content');
    expect(result).toContain('element text');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scroll
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — scroll', () => {
  it('scrolls by given amount', async () => {
    const result = await browserTool({ action: 'scroll', x: 0, y: 500 });
    expect(result).toContain('Scrolled by (0, 500)');
  });

  it('uses default scroll amount', async () => {
    const result = await browserTool({ action: 'scroll' });
    expect(result).toContain('Scrolled by (0, 500)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Close
// ─────────────────────────────────────────────────────────────────────────────

describe('browserTool — close', () => {
  it('closes browser', async () => {
    const result = await browserTool({ action: 'close' });
    expect(result).toContain('Browser closed');
  });
});
