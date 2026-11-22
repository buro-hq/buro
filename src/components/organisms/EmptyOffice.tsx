import { roleLabels } from '../../ui/role-labels';
import { t } from '../../i18n/index.ts';
import { Button, Group } from '@mantine/core';
import { ArrowRight, Network, Plus, ShieldCheck, Users } from 'lucide-react';
import { useProject } from '../../data/provider';
import type { ProjectPage } from '../templates/ProjectLayout';
import { useResourceCatalog } from '../../features/resources/useResourceCatalog';
import { operationResourceReady } from '../../features/resources/readiness';
export function EmptyOffice({
  onNewGoal: setForm,
  onNavigate: setPage,
}: {
  onNewGoal: () => void;
  onNavigate: (page: ProjectPage) => void;
}) {
  const { snapshot } = useProject();
  const resources = useResourceCatalog(snapshot?.project.id);
  if (!snapshot) return null;
  const needsModels =
    resources.supported &&
    !!resources.catalog &&
    !['goal.coordination', 'goal.implementation', 'goal.review'].every((operation) =>
      operationResourceReady(resources.catalog, operation),
    );
  const needsChecks = !snapshot.executionPolicy?.defaultCheckIds.length;
  return (
    <>
      <div className="office-heading">
        <div>
          <h2>{t('Project office')}</h2>
          <p>{t('The team will join when the first goal starts.')}</p>
        </div>
        <span className="office-presence">
          <span className="tiny-dot waiting" />
          {t('No active sessions')}
        </span>
      </div>
      <div className="office-canvas empty-office-canvas">
        <div className="office-grid" />
        <div className="room-label">
          <span className="room-square" />
          {snapshot.project.name.toUpperCase()}
          <span>AGENT WORKSPACE</span>
        </div>
        <div className="empty-office-content">
          <span className="empty-office-icon">
            <Network size={34} />
          </span>
          <h3>
            {needsModels || needsChecks
              ? t('Prepare your first goal')
              : t('The office is ready for its first goal')}
          </h3>
          <p>
            {needsModels
              ? t(
                  'Configure and select a model profile before starting work. You can already save goals and materials.',
                )
              : needsChecks
                ? t('Add an acceptance check so the service can verify the team’s result.')
                : t(
                    'Describe what needs to be done. The coordinator will plan the work and select a team.',
                  )}
          </p>
          <Group justify="center">
            {(needsModels || needsChecks) && (
              <Button onClick={() => setPage(needsModels ? 'preferences' : 'settings')}>
                {needsModels ? t('Configure models') : t('Configure checks')}
              </Button>
            )}
            <Button variant="light" leftSection={<Plus size={14} />} onClick={() => setForm()}>
              {t('Describe the first goal')}
            </Button>
          </Group>
        </div>
        <div className="office-room-footer">
          <Users size={13} />
          {t('Desks will appear after a goal starts')}
        </div>
      </div>
      <div className="office-feed">
        <div className="section-heading">
          <h3>{t('Office activity')}</h3>
          <button className="text-button" onClick={() => setPage('goals')}>
            {t('Go to goals')} <ArrowRight size={14} />
          </button>
        </div>
        <p className="empty">{t('No events yet. Team activity will appear here.')}</p>
      </div>
    </>
  );
}
export function EmptyOfficeRail({
  onNavigate: setPage,
}: {
  onNavigate: (page: ProjectPage) => void;
}) {
  const { snapshot } = useProject();
  if (!snapshot) return null;
  return (
    <aside className="right-rail">
      <div className="rail-section">
        <div className="section-heading">
          <h3>{t('Project team')}</h3>
          <span className="count-badge">{snapshot.roles.length}</span>
        </div>
        <p className="caption">{t('Saved roles. No sessions have been created yet.')}</p>
        <div className="rail-agents">
          {snapshot.roles.map((role) => (
            <button
              key={role.id}
              className="rail-agent state-waiting"
              onClick={() => setPage('team')}
            >
              <div className="agent-card-head">
                <span className="agent-avatar">
                  {role.kind === 'review' ? (
                    <ShieldCheck size={21} />
                  ) : role.kind === 'coordination' ? (
                    <Network size={21} />
                  ) : (
                    <Users size={21} />
                  )}
                </span>
                <span className="agent-name">
                  <b>{roleLabels(role).title}</b>
                  <small>{role.id}</small>
                </span>
              </div>
              <span className="rail-agent-state">{t('Catalog role')}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="rail-section">
        <h3>{t('Project ready')}</h3>
        <div className="metric-row">
          <span>{t('Goals')}</span>
          <b>{snapshot.goals.length}</b>
        </div>
        <div className="metric-row">
          <span>{t('Runs')}</span>
          <b>0</b>
        </div>
        <div className="metric-row">
          <span>{t('Active sessions')}</span>
          <b>0</b>
        </div>
      </div>
      {snapshot.profile && (
        <div className="rail-section">
          <h3>{t('Environment')}</h3>
          <p className="caption">
            {snapshot.verification
              ? t('Latest check: {p0}/{p1}', {
                  p0: snapshot.verification.passed,
                  p1: snapshot.verification.total,
                })
              : t('Configure commands and verify the environment before the first goal.')}
          </p>
          <button className="text-button" onClick={() => setPage('settings')}>
            {t('Open settings')} <ArrowRight size={13} />
          </button>
        </div>
      )}
    </aside>
  );
}
