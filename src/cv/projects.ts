import { z } from 'zod';
import { MasterCvSchema, type MasterCv } from '../config.ts';
import { normalizeForMatch } from '../util/text.ts';

/*
 * Updates the projects in your master CV from a file, leaving the rest of it alone. The Tailor picks
 * the most relevant projects for each job, so the CV should hold all of them, each with several
 * highlights it can choose from.
 */

type Project = MasterCv['projects'][number];

const ProjectsFile = z.union([MasterCvSchema.shape.projects, z.object({ projects: MasterCvSchema.shape.projects })]);

/** Accepts `{ "projects": [...] }` or a bare list. */
export function parseProjectsFile(json: unknown): Project[] {
  const parsed = ProjectsFile.parse(json);
  return Array.isArray(parsed) ? parsed : parsed.projects;
}

export interface ProjectMerge {
  cv: MasterCv;
  added: string[];
  /** Replaced a project with the same ID or the same name. */
  updated: string[];
  /** Already in the CV and not in the file: left as they were. */
  kept: string[];
  /** Only with replaceAll: in the CV, not in the file, taken out. */
  removed: string[];
}

/**
 * Puts the file's projects into the CV. One with the same ID, or the same name, replaces the old
 * entry; the others are added. Projects the file doesn't mention stay, unless `replaceAll`.
 * Highlight IDs must stay unique across the whole CV: the Tailor cites them.
 */
export function mergeProjects(cv: MasterCv, incoming: Project[], opts: { replaceAll?: boolean } = {}): ProjectMerge {
  const sameProject = (a: Project, b: Project) => a.id === b.id || normalizeForMatch(a.name) === normalizeForMatch(b.name);
  const twice = incoming.find((p, i) => incoming.some((q, j) => j > i && sameProject(p, q)));
  if (twice) throw new Error(`"${twice.name}" is in the file twice (same ID or name)`);

  const replaced = (old: Project) => incoming.some((p) => sameProject(p, old));
  const untouched = cv.projects.filter((old) => !replaced(old));
  const kept = opts.replaceAll ? [] : untouched;
  const projects = [...incoming, ...kept];

  const seen = new Map<string, string>();
  const claim = (id: string, where: string) => {
    const other = seen.get(id);
    if (other) throw new Error(`Highlight ID "${id}" is used by both ${other} and ${where}: IDs must be unique across the CV`);
    seen.set(id, where);
  };
  for (const e of cv.experience) for (const h of e.highlights) claim(h.id, `${e.role}, ${e.company}`);
  for (const p of projects) for (const h of p.highlights) claim(h.id, `the project "${p.name}"`);

  return {
    cv: { ...cv, projects },
    added: incoming.filter((p) => !cv.projects.some((old) => sameProject(p, old))).map((p) => p.name),
    updated: incoming.filter((p) => cv.projects.some((old) => sameProject(p, old))).map((p) => p.name),
    kept: kept.map((p) => p.name),
    removed: opts.replaceAll ? untouched.map((p) => p.name) : [],
  };
}
