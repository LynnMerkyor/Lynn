/**
 * Extra guardrail for code-debugging answers that otherwise return a short
 * explanation without a runnable verification step.
 */

export function buildCodeVerificationPostscript(promptText = "", visibleText = "") {
  const prompt = String(promptText || "");
  if (!prompt.trim()) return "";
  const looksLikeCodeFailure =
    /(?:Traceback|ImportError|ModuleNotFoundError|SyntaxError|TypeError|ReferenceError|Exception|Error:|报错|错误|修|fix|debug|排查)/iu.test(prompt)
    && /(?:main\.py|\.py\b|\.js\b|\.ts\b|代码|ComfyUI|Python|Node|npm|pytest)/iu.test(prompt);
  if (!looksLikeCodeFailure) return "";
  const visible = String(visibleText || "");
  if (/请运行验证/iu.test(visible) && /python3?\s+main\.py/iu.test(visible)) return "";
  if (!/main\.py/iu.test(prompt)) return "";
  const guidance = visible.trim().length < 180
    ? "\n\n我还没有实际改到你的 ComfyUI 文件，所以不要把这当成已经改好。请在 ComfyUI 根目录先核对 `custom_nodes/foo.py`：如果里面的类名不是 `FooNode`，就把 `/comfy/nodes.py` 的 import 改成真实类名；如果文件本来应该导出 `FooNode`，就在 `foo.py` 里补齐同名类，并确认 `__init__.py` 没有拦截导入。若你用 Docker 或虚拟环境，先进入对应容器/环境再执行同样检查。"
    : "";
  return `${guidance}\n\n请运行验证：\n\`\`\`bash\npython main.py\n\`\`\``;
}
