import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateDashboard } from '../../src/viz/index.js';

describe('viz dashboard corruption fix', () => {
  let tmpRoot: string;
  let fakeHome: string;
  let safe: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-test-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-home-'));
    safe = tmpRoot.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function writeSession(session: Record<string, unknown>) {
    const dir = path.join(fakeHome, '.rubycode', 'sessions', safe);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session.id}.json`), JSON.stringify(session));
  }

  function writePlan(plan: Record<string, unknown>) {
    const dir = path.join(fakeHome, '.rubycode', 'plans', safe);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${plan.id}.json`), JSON.stringify(plan));
  }

  it('generates dashboard HTML that survives backticks and </script> in session history', () => {
    writeSession({
      id: 'test-session-1',
      title: 'Test session',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      version: 1,
      history: [
        { role: 'user', content: 'Write a <script>alert("xss")</script> function' },
        { role: 'assistant', content: 'Here is the code:\n```js\nfunction foo() { return "</script>"; }\n```' },
        { role: 'tool_result', content: 'Output: </script><script>evil()' },
        { role: 'user', content: 'Fix the `bar` function with `baz`' },
        { role: 'assistant', content: 'Done — used `template literal` with `backticks` everywhere' },
      ],
    });

    writePlan({
      id: 'test-plan-1',
      goal: 'Fix the `auth` module',
      status: 'done',
      created: Date.now(),
      completed: Date.now() + 10000,
      steps: [
        {
          id: 'step-1',
          specialist: 'coder',
          task: 'Fix auth.ts',
          context: 'some context',
          dependsOn: [],
          result: 'Here is the fix:\n```ts\nexport function auth() { return "</script>"; }\n```',
          status: 'done',
          durationMs: 5000,
        },
        {
          id: 'step-2',
          specialist: 'reviewer',
          task: 'Review changes',
          context: 'review context',
          dependsOn: ['step-1'],
          result: 'LGTM — ```js\nconsole.log("</script>")\n```',
          status: 'done',
          durationMs: 2000,
        },
      ],
      outcome: 'All fixed. Code: ```ts\nconst x = "</script>";\n```',
    });

    const outPath = generateDashboard(tmpRoot);
    expect(fs.existsSync(outPath)).toBe(true);
    const html = fs.readFileSync(outPath, 'utf8');

    // Exactly 2 <script> open tags: d3 external + inline DATA
    const scriptOpenTags = html.match(/<script[\s>]/g) || [];
    expect(scriptOpenTags.length).toBe(2);

    // Exactly 2 </script> close tags — no extra ones from injected content
    const scriptCloseTags = html.match(/<\/script>/g) || [];
    expect(scriptCloseTags.length).toBe(2);

    // Session history content must NOT appear (history was stripped)
    expect(html).not.toContain('alert("xss")');
    expect(html).not.toContain('function foo()');
    expect(html).not.toContain('template literal');

    // Plan step results must NOT appear (results were stripped)
    expect(html).not.toContain('export function auth()');
    expect(html).not.toContain('console.log');
    // Plan outcome must NOT appear (was stripped)
    expect(html).not.toContain('All fixed.');

    // Metadata SHOULD still be present in the embedded JSON
    expect(html).toContain('"test-session-1"');
    expect(html).toContain('"test-plan-1"');
    expect(html).toContain('"messageCount"');
    expect(html).toContain('"toolCallCount"');
    // Plan goal with backticks should survive (it's safe metadata)
    expect(html).toContain('Fix the `auth` module');
    // History array must not be in the output
    expect(html).not.toContain('"history"');
  });

  it('strips session to metadata with message and tool call counts', () => {
    writeSession({
      id: 'sess-meta',
      title: 'Meta test',
      createdAt: '2024-06-01T00:00:00Z',
      updatedAt: '2024-06-02T00:00:00Z',
      version: 1,
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'tool_result', content: 'result' },
        { role: 'user', content: 'more' },
        { role: 'assistant', content: 'ok' },
      ],
    });

    const outPath = generateDashboard(tmpRoot);
    const html = fs.readFileSync(outPath, 'utf8');

    // The embedded JSON should contain the counts (5 messages, 1 tool_result)
    expect(html).toContain('"messageCount":5');
    expect(html).toContain('"toolCallCount":1');

    // History content should not leak
    expect(html).not.toContain('"history"');
    expect(html).not.toContain('"hello"');
    expect(html).not.toContain('"result"');
  });

  it('handles empty sessions and plans gracefully', () => {
    const outPath = generateDashboard(tmpRoot);
    const html = fs.readFileSync(outPath, 'utf8');

    // Should produce valid-looking HTML
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');

    // Exactly 2 script tags (d3 + inline)
    const scriptOpenTags = html.match(/<script[\s>]/g) || [];
    expect(scriptOpenTags.length).toBe(2);
    const scriptCloseTags = html.match(/<\/script>/g) || [];
    expect(scriptCloseTags.length).toBe(2);
  });

  it('plan steps retain dependsOn for DAG rendering after stripping', () => {
    writePlan({
      id: 'plan-deps',
      goal: 'Test deps',
      status: 'done',
      created: Date.now(),
      completed: Date.now() + 5000,
      steps: [
        { id: 's1', specialist: 'researcher', task: 'Research', context: '', dependsOn: [], status: 'done' },
        { id: 's2', specialist: 'coder', task: 'Code', context: '', dependsOn: ['s1'], result: '```js\nalert("</script>")\n```', status: 'done' },
      ],
    });

    const outPath = generateDashboard(tmpRoot);
    const html = fs.readFileSync(outPath, 'utf8');

    // dependsOn must be in the embedded DATA so the DAG can be rendered
    expect(html).toContain('"dependsOn"');
    // But the dangerous result content must be gone
    expect(html).not.toContain('alert(');
  });

  it('escapes </script> that appears in non-stripped fields like goal or title', () => {
    // Put </script> in a field that is NOT stripped (goal/title)
    writePlan({
      id: 'plan-script-tag',
      goal: 'Fix </script><script>alert(1)</script> vulnerability',
      status: 'done',
      created: Date.now(),
      steps: [],
    });

    writeSession({
      id: 'sess-script-tag',
      title: 'Session about </script> tags',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      version: 1,
      history: [],
    });

    const outPath = generateDashboard(tmpRoot);
    const html = fs.readFileSync(outPath, 'utf8');

    // Exactly 2 </script> close tags (one per script block)
    const scriptCloseTags = html.match(/<\/script>/g) || [];
    expect(scriptCloseTags.length).toBe(2);

    // The escaped version should appear inside the DATA
    expect(html).toContain('<\\/script>');
  });
});
