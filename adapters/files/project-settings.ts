import { isDeepStrictEqual } from 'node:util';
import { DomainError } from '../../core/ports.ts';
import {
  createSettingsTransaction,
  validateProjectProfile,
  projectResearchProposal,
  type ProjectSettings,
  type ProjectSettingsChange,
  type SettingsCommand,
} from '../../core/project-settings.ts';
import { commandCopy } from '../state/transaction-values.ts';
import { createDocumentFacet, type DocumentFacetHost } from './document-facet.ts';

/** Settings participate in the sole file authority until the complete SQL cutover. */
export function createDocumentProjectSettings(
  host: DocumentFacetHost<ProjectSettingsChange>,
): ProjectSettings {
  const { projectId, read } = host;
  const facet = createDocumentFacet(host, (doc, access) =>
    createSettingsTransaction({
      projectId,
      assertActive: access.assertActive,
      storage: {
        profile: () => doc.profile,
        verification: () => doc.verification,
        researchProposal: () => (doc.research ? projectResearchProposal(doc.research) : undefined),
        hasActiveRun: () =>
          doc.runs.some(
            (run) =>
              run.status !== undefined && ['queued', 'running', 'canceling'].includes(run.status),
          ),
        replaceProfile: (previous, next) =>
          access.write(() => {
            if (
              !isDeepStrictEqual(
                doc.profile ? validateProjectProfile(doc.profile) : undefined,
                previous,
              )
            )
              throw new DomainError('CONFLICT', 'The profile changed. Refresh before saving.');
            doc.profile = structuredClone(next);
          }),
        acknowledgeResearch: (expected, next) =>
          access.write(() => {
            if (
              !doc.research ||
              !isDeepStrictEqual(projectResearchProposal(doc.research), expected)
            )
              throw new DomainError('RESEARCH_STALE', 'Research changed. Refresh the suggestions.');
            doc.research.reviewedProfileRevision = next.reviewedProfileRevision;
            if (next.appliedProfileRevision !== undefined)
              doc.research.appliedProfileRevision = next.appliedProfileRevision;
          }),
        saveVerification: (value) =>
          access.write(() => {
            doc.verification = structuredClone(value);
          }),
        appendChange: access.appendChange,
      },
    }),
  );
  return Object.freeze({
    projectId,
    transaction: facet.transaction,
    profile: () => facet.query((tx) => tx.profile()),
    verification: () => facet.query((tx) => tx.verification()),
    researchProposal: () => facet.query((tx) => tx.researchProposal()),
    hasActiveRun: () => facet.query((tx) => tx.hasActiveRun()),
    receipt(command: SettingsCommand) {
      const captured = commandCopy(command);
      return read((doc) => {
        const found = Object.hasOwn(doc.receipts, captured.id)
          ? doc.receipts[captured.id]
          : undefined;
        if (found && found.fingerprint !== captured.fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'This ID was used for another command.');
        return found ? { result: structuredClone(found.result) } : undefined;
      });
    },
  });
}
