import type { FleetVisualBox } from "../../shared/fleet-events.js";

export function extractGroundingBoxes(text: string): FleetVisualBox[] {
  const candidates = [
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), (match) => match[1] || ""),
    text,
  ];
  for (const candidate of candidates) {
    for (const raw of jsonValues(candidate)) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        const boxes = normalizeVisualBoxes(parsed);
        if (boxes.length) return boxes;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return [];
}

export function formatGroundingBox(box: FleetVisualBox, index = 0): string {
  const label = box.label || `target ${index + 1}`;
  return [
    `${label} @ x=${formatPercent(box.x)}, y=${formatPercent(box.y)}`,
    box.width !== undefined ? `w=${formatPercent(box.width)}` : null,
    box.height !== undefined ? `h=${formatPercent(box.height)}` : null,
    box.confidence !== undefined ? `conf=${formatPercent(box.confidence)}` : null,
  ].filter(Boolean).join(" · ");
}

export function renderGroundingSummary(boxes: readonly FleetVisualBox[]): string {
  if (!boxes.length) return "";
  return [
    "Grounding result:",
    ...boxes.map((box, index) => `  ${index + 1}. ${formatGroundingBox(box, index)}`),
  ].join("\n");
}

function normalizeVisualBoxes(value: unknown): FleetVisualBox[] {
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeVisualBox(entry));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.boxes)) return record.boxes.flatMap((entry) => normalizeVisualBox(entry));
  if (Array.isArray(record.results)) return record.results.flatMap((entry) => normalizeVisualBox(entry));
  return normalizeVisualBox(record);
}

function normalizeVisualBox(value: unknown): FleetVisualBox[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const boxRecord = objectValue(record.box ?? record.bbox ?? record.boundingBox ?? record.bounding_box);
  const boxArray = arrayValue(record.box ?? record.bbox ?? record.boundingBox ?? record.bounding_box);
  const source = boxRecord ?? record;
  const x = asNumber(source.x ?? source.centerX ?? source.cx ?? boxArray?.[0]);
  const y = asNumber(source.y ?? source.centerY ?? source.cy ?? boxArray?.[1]);
  if (x === null || y === null) return [];
  const width = asNumber(source.width ?? source.w ?? boxArray?.[2]);
  const height = asNumber(source.height ?? source.h ?? boxArray?.[3]);
  const confidence = asNumber(record.confidence ?? record.conf ?? record.score ?? source.confidence ?? source.conf);
  return [{
    label: labelValue(record) || labelValue(source) || "target",
    x: clamp01(x),
    y: clamp01(y),
    ...(width === null ? {} : { width: clamp01(width) }),
    ...(height === null ? {} : { height: clamp01(height) }),
    ...(confidence === null ? {} : { confidence: clamp01(confidence) }),
  }];
}

function jsonValues(text: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    const raw = balancedJsonValueAt(text, i);
    if (raw) values.push(raw);
  }
  return values;
}

function balancedJsonValueAt(text: string, start: number): string | null {
  const opening = text[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === opening) depth += 1;
    else if (ch === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function labelValue(record: Record<string, unknown>): string {
  for (const key of ["label", "reason", "target", "name", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function formatPercent(value: number): string {
  const pct = value * 100;
  if (Math.abs(pct - Math.round(pct)) < 0.05) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}
