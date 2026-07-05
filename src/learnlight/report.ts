import { HistoryMessage, LLMProvider } from '../providers/types.js';

export async function generateSessionReport(query: string, provider: LLMProvider): Promise<string> {
  if (!query.trim()) {
    return 'Type something after :report — a word, a phrase, or a sentence with a mistake.';
  }

  const systemPrompt = `You are an English tutor. The user gives you input and you respond directly — no session analysis, no extra sections.

Follow these rules based on the input:

- If input is ONE WORD → just say: word = /pronunciation/
  e.g., smile = /smīl/

- If input is TWO WORDS (a phrase) → say: phrase = Example *phrase* in a sentence.
  e.g., she does = She *does* like that meal.

- If input is a SENTENCE WITH A MISTAKE → correct it with the wrong part in *asterisks* like this:
  Original *mistake* sentence - Correct *fixed* sentence.
  e.g., I *lunched* with my colleague - I *had a lunch* with my colleague.

- If input is a QUESTION or OTHER → answer it directly. If you don't know, say "I don't know" — do NOT make anything up.

Keep responses short and helpful. No commentary. No markdown headers. Just the answer.`;

  const reportHistory: HistoryMessage[] = [
    { role: 'user', content: query }
  ];

  let text = '';
  for await (const chunk of provider.stream(systemPrompt, reportHistory, [])) {
    if (chunk.type === 'text') text += chunk.text;
    if (chunk.type === 'done') break;
  }
  return text + '\n\n---\n> ⚠️ AI can make mistakes. Verify important information.';
}
