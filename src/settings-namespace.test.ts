import { describe, it, expect } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveSettingsNamespace } from './settings-compat.js'

/**
 * settings 段 ns 的解析必须靠「宿主实际注册了什么」，不能靠猜。
 *
 * 这段是 2026-11-12 实跑炸掉的那一处：插件改名后宿主注册的 ns 变了，代码里硬编码
 * 旧字面量 → describe() 找不到描述符 → 抛 "…settings section is not registered" →
 * 所有召唤工具直接失败。这里按边界输入钉住三级匹配，避免再靠一次重启才发现问题。
 */
function ctxWithDescribe(describe: () => unknown): Context {
  return { settings: { describe } } as unknown as Context
}

describe('resolveSettingsNamespace', () => {
  it('宿主注册了行 id（expert-agents）→ 精确命中', () => {
    const ctx = ctxWithDescribe(() => [{ ns: 'expert-agents', revision: 1 }])
    expect(String(resolveSettingsNamespace(ctx))).toBe('expert-agents')
  })

  it('宿主仍按旧身份注册（agency-agents）→ 精确命中旧名，改名可回退', () => {
    const ctx = ctxWithDescribe(() => [{ ns: 'agency-agents', revision: 1 }])
    expect(String(resolveSettingsNamespace(ctx))).toBe('agency-agents')
  })

  it('宿主用完整包名注册 → 子串命中（不要求写死前缀）', () => {
    const ctx = ctxWithDescribe(() => [{ ns: '@jackchen13755/dsh-expert-agents', revision: 2 }])
    expect(String(resolveSettingsNamespace(ctx))).toBe('@jackchen13755/dsh-expert-agents')
  })

  it('精确候选与新名同时存在时优先候选（不被无关段带偏）', () => {
    const ctx = ctxWithDescribe(() => [
      { ns: 'locale', revision: 3 },
      { ns: '@jackchen13755/dsh-expert-agents', revision: 2 },
      { ns: 'expert-agents', revision: 1 },
    ])
    expect(String(resolveSettingsNamespace(ctx))).toBe('expert-agents')
  })

  it('一个都不匹配（空列表）→ 兜底新身份，让报错指得对名字', () => {
    const ctx = ctxWithDescribe(() => [])
    expect(String(resolveSettingsNamespace(ctx))).toBe('expert-agents')
  })

  it('describe 抛错（更老的宿主）→ 兜底新身份，不向调用方抛', () => {
    const ctx = ctxWithDescribe(() => { throw new Error('unsupported') })
    expect(String(resolveSettingsNamespace(ctx))).toBe('expert-agents')
  })

  it('只有无关段时不会误取别的插件的 ns', () => {
    const ctx = ctxWithDescribe(() => [{ ns: 'locale', revision: 1 }, { ns: 'review-gate', revision: 1 }])
    expect(String(resolveSettingsNamespace(ctx))).toBe('expert-agents')
  })
})
