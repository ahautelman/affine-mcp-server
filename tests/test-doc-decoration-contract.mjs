#!/usr/bin/env node
import "./require-destructive-test-safety.mjs";

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { z } from 'zod';
import { registerDocTools } from '../dist/tools/docs.js';
import { registerIconTools } from '../dist/tools/icons.js';
import { applyExplorerIcons, docIconEntries } from '../dist/util/explorerIcon.js';

test('docIconEntries normalizes every icon form and rejects duplicate docs', () => {
  const entries = docIconEntries([
    { docId: 'a', icon: '🧭' },
    { docId: 'b', icon: { type: 'icon', name: 'Flag', color: '#fff' } },
    { docId: 'c', icon: null },
  ]);
  assert.deepEqual(entries, [
    { key: 'doc:a', icon: { type: 'emoji', unicode: '🧭' } },
    { key: 'doc:b', icon: { type: 'affine-icon', name: 'Flag', color: '#fff' } },
    { key: 'doc:c', icon: null },
  ]);
  assert.throws(() => docIconEntries([{ docId: 'a', icon: '🧭' }, { docId: 'a', icon: '🚀' }]), /duplicate/i);
  assert.throws(() => docIconEntries([{ docId: 'a', icon: ' ' }]), /empty/);
});

test('applyExplorerIcons sets many icons and keeps ids when clearing', () => {
  const doc = new Y.Doc();
  applyExplorerIcons(doc, [
    { key: 'doc:a', icon: { type: 'emoji', unicode: '🧭' } },
    { key: 'folder:f', icon: { type: 'emoji', unicode: '📦' } },
  ]);
  assert.deepEqual(doc.getMap('doc:a').toJSON(), { id: 'doc:a', icon: { type: 'emoji', unicode: '🧭' } });
  assert.equal(doc.getMap('folder:f').get('icon').unicode, '📦');
  applyExplorerIcons(doc, [{ key: 'doc:a', icon: null }]);
  assert.deepEqual(doc.getMap('doc:a').toJSON(), { id: 'doc:a' });
  assert.equal(doc.getMap('folder:f').get('icon').unicode, '📦');
});

const tools = new Map();
const registry = { registerTool: (name, definition) => tools.set(name, definition) };
registerDocTools(registry, {}, {});
registerIconTools(registry, {}, {});
const accepts = (name, value) => z.object(tools.get(name)?.inputSchema ?? { missing: z.never() }).safeParse(value).success;

test('batch tag and icon tools accept real batches and reject empty or malformed ones', () => {
  assert.equal(accepts('add_tags_to_docs', { docIds: ['a', 'b'], tags: ['type/guide', 'topic/project'] }), true);
  for (const value of [{ docIds: [], tags: ['x'] }, { docIds: ['a'], tags: [] }, { docIds: ['a'], tags: [' '] }, { docIds: ['a'] }]) {
    assert.equal(accepts('add_tags_to_docs', value), false, JSON.stringify(value));
  }
  assert.equal(accepts('update_doc_icons', { icons: [{ docId: 'a', icon: '🧭' }, { docId: 'b', icon: null }] }), true);
  for (const value of [{ icons: [] }, { icons: [{ docId: '', icon: '🧭' }] }, { icons: [{ docId: 'a' }] }]) {
    assert.equal(accepts('update_doc_icons', value), false, JSON.stringify(value));
  }
});

test('doc creation tools accept optional icon and tags, and stay valid without them', () => {
  for (const name of ['create_doc', 'create_doc_from_markdown']) {
    const base = name === 'create_doc' ? { title: 't' } : { markdown: '# t' };
    assert.equal(accepts(name, base), true);
    assert.equal(accepts(name, { ...base, icon: '🧭', tags: ['type/guide'] }), true);
    assert.equal(accepts(name, { ...base, tags: [' '] }), false);
    assert.equal(accepts(name, { ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), false);
  }
});
