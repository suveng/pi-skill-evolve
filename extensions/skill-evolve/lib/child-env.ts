/**
 * 子进程门禁（设计稿 4.2 门禁⓪）：任一环境变量在场就说明当前不是用户主会话。
 *
 * 单独成文件的原因：evolution.ts 要守 300 行；这里只是一个常量加一个判据，无副作用。
 */
const CHILD_ENV_KEYS = ["SKILL_EVOLVE_CHILD", "PI_SUBAGENT_CHILD", "PI_AGENT_RUNNER", "PI_ASYNC_NATIVE_RUNNER"];

export function isChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return CHILD_ENV_KEYS.some((key) => Boolean(env[key]));
}
