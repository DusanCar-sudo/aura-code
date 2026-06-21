import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getBoardTasks, getRowLabels, runPipeline,
} from '../../src/kanban/pipeline.js';
import type { KanbanTask, PipelineRow, PipelinePhase, ProgressEvent } from '../../src/kanban/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// getBoardTasks
// ─────────────────────────────────────────────────────────────────────────────

describe('Kanban Pipeline', () => {
  describe('getBoardTasks', () => {
    it('returns an array of tasks', () => {
      const tasks = getBoardTasks();
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
    });

    it('each task has required fields', () => {
      for (const t of getBoardTasks()) {
        expect(typeof t.id).toBe('string');
        expect(t.id.length).toBeGreaterThan(0);
        expect(typeof t.title).toBe('string');
        expect(typeof t.description).toBe('string');
        expect(typeof t.badge).toBe('string');
        expect(typeof t.tag).toBe('string');
        expect(typeof t.highPriority).toBe('boolean');
      }
    });

    it('has tasks across all 5 phases', () => {
      const phases = new Set(getBoardTasks().map(t => t.phase));
      expect(phases.has('read')).toBe(true);
      expect(phases.has('plan')).toBe(true);
      expect(phases.has('execute')).toBe(true);
      expect(phases.has('verify')).toBe(true);
      expect(phases.has('report')).toBe(true);
    });

    it('has tasks across all 4 rows', () => {
      const rows = new Set(getBoardTasks().map(t => t.row));
      expect(rows.has('orchestrate')).toBe(true);
      expect(rows.has('architect')).toBe(true);
      expect(rows.has('verify')).toBe(true);
      expect(rows.has('ruby-alternator')).toBe(true);
    });

    it('has at least 10 tasks total', () => {
      expect(getBoardTasks().length).toBeGreaterThanOrEqual(10);
    });

    it('task IDs are unique', () => {
      const ids = getBoardTasks().map(t => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('includes the Token Optimization task', () => {
      const task = getBoardTasks().find(t => t.title === 'Token Optimization');
      expect(task).toBeDefined();
      expect(task!.phase).toBe('read');
      expect(task!.row).toBe('orchestrate');
    });

    it('includes File Patch Operations as high priority', () => {
      const task = getBoardTasks().find(t => t.title === 'File Patch Operations');
      expect(task).toBeDefined();
      expect(task!.highPriority).toBe(true);
      expect(task!.phase).toBe('execute');
    });

    it('includes Runtime Patching as high priority', () => {
      const task = getBoardTasks().find(t => t.title === 'Runtime Patching');
      expect(task).toBeDefined();
      expect(task!.highPriority).toBe(true);
    });

    it('includes PR Generation in report phase', () => {
      const task = getBoardTasks().find(t => t.title === 'PR Generation');
      expect(task).toBeDefined();
      expect(task!.phase).toBe('report');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getRowLabels
  // ─────────────────────────────────────────────────────────────────────────

  describe('getRowLabels', () => {
    it('returns 4 row labels', () => {
      const labels = getRowLabels();
      expect(Object.keys(labels).length).toBe(4);
    });

    it('has expected row keys', () => {
      const labels = getRowLabels();
      expect(labels.orchestrate).toBe('Orchestrate');
      expect(labels.architect).toBe('Architect');
      expect(labels.verify).toBe('Verify');
      expect(labels['ruby-alternator']).toBe('RubyAlternator');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // runPipeline
  // ─────────────────────────────────────────────────────────────────────────

  describe('runPipeline', () => {
    it('returns a report with all rows', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      expect(report).toBeDefined();
      expect(report.rows).toBeDefined();
      expect(report.rows.length).toBe(4);
      expect(report.generatedAt).toBeDefined();
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('report has stats with totalTasks matching board tasks', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      expect(report.stats.totalTasks).toBe(getBoardTasks().length);
    });

    it('all tasks complete successfully (done or failed)', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      const allTerminal = report.stats.completed + report.stats.failed + report.stats.skipped;
      expect(allTerminal).toBe(report.stats.totalTasks);
    });

    it('each execution has phases matching the pipeline', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      for (const row of report.rows) {
        for (const exec of row.executions) {
          expect(exec.phases.length).toBeGreaterThan(0);
          expect(exec.task).toBeDefined();
          expect(exec.startedAt).toBeGreaterThan(0);
          expect(exec.completedAt).toBeGreaterThan(0);
        }
      }
    });

    it('each phase result has required fields', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      for (const row of report.rows) {
        for (const exec of row.executions) {
          for (const phase of exec.phases) {
            expect(typeof phase.phase).toBe('string');
            expect(['done', 'failed', 'skipped']).toContain(phase.status);
            expect(typeof phase.output).toBe('string');
            expect(phase.durationMs).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it('calls onProgress for each phase', async () => {
      const events: ProgressEvent[] = [];
      await runPipeline({
        projectRoot: process.cwd(),
        onProgress: (ev) => events.push(ev),
      });
      // Should have at least one phase_start and one phase_done for each task phase
      const starts = events.filter(e => e.type === 'phase_start');
      const dones = events.filter(e => e.type === 'phase_done');
      expect(starts.length).toBeGreaterThan(0);
      expect(dones.length).toBe(starts.length);
    });

    it('sends row_done events', async () => {
      const events: ProgressEvent[] = [];
      await runPipeline({
        projectRoot: process.cwd(),
        onProgress: (ev) => events.push(ev),
      });
      const rowDones = events.filter(e => e.type === 'row_done');
      expect(rowDones.length).toBe(4);
    });

    it('sends pipeline_done event', async () => {
      const events: ProgressEvent[] = [];
      await runPipeline({
        projectRoot: process.cwd(),
        onProgress: (ev) => events.push(ev),
      });
      const pipelineDone = events.filter(e => e.type === 'pipeline_done');
      expect(pipelineDone.length).toBe(1);
    });

    it('report has consistent stats', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      const counted = report.rows.reduce(
        (sum, r) => sum + r.executions.length, 0,
      );
      expect(counted).toBe(report.stats.totalTasks);
    });

    it('orchestrate row has correct tasks', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      const row = report.rows.find(r => r.row === 'orchestrate');
      expect(row).toBeDefined();
      expect(row!.label).toBe('Orchestrate');
      const titles = row!.executions.map(e => e.task.title);
      expect(titles).toContain('Token Optimization');
      expect(titles).toContain('File Patch Operations');
      expect(titles).toContain('1000+ Test Run');
      expect(titles).toContain('PR Generation');
    });

    it('architect row has correct tasks', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      const row = report.rows.find(r => r.row === 'architect');
      expect(row).toBeDefined();
      const titles = row!.executions.map(e => e.task.title);
      expect(titles).toContain('Praktess Framework');
      expect(titles).toContain('Cross-Provider Prompts');
      expect(titles).toContain('Zero-Error Build');
    });

    it('verify row has correct tasks', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      const row = report.rows.find(r => r.row === 'verify');
      expect(row).toBeDefined();
      const titles = row!.executions.map(e => e.task.title);
      expect(titles).toContain('Failure Analysis');
      expect(titles).toContain('Runtime Patching');
    });

    it('ruby-alternator row has correct tasks', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      const row = report.rows.find(r => r.row === 'ruby-alternator');
      expect(row).toBeDefined();
      const titles = row!.executions.map(e => e.task.title);
      expect(titles).toContain('Competence Scoring');
      expect(titles).toContain('Episode Recording');
      expect(titles).toContain('Learning Metrics');
    });

    it('tasks only execute from their starting phase onward', async () => {
      const report = await runPipeline({ projectRoot: process.cwd() });
      for (const row of report.rows) {
        for (const exec of row.executions) {
          const startPhase = exec.task.phase;
          const phases = ['read', 'plan', 'execute', 'verify', 'report'];
          const startIdx = phases.indexOf(startPhase);
          const executedPhases = exec.phases.map(p => p.phase);
          // First executed phase should match the task's starting phase
          expect(executedPhases[0]).toBe(startPhase);
          // All executed phases should be at or after the start
          for (const ep of executedPhases) {
            expect(phases.indexOf(ep)).toBeGreaterThanOrEqual(startIdx);
          }
        }
      }
    });
  });
});
