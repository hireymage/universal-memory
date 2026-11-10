import { StorageRouter } from './domain/routing.js';
import { MarkdownStorage } from './adapters/markdown/markdown-storage.js';
import { InMemoryIndex } from './adapters/index/in-memory-index.js';
import { FileAuditSink, FileChangesetStore } from './adapters/audit/file-audit.js';
import { MigrationLedger } from './adapters/migration/migration-ledger.js';
import { MemoryService } from './application/memory-service.js';
import { PeopleService } from './application/people-service.js';
import { ProjectService } from './application/project-service.js';
import { MaintenanceService } from './application/maintenance-service.js';
import { AgentProfileService } from './application/agent-profile-service.js';
import { GraphService } from './application/graph-service.js';
import { SourceService } from './application/source-service.js';
import type { AppConfig } from './config/schema.js';

export async function compose(config: AppConfig) {
  const index = new InMemoryIndex();
  const router = new StorageRouter(config.vault_root, config.routing);
  const audit = new FileAuditSink(config.audit_dir);
  const storage = new MarkdownStorage(config.vault_root, router, index, config.read_only);
  const memory = new MemoryService(storage, index, audit, config.routing);
  const people = new PeopleService(memory, index);
  const projects = new ProjectService(memory);
  const changesets = new FileChangesetStore(`${config.audit_dir}/changesets`);
  const maintenance = new MaintenanceService(storage, index, changesets, memory, audit);
  const agents = new AgentProfileService(memory);
  const graph = new GraphService(storage, index, audit, memory);
  const sources = new SourceService(memory, index);
  const migrationLedger = new MigrationLedger(`${config.audit_dir}/migration-ledger.jsonl`);
  return { config, index, storage, audit, memory, people, projects, maintenance, agents, graph, sources, migrationLedger };
}
export type Services = Awaited<ReturnType<typeof compose>>;