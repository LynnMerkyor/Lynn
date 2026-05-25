const DEFAULT_ARTIFACT_ID_PREFIX = "artifact";

export function looksLikeHtml(content) {
  return /<!doctype\s+html|<html[\s>]|<body[\s>]|<style[\s>]/i.test(String(content || ""));
}

export function normalizeArtifactType(type, content) {
  const raw = String(type || "").trim().toLowerCase();
  if (raw === "html" || raw === "markdown" || raw === "code") return raw;
  return looksLikeHtml(content) ? "html" : "markdown";
}

export function normalizeArtifactPayload(raw, opts = {}) {
  if (!raw || typeof raw !== "object") return null;
  const content = String(raw.content || raw.html || "").trim();
  if (!content) return null;
  const artifactType = normalizeArtifactType(raw.artifactType || raw.type, content);
  const title = String(raw.title || raw.label || opts.defaultTitle || (artifactType === "html" ? "HTML 报告" : "生成内容")).trim();
  const fallbackPrefix = String(opts.fallbackIdPrefix || DEFAULT_ARTIFACT_ID_PREFIX).trim() || DEFAULT_ARTIFACT_ID_PREFIX;
  const fallbackId = `${fallbackPrefix}-${Date.now()}`;
  const artifactId = String(raw.artifactId || raw.id || opts.fallbackId || fallbackId).trim();
  return {
    type: opts.messageType || artifactType,
    artifactId,
    artifactType,
    title,
    content,
    language: raw.language == null ? (artifactType === "html" ? "html" : undefined) : String(raw.language),
  };
}

export function artifactToolArguments(artifact) {
  if (!artifact?.content) return null;
  return {
    artifactId: artifact.artifactId,
    type: artifact.artifactType,
    title: artifact.title,
    content: artifact.content,
    language: artifact.language,
  };
}
