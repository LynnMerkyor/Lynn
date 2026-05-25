/**
 * net-utils.js — 网络相关的共享工具函数
 */

/**
 * 判断 URL 是否指向本地地址（localhost / 127.0.0.1）
 * 本地服务不需要 API key 即可访问
 */
export function isLocalBaseUrl(url: unknown): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}
