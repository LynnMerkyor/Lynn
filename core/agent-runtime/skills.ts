export interface SkillLike {
  name?: string;
  description?: string;
  instructions?: string;
  content?: string;
  [key: string]: unknown;
}

export function formatSkillsForPrompt(skills: SkillLike[] | unknown): string {
  if (!Array.isArray(skills) || !skills.length) return "";
  const blocks = skills.map((skill, index) => {
    const item = skill as SkillLike;
    const name = item.name || `skill-${index + 1}`;
    const description = item.description ? `\n${item.description}` : "";
    const body = item.instructions || item.content || "";
    return `### ${name}${description}${body ? `\n${body}` : ""}`;
  });
  return blocks.join("\n\n");
}
