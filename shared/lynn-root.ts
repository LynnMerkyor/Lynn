/**
 * lynn-root — 项目根目录解析
 *
 * esbuild bundle 后 import.meta.url 指向 bundle 文件，
 * 不能再用来推算源码相对路径。统一用此模块获取项目根。
 *
 * 优先级：LYNN_ROOT 环境变量 > HANA_ROOT 兼容环境变量 > 自动推算
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（包含 package.json 的目录） */
export const LYNN_ROOT: string = process.env.LYNN_ROOT || process.env.HANA_ROOT || path.resolve(__dirname, "..");

/** @deprecated use LYNN_ROOT */
export const HANA_ROOT: string = LYNN_ROOT;

/**
 * 从项目根解析路径
 * @param segments - 路径片段
 * @returns 绝对路径
 */
export function fromRoot(...segments: string[]): string {
  return path.join(LYNN_ROOT, ...segments);
}
