// ─────────────────────────────────────────────────────────────────────────────
// LearnLight Lesson Preparation — Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  createLessonPrepWorkflow,
  sampleBusinessEnglishInput,
  sampleGeneralEnglishInput,
} from '../../src/learnlight/index.js';

describe('LearnLight Lesson Preparation', () => {
  // ── Workflow creation ───────────────────────────────────────────────────

  it('creates a business English lesson workflow with 5 steps', async () => {
    const input = sampleBusinessEnglishInput();
    const state = await createLessonPrepWorkflow(input);

    expect(state).toBeDefined();
    expect(state.definition.name).toContain('LearnLight');
    expect(state.definition.name).toContain('Presentation');
    expect(state.definition.steps).toHaveLength(5);
    expect(state.status).toBe('pending');
    expect(state.currentStep).toBe(-1);
  });

  it('creates a general English lesson workflow with correct metadata', async () => {
    const input = sampleGeneralEnglishInput();
    const state = await createLessonPrepWorkflow(input);

    expect(state.definition.name).toContain('Travel Experiences');
    expect(state.definition.description).toContain('Yuki');
    expect(state.definition.description).toContain('A2');
    expect(state.definition.steps).toHaveLength(5);
    expect(state.definition.createdAt).toBeGreaterThan(0);
  });

  it('assigns a unique id to each workflow', async () => {
    const a = await createLessonPrepWorkflow(sampleBusinessEnglishInput());
    const b = await createLessonPrepWorkflow(sampleGeneralEnglishInput());

    expect(a.definition.id).not.toBe(b.definition.id);
  });

  // ── Step structure ──────────────────────────────────────────────────────

  it('each step has name and task defined', async () => {
    const state = await createLessonPrepWorkflow(sampleBusinessEnglishInput());

    for (const step of state.definition.steps) {
      expect(step.name).toBeDefined();
      expect(step.name.length).toBeGreaterThan(0);
      expect(step.task).toBeDefined();
      expect(step.task.length).toBeGreaterThan(0);
    }
  });

  it('steps are ordered: Analyse → Objectives → Activities → Materials → Teacher Notes', async () => {
    const state = await createLessonPrepWorkflow(sampleBusinessEnglishInput());
    const names = state.definition.steps.map(s => s.name);

    expect(names[0]).toMatch(/analyse/i);
    expect(names[1]).toMatch(/(objective|goal)/i);
    expect(names[2]).toMatch(/activit/i);
    expect(names[3]).toMatch(/(vocab|material)/i);
    expect(names[4]).toMatch(/(teacher|delivery|note)/i);
  });

  // ── Input samples ───────────────────────────────────────────────────────

  it('sampleBusinessEnglishInput has correct student profile', () => {
    const input = sampleBusinessEnglishInput();

    expect(input.student.name).toBe('Maria');
    expect(input.student.level).toBe('B2');
    expect(input.student.nativeLanguage).toBe('Spanish');
    expect(input.student.goals).toHaveLength(3);
    expect(input.student.weaknesses).toHaveLength(3);
    expect(input.student.interests).toContain('Tennis');
    expect(input.focusAreas).toContain('speaking');
    expect(input.focusAreas).toContain('business');
    expect(input.notes).toContain('signposting');
  });

  it('sampleGeneralEnglishInput has correct student profile', () => {
    const input = sampleGeneralEnglishInput();

    expect(input.student.name).toBe('Yuki');
    expect(input.student.level).toBe('A2');
    expect(input.student.nativeLanguage).toBe('Japanese');
    expect(input.student.goals).toContain('Communicate confidently while travelling');
    expect(input.focusAreas).toContain('grammar');
    expect(input.focusAreas).toContain('vocabulary');
  });

  // ── Step tasks contain key references ───────────────────────────────────

  it('step tasks reference the topic and student level', async () => {
    const input = sampleBusinessEnglishInput();
    const state = await createLessonPrepWorkflow(input);

    for (const step of state.definition.steps) {
      // Each step task should mention the topic or level
      const taskLower = step.task.toLowerCase();
      expect(
        taskLower.includes('presentation') ||
        taskLower.includes('b2') ||
        taskLower.includes('maria') ||
        taskLower.includes('signposting'),
      ).toBe(true);
    }
  });

  // ── Duration parameter ──────────────────────────────────────────────────

  it('respects custom durationMinutes parameter', async () => {
    const input = sampleBusinessEnglishInput();
    input.durationMinutes = 30;

    const state = await createLessonPrepWorkflow(input);
    const tasks = state.definition.steps.map(s => s.task);

    // Duration is referenced in step tasks where timing is relevant
    // (steps 0, 1, 2, 4 mention duration; step 3 — vocabulary — does not)
    expect(tasks[0]).toContain('30');
    expect(tasks[1]).toContain('30');
    expect(tasks[2]).toContain('30');
    expect(tasks[4]).toContain('30');
  });

  // ── Student weaknesses are included in step tasks ───────────────────────

  it('includes student weaknesses in step tasks', async () => {
    const state = await createLessonPrepWorkflow(sampleBusinessEnglishInput());
    const firstTask = state.definition.steps[0].task;

    // Weaknesses appear in the student profile summary
    expect(firstTask.toLowerCase()).toContain('long pauses');
    expect(firstTask.toLowerCase()).toContain('filler words');
    expect(firstTask).toContain('signposting');
  });

  // ── Edge: empty focus areas ─────────────────────────────────────────────

  it('handles empty focus areas gracefully', async () => {
    const input = sampleBusinessEnglishInput();
    input.focusAreas = [];

    const state = await createLessonPrepWorkflow(input);
    const firstTask = state.definition.steps[0].task;

    // Should default to "balanced"
    expect(firstTask).toContain('balanced');
  });
});
