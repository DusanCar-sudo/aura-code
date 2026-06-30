import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { getApiKey } from '../util/env.js';
import type { FineTuneJob } from './types.js';

const execFileAsync = promisify(execFile);

interface JsonlRow {
  messages?: { role: string; content: string }[];
}

interface OllamaTagsResponse {
  models?: { name: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama — Modelfile-based specialization (no native fine-tune API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a specialised Ollama model via `ollama create` and a generated Modelfile.
 * Returns a completed or failed {@link FineTuneJob}; does not throw.
 */
export async function fineTuneWithOllama(
  baseModel: string,
  trainingDataPath: string,
  outputModelName: string,
): Promise<FineTuneJob> {
  const id = `ollama-${randomUUID()}`;
  const startedAt = Date.now();
  let trainingExamples = 0;

  try {
    const raw = await fs.promises.readFile(trainingDataPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    trainingExamples = lines.length;

    const snippets: string[] = [];
    for (const line of lines.slice(0, 50)) {
      try {
        const row = JSON.parse(line) as JsonlRow;
        const user = row.messages?.find(m => m.role === 'user')?.content ?? '';
        const assistant = row.messages?.find(m => m.role === 'assistant')?.content ?? '';
        if (user || assistant) {
          snippets.push(`User: ${user}\nAssistant: ${assistant}`);
        }
      } catch {
        /* skip bad line */
      }
    }

    const systemBlock = [
      'You are a specialized coding assistant.',
      'Learn from these corrected examples where a larger model intervened:',
      ...snippets,
    ].join('\n\n');

    const modelfile = [
      `FROM ${baseModel}`,
      'SYSTEM """',
      systemBlock.replace(/"""/g, "'''"),
      '"""',
    ].join('\n');

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rubycode-ft-'));
    const modelfilePath = path.join(tmpDir, 'Modelfile');
    await fs.promises.writeFile(modelfilePath, modelfile, 'utf8');

    await execFileAsync('ollama', ['create', outputModelName, '-f', modelfilePath], {
      timeout: 300_000,
    });

    return {
      id,
      status: 'completed',
      baseModel,
      trainingExamples,
      outputModel: outputModelName,
      startedAt,
      completedAt: Date.now(),
    };
  } catch (e) {
    return {
      id,
      status: 'failed',
      baseModel,
      trainingExamples,
      outputModel: outputModelName,
      startedAt,
      completedAt: Date.now(),
      error: String(e),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI — native fine-tuning API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uploads JSONL training data and starts an OpenAI fine-tuning job.
 * Returns `failed` when `OPENAI_API_KEY` is unset; does not throw.
 */
export async function fineTuneWithOpenAI(
  trainingDataPath: string,
  baseModel = 'gpt-3.5-turbo',
): Promise<FineTuneJob> {
  const startedAt = Date.now();
  const apiKey = getApiKey('OPENAI_API_KEY');

  if (!apiKey) {
    return {
      id: `openai-${randomUUID()}`,
      status: 'failed',
      baseModel,
      trainingExamples: 0,
      outputModel: '',
      startedAt,
      completedAt: Date.now(),
      error: 'OPENAI_API_KEY is not set',
    };
  }

  try {
    const raw = await fs.promises.readFile(trainingDataPath, 'utf8');
    const trainingExamples = raw.split('\n').filter(l => l.trim()).length;

    const client = new OpenAI({ apiKey });
    const file = await client.files.create({
      file: fs.createReadStream(trainingDataPath),
      purpose: 'fine-tune',
    });

    const job = await client.fineTuning.jobs.create({
      training_file: file.id,
      model: baseModel,
    });

    return {
      id: `openai-${job.id}`,
      status: 'running',
      baseModel,
      trainingExamples,
      outputModel: job.fine_tuned_model ?? '',
      startedAt,
    };
  } catch (e) {
    return {
      id: `openai-${randomUUID()}`,
      status: 'failed',
      baseModel,
      trainingExamples: 0,
      outputModel: '',
      startedAt,
      completedAt: Date.now(),
      error: String(e),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Job status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refreshes a {@link FineTuneJob} from Ollama tags or the OpenAI fine-tuning API.
 * Never throws — returns the input job on unrecoverable errors.
 */
export async function checkJobStatus(job: FineTuneJob): Promise<FineTuneJob> {
  try {
    if (!job?.id) return job;

    if (job.id.startsWith('openai-')) {
      return checkOpenAIJobStatus(job);
    }
    return checkOllamaJobStatus(job);
  } catch {
    return job;
  }
}

async function checkOllamaJobStatus(job: FineTuneJob): Promise<FineTuneJob> {
  if (job.status === 'failed' || job.status === 'completed') return job;

  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return { ...job, status: 'failed', error: 'Ollama tags API unreachable' };
    const body = (await res.json()) as OllamaTagsResponse;
    const names = (body.models ?? []).map(m => m.name);
    const exists = names.some(
      n =>
        n === job.outputModel ||
        n.startsWith(`${job.outputModel}:`) ||
        n.split(':')[0] === job.outputModel,
    );
    if (exists) {
      return { ...job, status: 'completed', completedAt: job.completedAt ?? Date.now() };
    }
    return { ...job, status: 'failed', error: `Model ${job.outputModel} not found in Ollama` };
  } catch (e) {
    return { ...job, status: 'failed', error: String(e), completedAt: Date.now() };
  }
}

async function checkOpenAIJobStatus(job: FineTuneJob): Promise<FineTuneJob> {
  const apiKey = getApiKey('OPENAI_API_KEY');
  if (!apiKey) {
    return {
      ...job,
      status: 'failed',
      error: 'OPENAI_API_KEY is not set',
      completedAt: Date.now(),
    };
  }

  const openaiId = job.id.replace(/^openai-/, '');
  try {
    const client = new OpenAI({ apiKey });
    const remote = await client.fineTuning.jobs.retrieve(openaiId);

    const statusMap: Record<string, FineTuneJob['status']> = {
      validating_files: 'pending',
      queued: 'pending',
      running: 'running',
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'failed',
    };

    const status = statusMap[remote.status] ?? job.status;
    const terminal = status === 'completed' || status === 'failed';

    return {
      ...job,
      status,
      outputModel: remote.fine_tuned_model ?? job.outputModel,
      completedAt: terminal ? Date.now() : job.completedAt,
      error: remote.error?.message ?? job.error,
    };
  } catch (e) {
    return { ...job, status: 'failed', error: String(e), completedAt: Date.now() };
  }
}