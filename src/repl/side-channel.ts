/**
 * :btw — Side channel for non-blocking parallel questions.
 *
 * Spawns an isolated LLM call (no session history, read-only) to answer
 * a quick question while the main task keeps running. The answer is
 * rendered as a simple overlay and never appears in chat history.
 */
import type { LLMProvider } from '../providers/types.js';
import type { ProjectContext } from '../agent/context.js';
import chalk from 'chalk';

const BTW_SYSTEM_PROMPT = `You are Aura's "by the way" side channel.
Answer the user's quick question concisely in 2-4 sentences.
Do NOT use tools. Do NOT write code. Just answer from knowledge.
If you don't know, say so briefly.`;

export interface BtwResult {
  answer: string;
  tokens: number;
}

/**
 * Run a :btw query in the current provider but with a clean (empty) chat
 * history — strictly a read-only knowledge question.
 */
export async function runBtwQuery(
  question: string,
  provider: LLMProvider,
  ctx: ProjectContext,
): Promise<BtwResult> {
  const stream = provider.stream(BTW_SYSTEM_PROMPT, [
    { role: 'user', content: `:btw ${question}` },
  ], []);
  let answer = '';
  let totalTokens = 0;

  for await (const chunk of stream) {
    if (chunk.type === 'text') {
      answer += chunk.text;
    } else if (chunk.type === 'done') {
      const usage = chunk.response.usage;
      if (usage) totalTokens = usage.inputTokens + usage.outputTokens;
    }
  }

  return { answer: answer.trim(), tokens: totalTokens };
}

/**
 * Render a :btw answer as a minimalist overlay box.
 * Returns an object with the rendered lines + a dismiss instruction.
 */
export function renderBtwAnswer(answer: string, tokens: number): string {
  const maxWidth = 60;
  const lines: string[] = [];
  for (const word of answer.split(' ')) {
    const last = lines[lines.length - 1];
    if (!last || last.length + word.length + 1 > maxWidth) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = last + ' ' + word;
    }
  }

  const top    = chalk.hex('#cc785c')('  ┌' + '─'.repeat(maxWidth + 2) + '┐');
  const bottom = chalk.hex('#cc785c')('  └' + '─'.repeat(maxWidth + 2) + '┘');
  const body   = lines.map(l => chalk.hex('#ede0cc')('  │ ') + l.padEnd(maxWidth) + chalk.hex('#cc785c')(' │'));

  return [
    '',
    top,
    ...body,
    bottom,
    chalk.hex('#4e3d30')(`  ⚡ ${tokens} tokens — press ENTER to dismiss`),
    '',
  ].join('\n');
}
