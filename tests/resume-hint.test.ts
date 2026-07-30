import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resumeHintFor } from '../src/agent/loop.js';
import { sessionStore } from '../src/agent/session-store.js';

/**
 * The regression this guards: a stalled loop told the user to "Type /continue to
 * resume session latest". Neither half worked.
 *
 * There is no /continue. The REPL matches colon-prefixed input (`:resume`,
 * `:new`, `:save`) and has no slash-command dispatcher at all, so the typed text
 * fell through to the model as an ordinary user message — a real session on disk
 * has "/continue" recorded as a user turn, answered with an essay about an
 * unrelated project, because that is what the model does with a one-word prompt
 * and no context.
 *
 * And "latest" was never a session id. sessionPath was a fixed `latest.json` per
 * project directory, so basename() produced the filename; `:resume latest` would
 * have loaded whichever run last overwrote that shared file.
 */

describe('resumeHintFor', () => {
  it('names :resume, never /continue', () => {
    const hint = resumeHintFor('/s/abcd1234-ms6zwhvb.json');
    expect(hint).toContain(':resume');
    expect(hint).not.toContain('/continue');
  });

  it('quotes a real session id so the command resolves', () => {
    expect(resumeHintFor('/s/abcd1234-ms6zwhvb.json'))
      .toBe(' Type :resume abcd1234-ms6zwhvb to continue this session.');
  });

  it('accepts the gazelle- id prefix', () => {
    expect(resumeHintFor('/s/gazelle-78c556ea-ms6ufuua.json'))
      .toContain(':resume gazelle-78c556ea-ms6ufuua');
  });

  it('will not quote latest.json as an id', () => {
    const hint = resumeHintFor('/s/_home_dusan/latest.json');
    expect(hint).not.toContain('latest');
    expect(hint).toBe(' Type :resume to continue the most recent session.');
  });

  it('falls back for any other non-id filename', () => {
    for (const p of ['/s/session.json', '/s/backup-2.json', '/s/latest.factlog.json']) {
      expect(resumeHintFor(p), p).toBe(' Type :resume to continue the most recent session.');
    }
  });

  it('is empty when the loop is not persisting a session', () => {
    expect(resumeHintFor(undefined)).toBe('');
  });

  it('resolves the id through the .run scratch-file suffix', () => {
    // The loop persists to `<id>.run.json`, kept apart from the session record
    // `<id>.json` because sessionStore.save() and upsertSession() write different
    // shapes and loadSession casts without validating. Same id to resume, so the
    // hint must see through the marker.
    expect(resumeHintFor('/s/abcd1234-ms6zwhvb.run.json'))
      .toBe(' Type :resume abcd1234-ms6zwhvb to continue this session.');
  });

  it('accepts what generateId actually produces', () => {
    // Guards the id regex against a change in the generator's format.
    for (let i = 0; i < 20; i++) {
      const id = sessionStore.generateId();
      expect(resumeHintFor(path.join('/s', `${id}.json`)), id)
        .toBe(` Type :resume ${id} to continue this session.`);
    }
  });
});
