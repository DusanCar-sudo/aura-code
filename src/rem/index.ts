import * as fs from 'fs';
import * as path from 'path';
import { loadRemGraph, type RemGraph } from './graph.js';
import { renderRemTerminal } from './render-terminal.js';
import { wrapRemHtml } from './render-html.js';

export interface RemRunResult {
  graph: RemGraph;
  terminalOutput: string;
  htmlPath?: string;
}

/**
 * Run `:rem` — load every dream file, build the relations graph, and render
 * it for the terminal. If `writeHtml` is true, also write a standalone
 * `dreams/rem.html` (overwritten each run — it's a current snapshot, not a
 * dated artifact like dream/research/council files).
 */
export function runRem(opts: { projectRoot: string; writeHtml?: boolean }): RemRunResult {
  const graph = loadRemGraph(opts.projectRoot);
  const terminalOutput = renderRemTerminal(graph);

  if (!opts.writeHtml) {
    return { graph, terminalOutput };
  }

  const dir = path.join(opts.projectRoot, 'dreams');
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, 'rem.html');
  fs.writeFileSync(htmlPath, wrapRemHtml(graph));

  return { graph, terminalOutput, htmlPath };
}
