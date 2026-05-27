/**
 * CreditInterface — 积分系统抽象接口
 *
 * 开源版提供 noop 实现（本地使用不计费）。
 * 闭源 Cloud 插件可通过 registerPlugin() 注入真正的计费实现，
 * 替换 engine.creditInterface。
 */

export class CreditInterface {
  /**
   * 获取用户积分余额
   */
  async getBalance(userId: string): Promise<number> {
    return Infinity; // 本地模式：无限积分
  }

  /**
   * 消耗积分
   */
  async consume(userId: string, amount: number, reason: string): Promise<boolean> {
    return true; // 本地模式：始终成功
  }

  /**
   * 检查是否有足够积分
   */
  async canAfford(userId: string, amount: number): Promise<boolean> {
    return true; // 本地模式：始终可以
  }
}
