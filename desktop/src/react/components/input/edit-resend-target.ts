import type { ComposerTaskMode } from '../../utils/prompt-task';

export type EditResendTargetRef = {
  current: string | null;
};

export function consumeEditResendTarget(ref: EditResendTargetRef, mode: ComposerTaskMode): string | null {
  const target = ref.current;
  ref.current = null;
  return mode === 'prompt' ? target : null;
}
