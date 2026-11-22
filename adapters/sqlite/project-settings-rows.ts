import type { SQLInputValue } from 'node:sqlite';
import { DomainError } from '../../core/ports.ts';
import {
  validateProjectProfile,
  validateProjectVerification,
  validateResearchProposal,
  validateResearchAcknowledgement,
  type SettingsTransactionStorage,
  type ProjectSettingsChange,
} from '../../core/project-settings.ts';

export const projectSettingsSchema = `
  CREATE TABLE IF NOT EXISTS project_profiles (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1) REFERENCES authority_metadata(singleton),
    revision INTEGER NOT NULL CHECK(revision>=0),
    profile_json TEXT NOT NULL CHECK(json_valid(profile_json))
  );
  CREATE TABLE IF NOT EXISTS project_verifications (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1) REFERENCES authority_metadata(singleton),
    verification_json TEXT NOT NULL CHECK(json_valid(verification_json))
  );
  CREATE TABLE IF NOT EXISTS project_research_proposals (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1) REFERENCES authority_metadata(singleton),
    proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
    ack_json TEXT CHECK(ack_json IS NULL OR json_valid(ack_json))
  );
  CREATE INDEX IF NOT EXISTS project_runs_active ON project_run_index(run_id)
    WHERE status IN ('queued','running','canceling');
`;
type Row = Record<string, unknown>;
type SettingsDatabase = {
  get(label: string, sql: string, ...values: SQLInputValue[]): Row | undefined;
  run(label: string, sql: string, ...values: SQLInputValue[]): { changes: number | bigint };
  json(value: unknown): string;
  mutate<T>(action: () => T): T;
  appendChange(change: ProjectSettingsChange): void;
};
const conflict = () =>
  new DomainError('CONFLICT', 'Project settings changed. Refresh before saving.');
const invalidResearch = () =>
  new DomainError(
    'INVALID_RESEARCH_PROPOSAL',
    'The saved research proposal or acknowledgement is invalid.',
  );

/** Current bounded settings and proposal facts only; no Run, research history or transcript rows. */
export function createSqliteSettingsRows(database: SettingsDatabase): SettingsTransactionStorage {
  const profileRow = () =>
    database.get(
      'profile.read',
      'SELECT revision,profile_json FROM project_profiles WHERE singleton=1',
    );
  const profileFrom = (row: Row) => {
    const value = validateProjectProfile(JSON.parse(String(row.profile_json)));
    if (value.revision !== row.revision) throw conflict();
    return value;
  };
  const proposalRow = () =>
    database.get(
      'research-proposal.read',
      'SELECT proposal_json,ack_json FROM project_research_proposals WHERE singleton=1',
    );
  const proposalFrom = (row: Row) => {
    const body = validateResearchProposal(JSON.parse(String(row.proposal_json)));
    if (body.reviewedProfileRevision !== undefined || body.appliedProfileRevision !== undefined)
      throw invalidResearch();
    if (row.ack_json === null) return body;
    const ack = validateResearchAcknowledgement(JSON.parse(String(row.ack_json)));
    if (ack.id !== body.id) throw invalidResearch();
    return validateResearchProposal({
      ...body,
      reviewedProfileRevision: ack.reviewedProfileRevision,
      ...(ack.appliedProfileRevision !== undefined
        ? { appliedProfileRevision: ack.appliedProfileRevision }
        : {}),
    });
  };
  return {
    profile: () => {
      const row = profileRow();
      return row ? profileFrom(row) : undefined;
    },
    verification: () => {
      const row = database.get(
        'verification.read',
        'SELECT verification_json FROM project_verifications WHERE singleton=1',
      );
      return row
        ? validateProjectVerification(JSON.parse(String(row.verification_json)))
        : undefined;
    },
    researchProposal: () => {
      const row = proposalRow();
      return row ? proposalFrom(row) : undefined;
    },
    hasActiveRun: () =>
      !!database.get(
        'project.active-run',
        "SELECT run_id FROM project_run_index WHERE status IN ('queued','running','canceling') LIMIT 1",
      ),
    replaceProfile: (previous, next) =>
      database.mutate(() => {
        const before = validateProjectProfile(previous);
        const after = validateProjectProfile(next);
        const row = profileRow();
        if (!row || database.json(profileFrom(row)) !== database.json(before)) throw conflict();
        const result = database.run(
          'profile.update',
          'UPDATE project_profiles SET revision=?,profile_json=? WHERE singleton=1 AND revision=? AND profile_json=?',
          after.revision,
          database.json(after),
          before.revision,
          String(row.profile_json),
        );
        if (Number(result.changes) !== 1) throw conflict();
      }),
    acknowledgeResearch: (expected, next) =>
      database.mutate(() => {
        const proposal = validateResearchProposal(expected);
        const ack = validateResearchAcknowledgement(next);
        const row = proposalRow();
        if (
          !row ||
          ack.id !== proposal.id ||
          database.json(proposalFrom(row)) !== database.json(proposal)
        )
          throw new DomainError(
            'RESEARCH_STALE',
            'The research proposal changed before acknowledgement.',
          );
        const result = database.run(
          'research-ack.update',
          'UPDATE project_research_proposals SET ack_json=? WHERE singleton=1 AND proposal_json=? AND ack_json IS ?',
          database.json(ack),
          String(row.proposal_json),
          row.ack_json === null ? null : String(row.ack_json),
        );
        if (Number(result.changes) !== 1)
          throw new DomainError(
            'RESEARCH_STALE',
            'The research proposal changed before acknowledgement.',
          );
      }),
    saveVerification: (value) =>
      database.mutate(() => {
        const verification = validateProjectVerification(value);
        database.run(
          'verification.save',
          'INSERT INTO project_verifications(singleton,verification_json) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET verification_json=excluded.verification_json',
          database.json(verification),
        );
      }),
    appendChange: (change) => database.mutate(() => database.appendChange(change)),
  };
}
