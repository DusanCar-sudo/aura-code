/**
 * What choosing an agent on a tile actually does.
 *
 * The temptation is to make the agent a label — prepend "You are a reviewer"
 * to the prompt and call it routing. That would be theatre: the model would
 * still hold every tool, and a "reviewer" could rewrite the repo.
 *
 * So an agent here is a *capability preset*, expressed in the two controls the
 * protocol already enforces per session:
 *
 *   permission     what the PermissionSystem will let through
 *   allowedTools   which tool schemas the model is even offered
 *
 * Those are real. A reviewer configured read-only cannot write a file however
 * it is prompted, because the refusal happens in the engine and not in the
 * model's good intentions.
 *
 * One honest limit, stated because the names invite the assumption: these are
 * not `runSpecialist` from src/orchestration/specialists.ts. That path has its
 * own system prompts and its own result shape, and the protocol has no way to
 * ask for it yet. These presets shape *what a task can touch*, not which
 * prompt it runs under.
 */

import type { BoardAgent } from './types.js';

export interface AgentPreset {
  id: BoardAgent;
  /** Shown in the picker. */
  label: string;
  /** One line on what it is for, and what it cannot do. */
  description: string;
  permission: 'read-only' | 'normal' | 'auto';
  /** Omitted means every tool — only `aura` gets that. */
  allowedTools?: string[];
}

/** Tools that only look. Shared by every read-only preset below. */
const OBSERVE = ['read_file', 'list_dir', 'search_code', 'git'];

export const AGENT_PRESETS: Record<BoardAgent, AgentPreset> = {
  aura: {
    id: 'aura',
    label: 'Aura',
    description: 'The full agent — every tool, no prompt for routine work.',
    permission: 'auto',
  },
  researcher: {
    id: 'researcher',
    label: 'Researcher',
    description: 'Reads and searches, including the web. Cannot change anything.',
    permission: 'read-only',
    allowedTools: [...OBSERVE, 'web_fetch', 'web_search', 'memory', 'image_read'],
  },
  coder: {
    id: 'coder',
    label: 'Coder',
    description: 'Edits files, runs commands and tests.',
    permission: 'auto',
    allowedTools: [...OBSERVE, 'edit_file', 'write_file', 'run_shell', 'run_tests'],
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Reads the code and runs the tests. Cannot edit — a review that rewrites is not a review.',
    permission: 'read-only',
    allowedTools: [...OBSERVE, 'run_tests'],
  },
  planner: {
    id: 'planner',
    label: 'Planner',
    description: 'Reads and researches to produce a plan. Cannot change anything.',
    permission: 'read-only',
    allowedTools: [...OBSERVE, 'web_search', 'memory'],
  },
};

/** The presets as a list, for a client that renders the picker. */
export function agentPresets(): AgentPreset[] {
  return Object.values(AGENT_PRESETS);
}

/**
 * The permission a task actually runs under.
 *
 * The two settings are not the same kind of thing, and treating them as one
 * scale gets this wrong:
 *
 *   read-only    a *capability* limit. The tools that change anything are not
 *                offered and would be refused anyway. A reviewer must stay
 *                read-only however the session is configured — that is the
 *                whole promise of the preset, and one that can be talked out
 *                of is not read-only, it is read-only-by-default.
 *
 *   normal/auto  only about *asking*. Both allow exactly the same actions;
 *                auto stops the confirmation prompt. Raising normal to auto
 *                grants no new capability, so there is nothing to protect the
 *                operator from — they are the one being prompted.
 *
 * So a read-only preset is a ceiling, and above it the operator decides,
 * including deciding to be stricter. An earlier version capped auto down to
 * the preset's `normal`, which meant someone who had chosen auto in Settings
 * was still asked to approve every shell command and nothing explained why.
 */
export function effectivePermission(
  preset: AgentPreset,
  chosen: AgentPreset['permission'] | undefined,
): AgentPreset['permission'] {
  if (preset.permission === 'read-only') return 'read-only';
  return chosen ?? preset.permission;
}
