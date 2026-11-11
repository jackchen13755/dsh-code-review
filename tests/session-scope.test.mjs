import test from 'node:test';
import assert from 'node:assert/strict';

import { extractRecentUserRequests, sessionScopeBlock } from '../lib/session-scope.js';

const userMessage = (text, kind) => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], ...(kind ? { source: { kind } } : {}) },
});

/**
 * R3 的核心：一个分支上并行多个会话时，评审必须知道「这次属于哪个会话、在做什么」，
 * 否则会对着 A 的意图评 B 的改动。这些用例钉住摘要的边界。
 */
test('摘要只带本会话的用户要求', () => {
  const a = [userMessage('把 A 功能的开关关掉'), userMessage('顺便补测试')];
  const b = [userMessage('修 B 的越权 bug')];
  assert.deepEqual(extractRecentUserRequests(a), ['把 A 功能的开关关掉', '顺便补测试']);
  assert.deepEqual(extractRecentUserRequests(b), ['修 B 的越权 bug']);
});

test('两个会话的摘要块互不包含对方的文本（不串评审）', () => {
  const blockA = sessionScopeBlock({ sessionId: 'sess-A', cwd: '/repo', recentUserRequests: extractRecentUserRequests([userMessage('关掉 A 功能')]) });
  const blockB = sessionScopeBlock({ sessionId: 'sess-B', cwd: '/repo', recentUserRequests: extractRecentUserRequests([userMessage('修 B 的 bug')]) });
  assert.ok(blockA.includes('sess-A'));
  assert.ok(!blockA.includes('修 B 的 bug'), 'A 的提示词不得带 B 的要求');
  assert.ok(blockB.includes('sess-B'));
  assert.ok(!blockB.includes('关掉 A 功能'), 'B 的提示词不得带 A 的要求');
  // 同一个仓库目录下也要能区分开——这正是「同分支多会话」的形态
  assert.ok(blockA.includes('/repo') && blockB.includes('/repo'));
});

test('摘要必须有界：单条超长要求被截断，不把提示词撑爆', () => {
  const long = 'x'.repeat(1000);
  const [got] = extractRecentUserRequests([userMessage(long)]);
  assert.ok(got.length < 400, `应当截断，实际长度 ${got.length}`);
  assert.ok(got.endsWith('…'));
});

test('只取最近 N 条（默认 3），避免把整段历史塞进子 Agent', () => {
  const events = ['一', '二', '三', '四', '五'].map(t => userMessage(t));
  assert.deepEqual(extractRecentUserRequests(events), ['三', '四', '五']);
});

test('排除插件自己回投的评审报告：否则本次要求会被上一份报告污染', () => {
  const events = [
    userMessage('真正的要求'),
    userMessage('上一轮的评审报告正文', 'michengai-code-review'),
  ];
  assert.deepEqual(extractRecentUserRequests(events), ['真正的要求']);
});

test('边界输入：空 / undefined / 非数组 / 混入脏事件都不抛', () => {
  for (const input of [undefined, null, [], 'oops', 42, [null, {}, { type: 'user/message' }]]) {
    assert.deepEqual(extractRecentUserRequests(input), []);
  }
});

test('没有用户要求时也要有明确文案，不能留空段', () => {
  const block = sessionScopeBlock({ sessionId: 's', cwd: '/repo', recentUserRequests: [] });
  assert.match(block, /## Session scope/);
  assert.match(block, /no recorded|none recorded/i);
});

test('多仓库时列出全部仓库，并声明只按本会话意图评', () => {
  const block = sessionScopeBlock({ sessionId: 's', cwd: '/work', recentUserRequests: [], repos: ['/work/repoA', '/work/repoB'] });
  assert.ok(block.includes('/work/repoA') && block.includes('/work/repoB'));
  assert.match(block, /THIS session's\s+intent|this session/i);
});
