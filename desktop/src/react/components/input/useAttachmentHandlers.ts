import { useCallback, type ChangeEvent, type ClipboardEvent } from 'react';
import { useStore } from '../../stores';
import { isImageLikeFile } from './multimodal-guard';
import { hanaFetch } from '../../hooks/use-hana-fetch';

interface AttachedFilePayload {
  path: string;
  name: string;
  isDirectory?: boolean;
  base64Data?: string;
  mimeType?: string;
  uploadId?: string;
}

interface UseAttachmentHandlersArgs {
  addAttachedFile: (file: AttachedFilePayload) => void;
  setComposerTextFromEvent: (text: string) => void;
  supportsVision: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  warnVisionUnsupported: () => void;
}

export function useAttachmentHandlers({
  addAttachedFile,
  setComposerTextFromEvent,
  supportsVision,
  t,
  warnVisionUnsupported,
}: UseAttachmentHandlersArgs) {
  const handleFileInputChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    let warnedVisionUnsupported = false;
    for (const file of Array.from(files)) {
      if (useStore.getState().attachedFiles.length >= 9) break;
      if (!supportsVision && isImageLikeFile(file)) {
        if (!warnedVisionUnsupported) {
          warnVisionUnsupported();
          warnedVisionUnsupported = true;
        }
        continue;
      }
      const filePath = await window.platform?.getFilePath?.(file);
      if (filePath) {
        if (file.size > 50 * 1024 * 1024) {
          addAttachedFile({ path: filePath, name: file.name });
          continue;
        }
        try {
          const response = await hanaFetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: [filePath] }),
          });
          const data = await response.json();
          const uploaded = data.uploads?.find((item: { src: string }) => item.src === filePath);
          if (!response.ok || !uploaded?.dest || !uploaded.uploadId) {
            throw new Error(uploaded?.error || data.error || t('input.attachmentUploadFailed'));
          }
          addAttachedFile({ path: uploaded.dest, name: file.name, uploadId: uploaded.uploadId });
        } catch (error) {
          useStore.getState().addToast(error instanceof Error ? error.message : t('input.attachmentUploadFailed'), 'error');
        }
      } else if (isImageLikeFile(file)) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (!match) return;
          const [, mimeType, base64Data] = match;
          addAttachedFile({
            path: `local-${Date.now()}-${file.name}`,
            name: file.name,
            base64Data,
            mimeType,
          });
        };
        reader.readAsDataURL(file);
      } else {
        addAttachedFile({ path: file.name, name: file.name });
      }
    }
    e.target.value = '';
  }, [addAttachedFile, supportsVision, warnVisionUnsupported, t]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    const text = e.clipboardData?.getData('text/plain') || '';
    const imageItem = items ? Array.from(items).find(item => item.type.startsWith('image/')) : null;

    if (text) {
      e.preventDefault();
      setComposerTextFromEvent(text);
      return;
    }

    if (!imageItem) return;
    if (!supportsVision) {
      e.preventDefault();
      warnVisionUnsupported();
      return;
    }
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) return;
      const [, mimeType, base64Data] = match;
      const ext = mimeType.split('/')[1] || 'png';
      addAttachedFile({
        path: `clipboard-${Date.now()}.${ext}`,
        name: `${t('input.pastedImage')}.${ext}`,
        base64Data,
        mimeType,
      });
    };
    reader.readAsDataURL(file);
  }, [addAttachedFile, setComposerTextFromEvent, supportsVision, t, warnVisionUnsupported]);

  return { handleFileInputChange, handlePaste };
}
