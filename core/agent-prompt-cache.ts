import { createHash } from 'crypto';

export interface AgentStaticPromptCacheInput {
  isZh: boolean;
  yuanType: string;
  personality: string;
  skillsText: string;
  learnSkillsEnabled: boolean;
  allowGithubFetch: boolean;
}

export function createAgentStaticPromptCacheKey(input: AgentStaticPromptCacheInput): string {
  return createHash('sha1')
    .update(input.isZh ? 'zh' : 'non-zh')
    .update('\0')
    .update(input.yuanType)
    .update('\0')
    .update(input.personality)
    .update('\0')
    .update(input.skillsText)
    .update('\0')
    .update(input.learnSkillsEnabled ? 'learn-on' : 'learn-off')
    .update('\0')
    .update(input.allowGithubFetch ? 'github-on' : 'github-off')
    .digest('hex');
}
