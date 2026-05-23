export const LOCAL_COMPLETION_TOOLS = new Set(["bash", "write", "edit", "edit-diff"]);

export function buildLocalToolSuccessFallback() {
  return "";
}

export function buildSuccessfulToolNoTextFallback() {
  return "";
}

export function buildFailedToolFallbackText() {
  return "";
}

export function buildCodingDiagnosticVerificationAppend() {
  return "";
}

export function buildToolContinuationRetryPrompt(originalPrompt) {
  return String(originalPrompt || "").trim();
}

export function commandLooksLikeLocalMutation(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s/])(?:mkdir|mv|cp|rsync|rm|rmdir|trash|touch|install\s+-d|ditto|osascript)(?=\s|$|[;&|()])/i.test(text)
    || /(?:>|>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/.test(text)
    || /\b(?:shutil\.(?:move|copy|copy2|copytree|rmtree)|os\.(?:rename|renames|replace|remove|unlink|makedirs|mkdir|rmdir)|Path\([^)]*\)\.mkdir|fs\.(?:rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|writeFile|writeFileSync))\b/.test(text);
}

export function commandLooksLikeMoveOrCopy(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s/])(?:mv|cp|rsync|ditto)(?=\s|$|[;&|()])/i.test(text)
    || /\b(?:shutil\.(?:move|copy|copy2|copytree)|os\.(?:rename|renames|replace)|fs\.(?:rename|renameSync|copyFile|copyFileSync))\b/.test(text);
}

export function commandLooksLikeCreate(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s/])(?:mkdir|touch|install\s+-d)(?=\s|$|[;&|()])/i.test(text)
    || /(?:>|>>)\s*(?:"[^"]+"|'[^']+'|[^\s;&|]+)/.test(text)
    || /\b(?:os\.(?:makedirs|mkdir)|Path\([^)]*\)\.mkdir|fs\.(?:mkdir|mkdirSync|writeFile|writeFileSync))\b/.test(text);
}

export function commandLooksLikeDelete(command = "") {
  const text = String(command || "").trim();
  if (!text) return false;
  return /(^|[;&|()\s/])(?:rm|rmdir|trash)(?=\s|$|[;&|()])/i.test(text)
    || /\bfind\b[^|;&]*\s-delete\b/i.test(text)
    || /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir)|fs\.(?:rm|rmSync|unlink|unlinkSync))\b/.test(text);
}

export function classifyRequestedLocalMutation(prompt = "") {
  const text = String(prompt || "");
  const requiresDelete = /(?:删除|删掉|移除|清理掉|trash|delete|remove)/i.test(text);
  const requiresMove = /(?:移动|挪到|挪进|挪去|放到|放进|归档|归类|整理|分类|复制|拷贝|\bmove\b|\bcopy\b|\barchive\b|\borganize\b)/i.test(text);
  const requiresCreate = !requiresDelete && /(?:新建|创建|建立|建一个|生成|写入|写到|保存到|文件夹|目录|\bmkdir\b|\bcreate\b|\bwrite\b|\bsave\b)/i.test(text);
  if (!requiresDelete && !requiresMove && !requiresCreate) return null;
  return { requiresDelete, requiresMove, requiresCreate };
}

export function shouldRetryUnverifiedLocalMutation() {
  return false;
}

export function buildLocalMutationContinuationRetryPrompt(originalPrompt) {
  return String(originalPrompt || "").trim();
}

const PENDING_MUTATION_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MUTATION_CONFIRMATION_PATTERN = /^\s*(?:确认删除|确认执行|执行删除|继续执行|确认[\s,，]*(?:执行|删除)|confirm(?:\s+delete)?|yes|y|ok|okay|do\s+it|go\s+ahead|proceed)\s*[。.!！,，]?\s*$/i;

function rememberPendingDeleteConfirmation(ss, originalPrompt, requirement) {
  if (!ss || !originalPrompt || !requirement?.requiresDelete) return;
  ss.pendingMutationContext = {
    originalPrompt: String(originalPrompt).slice(0, 4000),
    requirement,
    recordedAt: Date.now(),
  };
}

export function recordPendingDeleteRequest(ss, originalPrompt) {
  if (!ss || !originalPrompt) return false;
  const requirement = classifyRequestedLocalMutation(originalPrompt);
  if (!requirement?.requiresDelete) return false;
  rememberPendingDeleteConfirmation(ss, originalPrompt, requirement);
  return true;
}

export function clearPendingMutationOnSuccessfulDelete(ss, command) {
  if (!ss || !ss.pendingMutationContext) return false;
  if (!commandLooksLikeDelete(command)) return false;
  ss.pendingMutationContext = null;
  return true;
}

export function buildPostRehydrateEscalationPrompt(originalPrompt) {
  return String(originalPrompt || "").trim();
}

export function consumeMutationConfirmation(ss, userInput, { now = Date.now() } = {}) {
  if (!ss || !ss.pendingMutationContext) return null;
  const ctx = ss.pendingMutationContext;
  const recordedAt = Number(ctx?.recordedAt) || 0;
  if (!recordedAt || now - recordedAt > PENDING_MUTATION_CONFIRMATION_TTL_MS) {
    ss.pendingMutationContext = null;
    return null;
  }
  const text = String(userInput || "").trim();
  if (!text || !MUTATION_CONFIRMATION_PATTERN.test(text)) return null;
  ss.pendingMutationContext = null;
  const originalPrompt = String(ctx.originalPrompt || "").slice(0, 4000);
  if (!originalPrompt) return null;
  return {
    originalPrompt,
    requirement: ctx.requirement || null,
    retryPrompt: buildLocalMutationContinuationRetryPrompt(originalPrompt),
  };
}

export function buildEmptyReplyFallbackText() {
  return "";
}

export function buildEmptyReplyRetryPrompt(originalPromptText) {
  return String(originalPromptText || "").trim();
}

export function stripRouteMetadataLeaks(text) {
  return String(text || "");
}

export function buildShortLeadInRetryPrompt(originalPromptText) {
  return String(originalPromptText || "").trim();
}

export function looksLikeTruncatedStructuredAnswer() {
  return false;
}

export function buildTruncatedStructuredRetryPrompt(originalPromptText) {
  return String(originalPromptText || "").trim();
}

export function buildToolFailedRetryPrompt(originalPromptText) {
  return String(originalPromptText || "").trim();
}
