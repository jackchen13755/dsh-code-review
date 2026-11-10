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
export declare function resolveSessionCwd(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<string | undefined>;
/**
 * 从 `/review` 的行内参数里取 `--cwd <path>`（自研扩展）。
 *
 * 为什么需要：即使拿到实时目录，会话在 A、改动落在 B（例如主仓库 + `.worktrees/<feat>`）
 * 时，光靠「会话目录」仍然审不到 B。允许显式指定目录，门禁才能把评审指向改动真正所在的工作树。
 *
 * @returns {{ cwd?: string, rest: string }}
 */
export declare function extractCwdOption(input: string): {
    cwd?: string;
    rest: string;
};
