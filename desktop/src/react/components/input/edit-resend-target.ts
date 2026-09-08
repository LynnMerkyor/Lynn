import type { ComposerTaskMode } from '../../utils/prompt-task';

export type EditResendTargetRef = {
  current: { messageId: string; sessionKey: string } | null;
};

export function consumeEditResendTarget(ref: EditResendTargetRef, mode: ComposerTaskMode, sessionKey: string): string | null {
  const target = ref.current;
  ref.current = null;
  return mode === 'prompt' && target?.sessionKey === sessionKey ? target.messageId : null;
}
