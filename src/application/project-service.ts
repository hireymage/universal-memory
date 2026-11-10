import type { EntityPatch, SearchQuery } from '../domain/types.js';
import { slugify } from '../domain/routing.js';
import { MemoryService } from './memory-service.js';

export interface ProjectDecisionInput {
  title: string;
  decision: string;
  reason: string;
  context?: string;
  alternatives?: string;
  consequences?: string;
  decided_at?: string;
  supersedes?: string;
}

export class ProjectService {
  constructor(private readonly memory: MemoryService) {}
  create(title: string, content = '', metadata: Record<string, unknown> = {}, client?: string) { return this.memory.createWithDedup({ type: 'project', title, content, metadata }, client); }
  update(id: string, patch: EntityPatch, revision: string, client?: string) { return this.memory.update(id, patch, revision, client); }
  get(id: string) { return this.memory.get(id); }
  search(query: SearchQuery = {}) { return this.memory.search({ ...query, types: ['project'] }); }
  archive(id: string, revision: string, client?: string) { return this.memory.archive(id, revision, client); }
  async addNote(id: string, content: string, revision: string, client?: string) { const p = await this.get(id); return this.update(id, { content: `${p.content.trimEnd()}\n\n${content.trim()}\n` }, revision, client); }

  async recordDecision(projectId: string, input: ProjectDecisionInput, client?: string) {
    const project = await this.get(projectId);
    const sections = [
      `# ${input.title}`,
      ...(input.context?.trim() ? [`## Kontext\n${input.context.trim()}`] : []),
      `## Rozhodnutí\n${input.decision.trim()}`,
      `## Důvod\n${input.reason.trim()}`,
      ...(input.alternatives?.trim() ? [`## Zvažované alternativy\n${input.alternatives.trim()}`] : []),
      ...(input.consequences?.trim() ? [`## Dopady a další kroky\n${input.consequences.trim()}`] : []),
      `## Projekt\n[[${project.metadata.title}]]`,
    ];
    return this.memory.createWithDedup({
      type: 'project_decision', title: input.title, content: `${sections.join('\n\n')}\n`,
      metadata: {
        project_id: project.metadata.id, project_slug: slugify(project.metadata.title),
        decided_at: input.decided_at ?? new Date().toISOString(), status: 'active',
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      },
    }, client);
  }

  async context(id: string) {
    const project = await this.get(id);
    const decisions = (await this.memory.search({ types: ['project_decision'], limit: 200 }))
      .filter(entity => entity.metadata.project_id === id)
      .sort((a, b) => String(a.metadata.decided_at ?? a.metadata.created_at).localeCompare(String(b.metadata.decided_at ?? b.metadata.created_at)));
    return { project, decisions, related: await this.memory.related(id) };
  }
}