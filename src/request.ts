import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { translate, type Locale } from './i18n.js';

const exec = promisify(execFile);
export type Target = { mode: 'worktree' } | { mode: 'base'; ref: string } | { mode: 'commit'; ref: string; title?: string } | { mode: 'custom'; instructions: string };

/** 仅供菜单列举引用与解析 merge-base；代码和 diff 留给审查 Agent 自行读取。 */
export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  const { stdout } = await exec('git', ['--no-optional-locks', ...args], {
    cwd, signal, encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

export function parseTarget(input: string, locale: Locale = 'zh'): Target {
  const instructions = input.trim();
  if (!instructions) throw new Error(translate(locale, '自定义审查要求不能为空。'));
  return { mode: 'custom', instructions };
}

/**
 * 目录定位行：告诉审查 Agent「仓库在哪」，而不是指望它自己 cd 对地方。
 *
 * 为什么必须写进提示词、而不是只靠子 Agent 的 cwd：本插件走 in-process spawn
 * provider，`SubagentStartRequest.cwd` 这个字段虽然存在于类型里，但
 * `@deepseek-ai/dsh-subagent-spawn-in-process` 整个包**没有任何 cwd 处理**——
 * 子 Agent 始终继承父会话的有效目录。而父会话目录经常不是被审仓库：
 * 一个工作区根里装着多个仓库时，它甚至不是 git 仓库。于是审查 Agent 在错的
 * 树里跑 `git diff`，用户看到的就是「在 worktree 里改、评审却看主区域」。
 *
 * 所以这里给出绝对路径并要求 `git -C`。这是对 codex-rs 原文的**有意偏离**：
 * 短任务文本保持一致，只在末尾追加定位行，因为正确性优先于逐字对齐。
 */
function scopeInstruction(cwd: string): string {
  return `\n\nThe repository under review is at: ${cwd}\n`
    + `Run git commands against that directory (for example \`git -C ${cwd} diff\`); `
    + 'do not assume the current working directory is that repository.';
}

/** 对齐固定版本 codex-rs/prompts/src/review_request.rs 的短任务文本。 */
export async function reviewPrompt(target: Target, cwd: string, signal?: AbortSignal, locale: Locale = 'zh'): Promise<string> {
  signal?.throwIfAborted();
  switch (target.mode) {
    case 'worktree': return 'Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.' + scopeInstruction(cwd);
    case 'custom': {
      if (!target.instructions.trim()) throw new Error(translate(locale, '自定义审查要求不能为空。'));
      return target.instructions.trim() + scopeInstruction(cwd);
    }
    case 'commit': return (target.title
      ? `Review the code changes introduced by commit ${target.ref} ("${target.title}"). Provide prioritized, actionable findings.`
      : `Review the code changes introduced by commit ${target.ref}. Provide prioritized, actionable findings.`) + scopeInstruction(cwd);
    case 'base': {
      await git(cwd, ['rev-parse', '--show-toplevel'], signal);
      const resolveRef = async (ref: string) => {
        try { return (await git(cwd, ['rev-parse', '--verify', '--end-of-options', ref], signal)).toString('utf8').trim(); }
        catch (error) { signal?.throwIfAborted(); if (typeof (error as { code?: unknown }).code === 'number') return undefined; throw error; }
      };
      const head = await resolveRef('HEAD');
      let ref = await resolveRef(target.ref);
      if (head && ref) {
        // 上游有本地基准分支尚未包含的提交时，Codex 优先使用其 upstream。
        const upstream = await resolveRef(`${target.ref}@{upstream}`);
        if (upstream) {
          const counts = (await git(cwd, ['rev-list', '--left-right', '--count', `${ref}...${upstream}`], signal)).toString('utf8').trim().split(/\s+/);
          if (Number(counts[1]) > 0) ref = upstream;
        }
        const base = (await git(cwd, ['merge-base', head, ref], signal)).toString('utf8').trim();
        return `Review the code changes against the base branch '${target.ref}'. The merge base commit for this comparison is ${base}. Run \`git diff ${base}\` to inspect the changes relative to ${target.ref}. Provide prioritized, actionable findings.` + scopeInstruction(cwd);
      }
      return `Review the code changes against the base branch '${target.ref}'. Start by finding the merge diff between the current branch and ${target.ref}'s upstream e.g. (\`git merge-base HEAD "$(git rev-parse --abbrev-ref "${target.ref}@{upstream}")"\`), then run \`git diff\` against that SHA to see what changes we would merge into the ${target.ref} branch. Provide prioritized, actionable findings.` + scopeInstruction(cwd);
    }
  }
}
