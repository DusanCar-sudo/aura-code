/**
 * Terminal markdown renderer — converts markdown text to ANSI-colored
 * terminal output. Supports: headings, code blocks (fenced + inline),
 * lists, bold/italic, horizontal rules, and links.
 *
 * Uses Aura's ruby/gold palette from diamond.ts.
 */
import chalk from 'chalk';
import { GOLD_HEX, GOLD_DIM_HEX, RUBY_ACCENT } from './diamond.js';

const GOLD = chalk.hex(GOLD_HEX);
const GOLD_DIM = chalk.hex(GOLD_DIM_HEX);
const RUBY = RUBY_ACCENT;
const CODE_BG = chalk.hex('#3d3027');
const HEADING = chalk.hex('#cc785c');

/**
 * Render a markdown string into terminal-colored lines.
 * Returns an array of pre-styled strings (one per terminal row).
 */
export function renderMarkdown(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = fenceMatch[1] || '';
        out.push(GOLD_DIM(`  ┌─ ${codeLang || 'code'} ─────`));
      } else {
        inCodeBlock = false;
        out.push(GOLD_DIM('  └─────────────'));
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(CODE_BG(`  │ ${line}`));
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      out.push(GOLD_DIM('  ' + '─'.repeat(40)));
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      if (level === 1) {
        out.push('');
        out.push(HEADING.bold(`  ${text}`));
        out.push(GOLD_DIM('  ' + '─'.repeat(Math.min(text.length + 2, 60))));
      } else if (level === 2) {
        out.push('');
        out.push(HEADING.bold(`  ${text}`));
      } else {
        out.push(HEADING(`  ${'  '.repeat(level - 2)}▸ ${text}`));
      }
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      const indent = ulMatch[1].length;
      const item = ulMatch[2];
      out.push(GOLD('  ' + '  '.repeat(indent) + '• ') + renderInline(item));
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      const indent = olMatch[1].length;
      const num = olMatch[2];
      const item = olMatch[3];
      out.push(RUBY('  ' + '  '.repeat(indent) + `${num}. `) + renderInline(item));
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      out.push(GOLD_DIM('  │ ') + renderInline(line.slice(1).trim()));
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      out.push('');
      continue;
    }

    // Regular paragraph
    out.push('  ' + renderInline(line));
  }

  return out;
}

/**
 * Render inline markdown: **bold**, *italic*, `code`, [links](url).
 */
function renderInline(text: string): string {
  let result = text;

  // Inline code — `code`
  result = result.replace(/`([^`]+)`/g, (_, code) => CODE_BG(code));

  // Bold — **text** or __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, (_, t) => GOLD.bold(t));
  result = result.replace(/__([^_]+)__/g, (_, t) => GOLD.bold(t));

  // Italic — *text* or _text_
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => chalk.italic(t));
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, (_, t) => chalk.italic(t));

  // Links — [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    return HEADING.underline(label) + GOLD_DIM(` (${url})`);
  });

  return result;
}
