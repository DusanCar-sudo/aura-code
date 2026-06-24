// ─────────────────────────────────────────────────────────────────────────────
// LearnLight Lesson Preparation Workflow
// Creates a structured lesson plan using the Aura workflow engine.
// ─────────────────────────────────────────────────────────────────────────────

import { createWorkflow, runWorkflow, resumeWorkflow } from '../workflows/engine.js';
import type { WorkflowStep, StepResult, WorkflowState } from '../workflows/types.js';
import type { LessonPrepInput, LessonPlan } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Workflow step definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the ordered workflow steps for a LearnLight lesson preparation.
 * Each step is a prompt sent to the agent loop.
 */
function buildLessonPrepSteps(input: LessonPrepInput): WorkflowStep[] {
  const { topic, student, durationMinutes = 50, focusAreas, notes } = input;
  const focusStr = focusAreas?.length ? focusAreas.join(', ') : 'balanced';
  const studentDesc =
    `${student.name} – Level ${student.level} (${student.ageGroup})` +
    `, native: ${student.nativeLanguage}` +
    `, goals: ${student.goals.join('; ')}` +
    `, interests: ${student.interests.join('; ')}` +
    (student.previousNotes ? `, notes: ${student.previousNotes}` : '');

  return [
    // ── Step 1: Analyse ──────────────────────────────────────────────────
    {
      name: 'Analyse Student Profile',
      task: `You are a senior language tutor preparing a LearnLight lesson.

Student profile: ${studentDesc}
Topic: "${topic}"
Target duration: ${durationMinutes} minutes
Focus areas: ${focusStr}
${notes ? `Additional notes: ${notes}` : ''}
${student.weaknesses.length ? `Known weaknesses: ${student.weaknesses.join('; ')}` : ''}

Analyse this student profile and topic. Produce a structured analysis covering:
1. **Relevance** — why this topic suits the student's level and goals
2. **Prerequisites** — what the student should already know
3. **Challenges** — anticipated difficulties (grammar, vocabulary, pronunciation)
4. **Opportunities** — how to leverage the student's interests for engagement

Output plain text analysis — no JSON. Use markdown headings.`,
    },

    // ── Step 2: Define Objectives ─────────────────────────────────────────
    {
      name: 'Define Learning Objectives',
      task: `Based on the analysis from the previous step, write 3–5 SMART learning objectives for a ${durationMinutes}-minute LearnLight lesson on "${topic}" at ${student.level} level.

Each objective must be:
- **Specific** — exactly what the student will be able to do
- **Measurable** — how success will be observed
- **Achievable** — realistic for the student's level and time
- **Relevant** — tied to the student's goals and interests
- **Time-bound** — achievable within ${durationMinutes} minutes

Format as a numbered list with a 1-sentence justification for each.`,
    },

    // ── Step 3: Design Activities ─────────────────────────────────────────
    {
      name: 'Design Lesson Activities',
      task: `Design a ${durationMinutes}-minute LearnLight lesson on "${topic}" for a ${student.level} student.

Create a timed activity sequence. Include:
1. **Warm-up** (5–7 min) — engaging lead-in that activates prior knowledge
2. **Presentation** (10–15 min) — introduce new language/input
3. **Practice** (15–20 min) — controlled and freer practice activities
4. **Production** (10–15 min) — communicative task using the target language
5. **Wrap-up & Feedback** (3–5 min) — review, Q&A, homework assignment

For each activity specify:
- Name and duration
- Detailed instructions (as if telling the teacher what to do)
- Interaction type (teacher-led, pair-work, group-work, individual, whole-class)
- Materials needed (whiteboard, handout, online tool, etc.)
- Differentiation: how to adapt if the student finds it too easy or too hard

Output in markdown. Total must sum to ${durationMinutes} minutes.`,
    },

    // ── Step 4: Vocabulary & Materials ────────────────────────────────────
    {
      name: 'Prepare Vocabulary & Materials',
      task: `Generate a vocabulary list and materials checklist for a ${student.level} LearnLight lesson on "${topic}".

**Vocabulary** — list 8–12 key words/phrases. For each include:
- Word/phrase
- Part of speech
- Simple definition suitable for ${student.level} level
- Example sentence relevant to the topic
- Collocations or common phrases (where applicable)

**Materials checklist** — list everything the teacher needs to prepare:
- Handouts, slides, or digital resources
- Audio/video links (suggest real URLs or searchable titles)
- Props, images, or realia
- Online tools or apps

**Homework suggestion** — 1–2 tasks that reinforce the lesson.

Format as structured markdown lists.`,
    },

    // ── Step 5: Teacher Notes ─────────────────────────────────────────────
    {
      name: 'Write Teacher Notes & Delivery Tips',
      task: `Write concise teacher notes for delivering a ${student.level} LearnLight lesson on "${topic}" (planned for ${durationMinutes} minutes).

Cover:
1. **Pacing guide** — rough timing for a ${durationMinutes}-minute lesson, when to speed up or slow down
2. **ICQs (Instruction-Check Questions)** — 2–3 questions to verify the student understands task instructions
3. **CCQs (Concept-Check Questions)** — 2–3 questions to verify the student understands the target language
4. **Error correction strategy** — when and how to correct (immediate vs. delayed, reformulation vs. elicitation)
5. **Extension ideas** — what to do if you finish early or the student is especially engaged
6. **Contingency plan** — what to skip if time is running short

Keep it practical and actionable. Markdown format.`,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a LearnLight lesson preparation workflow.
 * The workflow is persisted to disk and ready to be run.
 *
 * @param input - The lesson preparation input parameters.
 * @returns The created workflow state.
 */
export async function createLessonPrepWorkflow(
  input: LessonPrepInput,
): Promise<WorkflowState> {
  const steps = buildLessonPrepSteps(input);
  const description =
    `LearnLight lesson: "${input.topic}" for ${input.student.name} (${input.student.level})`;

  return createWorkflow({
    name: `LearnLight: ${input.topic}`,
    description,
    steps,
  });
}

/**
 * Run a lesson preparation workflow from start to finish.
 * Uses the provided runStep callback to execute each step.
 *
 * @param state  - The workflow state (from createLessonPrepWorkflow).
 * @param runStep - Callback that runs a single step's task and returns the result.
 * @returns The final workflow state.
 */
export async function runLessonPrepWorkflow(
  state: WorkflowState,
  runStep: (task: string, stepIndex: number, previousResults: StepResult[]) => Promise<StepResult>,
): Promise<WorkflowState> {
  return runWorkflow(state, runStep);
}

/**
 * Resume a previously-paused or failed lesson preparation workflow.
 *
 * @param id      - The workflow ID to resume.
 * @param runStep - Callback that runs a single step's task.
 * @returns The final workflow state, or null if the workflow was not found.
 */
export async function resumeLessonPrepWorkflow(
  id: string,
  runStep: (task: string, stepIndex: number, previousResults: StepResult[]) => Promise<StepResult>,
): Promise<WorkflowState | null> {
  return resumeWorkflow(id, runStep);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: build a sample LessonPrepInput for quick testing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a sample lesson prep input for a Business English student.
 * Useful for testing or demonstrations.
 */
export function sampleBusinessEnglishInput(): LessonPrepInput {
  return {
    topic: 'Giving a Presentation — Structuring Your Talk',
    student: {
      name: 'Maria',
      level: 'B2',
      ageGroup: 'adult',
      nativeLanguage: 'Spanish',
      goals: [
        'Feel confident in client meetings',
        'Reduce filler words and hesitations',
        'Use more professional vocabulary',
      ],
      weaknesses: [
        'Long pauses mid-sentence',
        'Overuse of "um" and "like"',
        'Rarely uses signposting language',
      ],
      interests: ['Technology', 'Startups', 'Tennis'],
      previousNotes: 'Maria is motivated but nervous about formal presentations. She responds well to clear structure and positive reinforcement.',
    },
    durationMinutes: 50,
    focusAreas: ['speaking', 'business', 'vocabulary'],
    notes: 'Focus on signposting language (first, next, finally, etc.). Include a mock presentation segment.',
  };
}

/**
 * Creates a sample lesson prep input for a General English learner.
 */
export function sampleGeneralEnglishInput(): LessonPrepInput {
  return {
    topic: 'Talking About Travel Experiences — Present Perfect vs. Past Simple',
    student: {
      name: 'Yuki',
      level: 'A2',
      ageGroup: 'adult',
      nativeLanguage: 'Japanese',
      goals: [
        'Communicate confidently while travelling',
        'Understand and use basic verb tenses',
        'Build vocabulary for everyday situations',
      ],
      weaknesses: [
        'Confuses present perfect and past simple',
        'Limited travel-related vocabulary',
        'Hesitates when forming questions',
      ],
      interests: ['Travel', 'Photography', 'Cooking'],
    },
    durationMinutes: 50,
    focusAreas: ['grammar', 'speaking', 'vocabulary'],
    notes: 'Use visuals (photos) to stimulate conversation. Keep grammar explanations minimal — use examples and drilling.',
  };
}
