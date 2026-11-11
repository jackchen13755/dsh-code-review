import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewPrompt, parseTarget } from '../lib/request.js';

export function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); }
export async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'test@example.invalid'); git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'core.autocrlf', 'false');
  await writeFile(join(root, 'a.ts'), 'export const value = 1;\n', 'utf8');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'initial');
  return root;
}

// 2026-11-11 契约变更：短任务文本保持 codex 原文，但**必须**在末尾追加目录定位行。
// 原因：本插件走 in-process spawn provider，`SubagentStartRequest.cwd` 虽在类型里，
// 但 dsh-subagent-spawn-in-process 整个包没有实现它，子 Agent 永远继承父会话目录；
// 父会话目录常常不是被审仓库（多仓库工作区根甚至不是 git 仓库）→ git diff 跑错树。
// 所以这里钉住两件事：原文逐字保留 + 目标目录出现在提示词里。
test('未提交任务保留 Codex 原文，并显式给出被审仓库目录', async () => {
  const prompt = await reviewPrompt({ mode: 'worktree' }, '/tmp/some-repo');
  assert.ok(prompt.startsWith('Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.'), 'Codex 原文必须逐字保留为前缀');
  assert.match(prompt, /repository under review is at: \/tmp\/some-repo/, '必须告诉审查 Agent 仓库在哪');
  assert.match(prompt, /git -C \/tmp\/some-repo/, '要给出可直接执行的 git -C 形式，别让它猜');
});

test('自定义要求原文传递，不猜路径、CLI 选项或工作区范围', async () => {
  for (const text of ['--base main', '.', 'help', '审查上一提交\n检查 "权限"']) {
    const target = parseTarget(text);
    assert.deepEqual(target, { mode: 'custom', instructions: text });
    const prompt = await reviewPrompt(target, 'does-not-exist');
    // 要求本身一字不改（不解析 CLI 选项、不猜工作区），只是后面追加了定位行。
    assert.ok(prompt.startsWith(text), '自定义要求必须原文保留');
    assert.match(prompt, /repository under review is at: does-not-exist/);
  }
  assert.throws(() => parseTarget('  '));
  await assert.rejects(reviewPrompt({ mode: 'custom', instructions: '' }, '.'));
});

test('提交任务保留 Codex 两种标题模板原文，并追加目录定位', async () => {
  const plain = await reviewPrompt({ mode: 'commit', ref: 'HEAD' }, '.');
  assert.ok(plain.startsWith('Review the code changes introduced by commit HEAD. Provide prioritized, actionable findings.'));
  const titled = await reviewPrompt({ mode: 'commit', ref: 'abc123', title: 'Fix auth' }, '.');
  assert.ok(titled.startsWith('Review the code changes introduced by commit abc123 ("Fix auth"). Provide prioritized, actionable findings.'));
});

test('分支只计算共同祖先，diff 留给 Agent；不存在分支走上游回退', async t => {
  const root = await repository(t);
  const base = git(root, 'rev-parse', 'HEAD').trim();
  await writeFile(join(root, 'a.ts'), 'SECRET_CONTENT_NOT_IN_PROMPT');
  const prompt = await reviewPrompt({ mode: 'base', ref: 'main' }, root);
  assert.ok(prompt.startsWith(`Review the code changes against the base branch 'main'. The merge base commit for this comparison is ${base}. Run \`git diff ${base}\` to inspect the changes relative to main. Provide prioritized, actionable findings.`));
  assert.ok(prompt.includes(root), 'base 模式同样要带出目录，否则 Agent 仍在错的树里跑 diff');
  assert.doesNotMatch(prompt, /SECRET_CONTENT/);
  assert.match(await reviewPrompt({ mode: 'base', ref: 'missing' }, root), /Start by finding the merge diff/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reviewPrompt({ mode: 'base', ref: 'main' }, root, controller.signal));
});

test('基准 upstream 领先时使用上游共同祖先，与 Codex 一致', async t => {
  const root = await repository(t);
  git(root, 'checkout', '-qb', 'upstream');
  await writeFile(join(root, 'a.ts'), 'upstream\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'upstream');
  const expected = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'branch', '--set-upstream-to=upstream', 'main');
  git(root, 'checkout', '-qb', 'feature');
  await writeFile(join(root, 'b.ts'), 'feature\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'feature');
  assert.ok((await reviewPrompt({ mode: 'base', ref: 'main' }, root)).includes(`merge base commit for this comparison is ${expected}.`));
});
