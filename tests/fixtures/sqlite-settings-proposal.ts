import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ResearchProposal } from '../../core/project-settings.ts';

/** Fixture-only proposal writer: the future research writer is outside this settings slice. */
export async function seedSettingsProposal(directory: string, proposal: ResearchProposal) {
  if (
    !path.basename(path.dirname(directory)).startsWith('buro-settings-services-') ||
    path.basename(directory) !== 'sqlite' ||
    (await fs.realpath(directory)) !== directory ||
    (await fs.readFile(path.join(directory, '.settings-fixture'), 'utf8')) !== 'synthetic-only'
  )
    throw Error('Proposal SQL is restricted to the marked temporary settings suite.');
  const file = path.join(directory, 'authority.sqlite');
  if ((await fs.realpath(file)) !== file) throw Error('Fixture database cannot be an alias.');
  const db = new DatabaseSync(file);
  try {
    const { reviewedProfileRevision, appliedProfileRevision, ...body } = proposal;
    const ack =
      reviewedProfileRevision === undefined
        ? null
        : JSON.stringify({
            id: proposal.id,
            reviewedProfileRevision,
            ...(appliedProfileRevision === undefined ? {} : { appliedProfileRevision }),
          });
    db.prepare(
      `INSERT INTO project_research_proposals(singleton,proposal_json,ack_json)
      VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET proposal_json=excluded.proposal_json,ack_json=excluded.ack_json`,
    ).run(JSON.stringify(body), ack);
  } finally {
    db.close();
  }
}
