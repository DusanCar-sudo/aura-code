import * as fs from 'fs';
import * as path from 'path';
import type { ProjectPerception } from '../perception/types.js';
import type { Episode, TrainingExample } from './types.js';

/**
 * Builds instruction-tuning rows from episodes where Ruby failed and the large
 * model produced an approved correction.
 */
export async function generateTrainingData(
  episodes: Episode[],
  perception: ProjectPerception,
): Promise<TrainingExample[]> {
  try {
    if (!Array.isArray(episodes)) return [];

    const vision = perception?.trajectory?.vision ?? 'Complete coding tasks accurately.';
    const instruction = [
      'You are a specialized coding assistant for this project.',
      vision,
      perception?.constraints?.strictRules?.length
        ? `Constraints: ${perception.constraints.strictRules.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    const examples: TrainingExample[] = [];

    for (const ep of episodes) {
      if (!ep?.rubyAttempted || ep.rubySucceeded) continue;
      if (!ep.largeModelOutput?.trim()) continue;
      if (!ep.reviewerApproved) continue;

      examples.push({
        instruction,
        input: ep.task,
        output: ep.largeModelOutput,
        metadata: {
          projectRoot: ep.projectRoot,
          taskCategory: ep.taskCategory,
          rubyFailureReason: ep.rubyOutput
            ? `Ruby output insufficient: ${ep.rubyOutput.slice(0, 200)}`
            : 'Ruby did not produce an acceptable result',
          timestamp: ep.timestamp,
        },
      });
    }

    return examples;
  } catch {
    return [];
  }
}

/**
 * Writes training examples as OpenAI-style JSONL for fine-tuning or Modelfile context.
 */
export async function exportJSONL(
  examples: TrainingExample[],
  outputPath: string,
): Promise<void> {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const lines = (examples ?? []).map(ex => {
    const userContent = `${ex.instruction}\n\n${ex.input}`;
    const row = {
      messages: [
        { role: 'user', content: userContent },
        { role: 'assistant', content: ex.output },
      ],
    };
    return JSON.stringify(row);
  });

  const tmp = outputPath + '.tmp';
  await fs.promises.writeFile(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  await fs.promises.rename(tmp, outputPath);
}