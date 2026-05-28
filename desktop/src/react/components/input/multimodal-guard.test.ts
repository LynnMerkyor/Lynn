import { describe, expect, it } from 'vitest';
import {
  formatVisionUnsupportedMessage,
  isImageLikeFile,
  isImageLikeName,
  modelDisplayName,
  modelSupportsVision,
} from './multimodal-guard';

describe('multimodal guard helpers', () => {
  it('recognizes image files from mime type or extension', () => {
    expect(isImageLikeFile({ name: 'screenshot.png', type: '' })).toBe(true);
    expect(isImageLikeFile({ name: 'scan.HEIC', type: 'application/octet-stream' })).toBe(true);
    expect(isImageLikeFile({ name: 'clipboard', type: 'image/webp' })).toBe(true);
    expect(isImageLikeName('notes.md')).toBe(false);
  });

  it('keeps current vision semantics explicit', () => {
    expect(modelSupportsVision({ vision: true })).toBe(true);
    expect(modelSupportsVision({ vision: undefined })).toBe(true);
    expect(modelSupportsVision({ vision: false })).toBe(false);
    expect(modelSupportsVision(null)).toBe(false);
  });

  it('formats model-aware warnings for non-vision image input', () => {
    expect(modelDisplayName({ id: 'spark', provider: 'brain', name: 'Spark' })).toBe('Spark');
    expect(formatVisionUnsupportedMessage('Spark', 'zh-CN')).toContain('Spark');
    expect(formatVisionUnsupportedMessage('Spark', 'en-US')).toContain('Current model (Spark)');
  });
});
