import type { ProjectContext } from '../agent/context.js';
import type { Display } from '../cli/display.js';
import { runAgentLoop } from '../agent/loop.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { PermissionSystem } from '../safety/permissions.js';

export async function runInspector(task: string, context: ProjectContext, display: Display): Promise<string> {
  display.success('Spawning Inspector Agent (Fast Model) to survey codebase...');
  
  // We use a fast model for the inspector (Dynamic Model Routing). 
  // In a real production setup this would map to Gemini 2.5 Flash, Haiku, or GPT-4o-mini.
  // We'll mock the provider config for this fast model here.
  const inspectorProvider = new AnthropicProvider({
    model: 'claude-3-5-haiku-20241022', // Cheaper/faster model
  });

  const inspectorTask = `
INSPECTOR MISSION:
You are the pre-planning Inspector Agent.
The main agent has been given this task: "${task}"
Your job is to quickly survey the codebase using read-only tools (search_code, list_dir, search_semantic, read_file).
DO NOT write code or edit files.
Once you have found the files that need to be modified and understand the architecture, summarize your findings in a concise situation report.
The report must include:
1. Exact file paths that need editing.
2. Key functions/classes involved.
3. Any risks or ambiguities.
End your turn with the final situation report.
`;

  const permissions = new PermissionSystem('auto');

  const result = await runAgentLoop({
    provider: inspectorProvider,
    task: inspectorTask,
    context,
    permissions,
    display,
    maxTurns: 5, // Bound the inspector to prevent infinite loops
    disableSpawn: true, // Inspector shouldn't spawn more subagents
    skipInspector: true, // Prevent infinite recursion
    checkpoints: false,
  });


  display.success('Inspector Agent finished. Handing off context to main agent.');
  // Extract the final summary from the inspector's result
  return `=== INSPECTOR REPORT ===\n${result.summary}\n========================`;
}
