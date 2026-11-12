/**
 * 会话目录解析（自研 fork 的关键修复）。
 *
 * 上游用 `agent.session.header.cwd`：那是**会话创建时**的目录（宿主只把它当
 * `workingDirectory` projection 的初始值），`cd` 之后不会更新；会话里用绝对路径
 * 改另一个工作树时更是完全不变。于是 `git diff` 跑在错误的树上——用户看到的就是
 * 「在 worktree 里改，评审却看主区域」。
 *
 * 这里改为：实时目录（`ctx.workingDirectory.ensure`）优先，取不到才退回 header.cwd。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-working-directory';

export async function resolveSessionCwd(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<string | undefined> {
  try {
    // workingDirectory 是可选依赖：宿主或测试替身可能没有它（不放进 inject，避免硬失败）。
    const service = (ctx as unknown as { workingDirectory?: { ensure?: (a: Agent, s?: AbortSignal) => Promise<string> } }).workingDirectory
      ?? (ctx as unknown as { get?: (name: string) => { ensure?: (a: Agent, s?: AbortSignal) => Promise<string> } }).get?.('workingDirectory');
    const live = await service?.ensure?.(agent, signal as AbortSignal);
    if (typeof live === 'string' && live.trim() !== '') return live;
  } catch {
    // 目录不可用（被删/没权限）→ 退回创建时目录，让上层决定要不要报错
  }
  const header = agent.session.header.cwd;
  return typeof header === 'string' && header.trim() !== '' ? header : undefined;
}

/**
 * 从 `/review` 的行内参数里取 `--cwd <path>`（自研扩展）。
 *
 * 为什么需要：即使拿到实时目录，会话在 A、改动落在 B（例如主仓库 + `.worktrees/<feat>`）
 * 时，光靠「会话目录」仍然审不到 B。允许显式指定目录，门禁才能把评审指向改动真正所在的工作树。
 *
 * @returns {{ cwd?: string, rest: string }}
 */
export function extractCwdOption(input: string): { cwd?: string; rest: string } {
  const text = String(input ?? '');
  const match = text.match(/(?:^|\s)--cwd(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!match) return { rest: text.trim() };
  const cwd = match[1] ?? match[2] ?? match[3] ?? '';
  const rest = `${text.slice(0, match.index ?? 0)} ${text.slice((match.index ?? 0) + match[0].length)}`.trim();
  return cwd === '' ? { rest } : { cwd, rest };
}
