// @ts-check

/**
 * @typedef {"html" | "markdown" | "code"} ArtifactType
 * @typedef {{ content?: unknown, html?: unknown, artifactType?: unknown, type?: unknown, title?: unknown, label?: unknown, artifactId?: unknown, id?: unknown, language?: unknown }} RawArtifactPayload
 * @typedef {{ defaultTitle?: string, fallbackIdPrefix?: string, fallbackId?: string, messageType?: string }} NormalizeArtifactOptions
 * @typedef {{ type: string, artifactId: string, artifactType: ArtifactType, title: string, content: string, language?: string }} NormalizedArtifactPayload
 * @typedef {{ artifactId?: string, artifactType?: ArtifactType, title?: string, content?: string, language?: string }} ArtifactToolPayload
 */

const DEFAULT_ARTIFACT_ID_PREFIX = "artifact";

/**
 * @param {unknown} content
 * @returns {boolean}
 */
export function looksLikeHtml(content) {
  return /<!doctype\s+html|<html[\s>]|<body[\s>]|<style[\s>]/i.test(String(content || ""));
}

/**
 * @param {unknown} type
 * @param {unknown} content
 * @returns {ArtifactType}
 */
export function normalizeArtifactType(type, content) {
  const raw = String(type || "").trim().toLowerCase();
  if (raw === "html" || raw === "markdown" || raw === "code") return raw;
  return looksLikeHtml(content) ? "html" : "markdown";
}

/**
 * @param {RawArtifactPayload | null | undefined} raw
 * @param {NormalizeArtifactOptions} [opts]
 * @returns {NormalizedArtifactPayload | null}
 */
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

/**
 * @param {ArtifactToolPayload | null | undefined} artifact
 * @returns {{ artifactId: string | undefined, type: ArtifactType | undefined, title: string | undefined, content: string, language: string | undefined } | null}
 */
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
