import { createHash } from 'node:crypto';
import type { Entity } from '../domain/types.js';
import { MemoryError } from '../domain/errors.js';
import { MemoryService } from './memory-service.js';

const ID = /^[a-z][a-z0-9_-]{1,63}$/;
const LANG = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const defaultLanguage = () => ({ user_language: 'cs', internal_language: 'en', agent_language: 'en' });
const hash = (value: string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export interface ProfileTexts {
  machine_en: string;
  human_cs: string;
}

export interface LanguagePolicy {
  user_language: string;
  internal_language: string;
  agent_language: string;
}

export interface CreateAgentInput {
  agent_id: string;
  name: string;
  machine_en: string;
  human_cs: string;
  soul: ProfileTexts;
  enabled?: boolean;
  default_role?: string;
  language_policy?: Partial<LanguagePolicy>;
  client?: string;
}

export interface ProfileRepresentation {
  id: string;
  title: string;
  machine_en: string;
  human_cs: string;
  component_version: number;
  canonical_hash: string;
  revision: string;
  translation_revision: string;
}

interface ComponentPair {
  en: Entity;
  cs: Entity;
}

export class AgentProfileService {
  private readonly memory: MemoryService;
  constructor(memory: MemoryService) { this.memory = memory; }

  async create(input: CreateAgentInput): Promise<unknown> {
    this.assertAgentId(input.agent_id);
    this.assertTexts(input);
    this.assertTexts(input.soul);
    if (await this.identity(input.agent_id).catch(error => error instanceof MemoryError && error.code === 'NOT_FOUND' ? undefined : Promise.reject(error)))
      throw new MemoryError('CONFLICT', `Agent already exists: ${input.agent_id}`);
    const policy = { ...defaultLanguage(), ...(input.language_policy ?? {}) };
    this.assertPolicy(policy);
    const defaultRole = input.default_role ?? 'general';
    this.assertRoleId(defaultRole);
    if (defaultRole !== 'general')
      throw new MemoryError('VALIDATION_ERROR', 'Create the agent with default_role: general, then create and activate the requested role.');
    const identity = await this.createPair('agent_identity', 'identity', input.agent_id, input.name, this.texts(input), {
      enabled: input.enabled ?? true, default_role: defaultRole, ...policy,
    }, input.client);
    await this.createPair('agent_soul', 'soul', input.agent_id, `${input.name} Soul`, input.soul, {}, input.client);
    await this.createPair('agent_role', 'role:general', input.agent_id, `${input.name} — general`, {
      machine_en: 'General working mode. Follow the Soul and current user request.',
      human_cs: 'Obecný pracovní režim. Dodržuj Soul a aktuální požadavek uživatele.',
    }, { role_id: 'general', role_name: 'general', enabled: true }, input.client);
    return this.get(input.agent_id, identity.en.metadata.id);
  }

  async list(): Promise<unknown[]> {
    return (await this.memory.search({ types: ['agent_identity'], limit: 200 }))
      .filter(e => typeof e.metadata.agent_id === 'string')
      .map(e => ({ agent_id: e.metadata.agent_id, name: e.metadata.title, enabled: e.metadata.enabled !== false, default_role: e.metadata.default_role, profile_version: e.metadata.profile_version ?? 1, updated_at: e.metadata.updated_at }));
  }

  async bootstrap(agentId: string, knownHash?: string, sessionRole?: string): Promise<unknown> {
    const identity = (await this.identity(agentId)) as ComponentPair;
    if (identity.en.metadata.enabled === false) throw new MemoryError('VALIDATION_ERROR', `Agent is disabled: ${agentId}`);
    const soul = await this.component(agentId, 'agent_soul', 'soul');
    const roleId = sessionRole ?? String(identity.en.metadata.default_role ?? 'general');
    const role = await this.component(agentId, 'agent_role', `role:${roleId}`);
    if (role.en.metadata.enabled === false) throw new MemoryError('VALIDATION_ERROR', `Role is disabled: ${roleId}`);
    const profileHash = hash(JSON.stringify([identity.en.content, soul.en.content, role.en.content, this.policy(identity.en), roleId]));
    const profileVersion = this.profileVersion(identity.en, soul.en, [{ en: role.en }]);
    if (knownHash === profileHash) return { agent_id: agentId, profile_hash: profileHash, profile_version: profileVersion, unchanged: true };
    return {
      agent_id: agentId, profile_hash: profileHash, profile_version: profileVersion, unchanged: false,
      language_policy: this.policy(identity.en), active_role: roleId,
      machine_context: compactContext(identity.en, soul.en, role.en, this.policy(identity.en), roleId),
    };
  }

  async get(agentId: string, _knownId?: string): Promise<unknown> {
    const identity = await this.identity(agentId);
    const soul = await this.component(agentId, 'agent_soul', 'soul');
    const roles = await this.roles(agentId);
    return {
      agent_id: agentId,
      identity: toRepresentation(identity.en, identity.cs),
      soul: toRepresentation(soul.en, soul.cs),
      language_policy: this.policy(identity.en),
      enabled: identity.en.metadata.enabled !== false,
      default_role: String(identity.en.metadata.default_role ?? 'general'),
      roles: roles.map(r => ({ role_id: r.en.metadata.role_id as string, name: r.en.metadata.role_name, enabled: r.en.metadata.enabled !== false, representation: toRepresentation(r.en, r.cs) })),
      profile_version: this.profileVersion(identity.en, soul.en, roles),
    };
  }

  async deactivate(agentId: string, expectedRevision: string, client?: string): Promise<unknown> {
    const identity = await this.identity(agentId);
    if (identity.en.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Agent identity changed since it was read');
    const updated = await this.memory.update(identity.en.metadata.id, { metadata: { enabled: false } }, identity.en.revision, client);
    await this.memory.update(identity.cs.metadata.id, { metadata: { enabled: false } }, identity.cs.revision, client);
    return { agent_id: agentId, enabled: false, revision: updated.revision };
  }

  async updateIdentity(agentId: string, input: ProfileTexts & { name?: string; enabled?: boolean; default_role?: string; expected_revision: string; client?: string }): Promise<unknown> {
    const current = await this.identity(agentId);
    if (current.en.revision !== input.expected_revision) throw new MemoryError('CONFLICT', 'Agent identity changed since it was read');
    if (input.default_role) {
      this.assertRoleId(input.default_role);
      await this.role(agentId, input.default_role);
    }
    return this.updatePair(current, 'identity', input.name ?? current.en.metadata.title, this.texts(input), {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.default_role ? { default_role: input.default_role } : {}),
    }, input.client);
  }

  async soul(agentId: string): Promise<unknown> { const pair = await this.component(agentId, 'agent_soul', 'soul'); return toRepresentation(pair.en, pair.cs); }

  async updateSoul(agentId: string, input: ProfileTexts & { expected_revision: string; client?: string }): Promise<unknown> {
    const pair = await this.component(agentId, 'agent_soul', 'soul');
    if (pair.en.revision !== input.expected_revision) throw new MemoryError('CONFLICT', 'Soul changed since it was read');
    return this.updatePair(pair, 'soul', pair.en.metadata.title, input, {}, input.client);
  }

  async language(agentId: string): Promise<unknown> {
    const identity = await this.identity(agentId);
    return this.policy(identity.en);
  }

  async updateLanguage(agentId: string, policy: LanguagePolicy, expectedRevision: string, client?: string): Promise<unknown> {
    this.assertPolicy(policy);
    const identity = await this.identity(agentId);
    if (identity.en.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Agent identity changed since it was read');
    const metadata = { ...policy };
    const updated = await this.memory.update(identity.en.metadata.id, { metadata }, identity.en.revision, client);
    await this.memory.update(identity.cs.metadata.id, { metadata }, identity.cs.revision, client);
    return updated;
  }

  async roles(agentId: string): Promise<Array<{ en: Entity; cs: Entity }>> {
    const en = (await this.memory.search({ types: ['agent_role'], limit: 200 })).filter(e => e.metadata.agent_id === agentId);
    return Promise.all(en.map(async (entity) => ({
      en: entity,
      cs: (await this.component(agentId, 'agent_role_cs', `role:${entity.metadata.role_id as string}`, true)).cs,
    })));
  }

  async role(agentId: string, roleId: string): Promise<unknown> {
    this.assertRoleId(roleId);
    const pair = await this.component(agentId, 'agent_role', `role:${roleId}`);
    return toRepresentation(pair.en, pair.cs);
  }

  async createRole(agentId: string, input: ProfileTexts & { role_id: string; name?: string; enabled?: boolean; client?: string }): Promise<unknown> {
    await this.identity(agentId);
    this.assertRoleId(input.role_id);
    this.assertTexts(input);
    try {
      await this.role(agentId, input.role_id);
      throw new MemoryError('CONFLICT', `Role already exists: ${input.role_id}`);
    }
    catch (error) {
      if (!(error instanceof MemoryError && error.code === 'NOT_FOUND')) throw error;
    }
    return this.createPair('agent_role', `role:${input.role_id}`, agentId, input.name ?? `${agentId} — ${input.role_id}`, input, {
      role_id: input.role_id, role_name: input.name ?? input.role_id, enabled: input.enabled ?? true,
    }, input.client);
  }

  async updateRole(agentId: string, roleId: string, input: ProfileTexts & { expected_revision: string; name?: string; enabled?: boolean; client?: string }): Promise<unknown> {
    const pair = await this.component(agentId, 'agent_role', `role:${roleId}`);
    if (pair.en.revision !== input.expected_revision) throw new MemoryError('CONFLICT', 'Role changed since it was read');
    return this.updatePair(pair, `role:${roleId}`, input.name ?? pair.en.metadata.title, input, {
      ...(input.name ? { role_name: input.name } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    }, input.client);
  }

  async archiveRole(agentId: string, roleId: string, expectedRevision: string, client?: string): Promise<unknown> {
    const pair = await this.component(agentId, 'agent_role', `role:${roleId}`);
    if (pair.en.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Role changed since it was read');
    const identity = await this.identity(agentId);
    if (String(identity.en.metadata.default_role ?? 'general') === roleId)
      throw new MemoryError('VALIDATION_ERROR', 'Activate another role before archiving the current default role');
    const en = await this.memory.update(pair.en.metadata.id, { metadata: { status: 'archived', enabled: false } }, pair.en.revision, client);
    await this.memory.update(pair.cs.metadata.id, { metadata: { status: 'archived', enabled: false } }, pair.cs.revision, client);
    return { agent_id: agentId, role_id: roleId, status: en.metadata.status, revision: en.revision };
  }

  async activateRole(agentId: string, roleId: string, expectedRevision: string, client?: string): Promise<Entity> {
    await this.role(agentId, roleId);
    const identity = await this.identity(agentId);
    if (identity.en.revision !== expectedRevision) throw new MemoryError('CONFLICT', 'Agent identity changed since it was read');
    const updated = await this.memory.update(identity.en.metadata.id, { metadata: { default_role: roleId } }, identity.en.revision, client);
    await this.memory.update(identity.cs.metadata.id, { metadata: { default_role: roleId } }, identity.cs.revision, client);
    return updated;
  }

  async translationStatus(agentId: string): Promise<unknown> {
    const issues: Array<{ component?: string | undefined; code: string; message: string }> = [];
    for (const pair of [await this.identity(agentId), await this.component(agentId, 'agent_soul', 'soul'), ...(await this.roles(agentId))]) {
      if (pair.en.metadata.canonical_hash !== pair.cs.metadata.canonical_hash || pair.en.metadata.component_version !== pair.cs.metadata.translation_version)
        issues.push({ component: String(pair.en.metadata.component_key), code: 'STALE_TRANSLATION', message: 'Czech representation does not match canonical English version/hash' });
    }
    return { agent_id: agentId, synchronized: issues.length === 0, issues };
  }

  async prepareTranslationSync(agentId: string): Promise<unknown> {
    const components = [await this.identity(agentId), await this.component(agentId, 'agent_soul', 'soul'), ...(await this.roles(agentId))]
      .filter(pair => pair.en.metadata.canonical_hash !== pair.cs.metadata.canonical_hash || pair.en.metadata.component_version !== pair.cs.metadata.translation_version);
    return {
      agent_id: agentId, dry_run: true,
      changes: components.map(pair => ({
        component: String(pair.en.metadata.component_key),
        canonical_english: pair.en.content,
        expected_component_version: pair.en.metadata.component_version,
        expected_canonical_hash: pair.en.metadata.canonical_hash,
        required_input: 'Provide a Czech human_cs representation through the matching update action; MCP will validate and write it.',
      })),
    };
  }

  async validate(agentId: string): Promise<unknown> {
    const issues: Array<{ code: string; message: string }> = [];
    let identity: ComponentPair;
    try {
      identity = await this.identity(agentId);
    }
    catch {
      issues.push({ code: 'MISSING_IDENTITY', message: 'Missing canonical agent identity' });
      return { agent_id: agentId, valid: false, issues };
    }
    try {
      await this.component(agentId, 'agent_soul', 'soul');
    }
    catch {
      issues.push({ code: 'MISSING_SOUL', message: 'Missing canonical Soul' });
    }
    try {
      this.assertPolicy(this.policy(identity.en));
    }
    catch (error) {
      issues.push({ code: 'INVALID_LANGUAGE_POLICY', message: error instanceof Error ? error.message : String(error) });
    }
    try {
      await this.role(agentId, String(identity.en.metadata.default_role ?? ''));
    }
    catch {
      issues.push({ code: 'INVALID_DEFAULT_ROLE', message: 'Default role does not exist' });
    }
    const translation = await this.translationStatus(agentId) as { issues: Array<{ component?: string | undefined; code: string; message: string }> };
    for (const issue of translation.issues) issues.push(issue);
    return { agent_id: agentId, valid: issues.length === 0, issues };
  }

  private async identity(agentId: string): Promise<ComponentPair> {
    return this.component(agentId, 'agent_identity', 'identity');
  }
  private async component(agentId: string, type: string, key: string, allowTypeAsCanonical = false): Promise<ComponentPair> {
    const canonicalType = allowTypeAsCanonical ? type.replace(/_cs$/, '') : type;
    const en = (await this.memory.search({ types: [canonicalType], limit: 200 }))
      .find(e => e.metadata.agent_id === agentId && e.metadata.component_key === key);
    if (!en) throw new MemoryError('NOT_FOUND', `Profile component not found: ${agentId}/${key}`);
    const csType = `${canonicalType}_cs`;
    const cs = (await this.memory.search({ types: [csType], limit: 200 }))
      .find(e => e.metadata.agent_id === agentId && e.metadata.component_key === key);
    if (!cs) throw new MemoryError('NOT_FOUND', `Czech profile representation not found: ${agentId}/${key}`);
    return { en, cs };
  }
  private async createPair(type: string, key: string, agentId: string, title: string, texts: ProfileTexts, extra: Record<string, unknown>, client?: string): Promise<ComponentPair> {
    const version = 1;
    const canonicalHash = hash(texts.machine_en);
    const shared = { agent_id: agentId, component_key: key, canonical_language: 'en', component_version: version, canonical_hash: canonicalHash, ...extra };
    const en = await this.memory.create({ type, title, content: texts.machine_en, metadata: { ...shared, representation: 'en', translation_version: version } }, client);
    const cs = await this.memory.create({ type: `${type}_cs`, title, content: texts.human_cs, metadata: { ...shared, representation: 'cs', translation_version: version } }, client);
    return { en, cs };
  }
  private async updatePair(current: ComponentPair, key: string, title: string, texts: ProfileTexts, extra: Record<string, unknown>, client?: string): Promise<ProfileRepresentation> {
    this.assertTexts(texts);
    const version = Number(current.en.metadata.component_version ?? 1) + 1;
    const canonicalHash = hash(texts.machine_en);
    const shared = { component_key: key, component_version: version, canonical_hash: canonicalHash, ...extra };
    const en = await this.memory.update(current.en.metadata.id, { title, content: texts.machine_en, metadata: { ...shared, representation: 'en', translation_version: version } }, current.en.revision, client);
    const cs = await this.memory.update(current.cs.metadata.id, { title, content: texts.human_cs, metadata: { ...shared, representation: 'cs', translation_version: version } }, current.cs.revision, client);
    return toRepresentation(en, cs);
  }
  private policy(identity: Entity): LanguagePolicy {
    return {
      user_language: String(identity.metadata.user_language ?? 'cs'),
      internal_language: String(identity.metadata.internal_language ?? 'en'),
      agent_language: String(identity.metadata.agent_language ?? 'en'),
    };
  }
  private profileVersion(identity: Entity, soul: Entity, roles: Array<{ en: Entity }>): number {
    return Math.max(Number(identity.metadata.component_version ?? 1), Number(soul.metadata.component_version ?? 1), ...roles.map(r => Number(r.en.metadata.component_version ?? 1)));
  }
  private assertAgentId(value: unknown): void {
    if (!ID.test(String(value))) throw new MemoryError('VALIDATION_ERROR', 'agent_id must be lowercase ASCII, 2–64 characters, and use only letters, digits, _ or -');
  }
  private assertRoleId(value: unknown): void {
    if (!ID.test(String(value))) throw new MemoryError('VALIDATION_ERROR', 'role_id must be lowercase ASCII, 2–64 characters, and use only letters, digits, _ or -');
  }
  private assertTexts(value: unknown): void {
    const texts = value as ProfileTexts;
    if (!texts.machine_en?.trim() || !texts.human_cs?.trim())
      throw new MemoryError('VALIDATION_ERROR', 'Both machine_en and human_cs are required; MCP does not invent translations.');
  }
  private assertPolicy(value: unknown): void {
    for (const [key, language] of Object.entries(value as LanguagePolicy))
      if (!LANG.test(String(language))) throw new MemoryError('VALIDATION_ERROR', `Invalid ${key}: ${String(language)}`);
  }
  private texts(input: ProfileTexts): ProfileTexts { return { machine_en: input.machine_en, human_cs: input.human_cs }; }
}

function toRepresentation(en: Entity, cs: Entity): ProfileRepresentation {
  return {
    id: en.metadata.id, title: en.metadata.title, machine_en: en.content, human_cs: cs.content,
    component_version: Number(en.metadata.component_version), canonical_hash: String(en.metadata.canonical_hash),
    revision: en.revision, translation_revision: cs.revision,
  };
}
function compactContext(identity: Entity, soul: Entity, role: Entity, language: LanguagePolicy, roleId: string): string {
  return [
    `AGENT IDENTITY\n${identity.content.trim()}`,
    `SOUL\n${soul.content.trim()}`,
    `ACTIVE ROLE (${roleId})\n${role.content.trim()}`,
    `LANGUAGE POLICY\nUser communication: ${language.user_language}\nMachine-facing instructions: ${language.internal_language}\nAgent-to-agent messages: ${language.agent_language}`,
  ].join('\n\n');
}