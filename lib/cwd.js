export async function resolveSessionCwd(ctx, agent, signal) {
    try {
        // workingDirectory 是可选依赖：宿主或测试替身可能没有它（不放进 inject，避免硬失败）。
        const service = ctx.workingDirectory
            ?? ctx.get?.('workingDirectory');
        const live = await service?.ensure?.(agent, signal);
        if (typeof live === 'string' && live.trim() !== '')
            return live;
    }
    catch {
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
export function extractCwdOption(input) {
    const text = String(input ?? '');
    const match = text.match(/(?:^|\s)--cwd(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (!match)
        return { rest: text.trim() };
    const cwd = match[1] ?? match[2] ?? match[3] ?? '';
    const rest = `${text.slice(0, match.index ?? 0)} ${text.slice((match.index ?? 0) + match[0].length)}`.trim();
    return cwd === '' ? { rest } : { cwd, rest };
}
