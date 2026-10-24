import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatSkillListing,
  loadSkillCatalog,
  parseSkillFile,
  readSkillBody,
} from "../src/skills.js";
import { runClientTool } from "../src/tools/registry.js";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-skill-"));
  process.env.LYNN_DATA_DIR = path.join(tmp, "data");
});

afterEach(async () => {
  delete process.env.LYNN_DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seedSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`, "utf8");
}

describe("skills", () => {
  it("parses frontmatter", () => {
    expect(parseSkillFile("---\nname: pdf\ndescription: Handle PDFs\n---\nSteps", "fallback"))
      .toEqual({ name: "pdf", description: "Handle PDFs", body: "Steps" });
  });

  it("lists only names and descriptions", async () => {
    const repo = path.join(tmp, "repo");
    await seedSkill(path.join(repo, ".lynn", "skills"), "pdf", "Handle PDFs", "SECRET BODY");
    const skills = await loadSkillCatalog(repo);
    const listing = formatSkillListing(skills);
    expect(listing).toContain("pdf: Handle PDFs");
    expect(listing).not.toContain("SECRET BODY");
    expect(listing).toContain("load_skill");
  });

  it("lets project skills override user skills with the same name", async () => {
    const repo = path.join(tmp, "repo");
    await seedSkill(path.join(tmp, "data", "skills"), "deploy", "user deploy", "user body");
    await seedSkill(path.join(repo, ".lynn", "skills"), "deploy", "project deploy", "project body");
    const skills = await loadSkillCatalog(repo);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "deploy", description: "project deploy", source: "project" });
  });

  it("loads the body on demand and through the tool", async () => {
    const repo = path.join(tmp, "repo");
    await seedSkill(path.join(repo, ".lynn", "skills"), "pdf", "Handle PDFs", "STEP ONE");
    await expect(readSkillBody("pdf", repo)).resolves.toMatchObject({ body: "STEP ONE" });
    await expect(readSkillBody("nope", repo)).resolves.toBeNull();

    const result = await runClientTool({ cwd: repo, approval: "ask" }, { name: "load_skill", skill: "pdf" });
    expect(result.ok).toBe(true);
    expect((result.output as { body: string }).body).toContain("STEP ONE");
    await expect(runClientTool({ cwd: repo, approval: "ask" }, { name: "load_skill", skill: "missing" }))
      .rejects.toThrow(/unknown skill/);
  });
});
