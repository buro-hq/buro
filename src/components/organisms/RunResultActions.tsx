import { t } from '../../i18n/index.ts';
import { Button } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { Run, RunPreview } from '../../../protocol/domain';
import type { ClientCommand } from '../../../protocol/schema';
import { useProject } from '../../data/provider';
import { Notice } from '../atoms/Notice';
import { getCheckViewState } from '../../features/runs/check-state.ts';
import { wallDuration } from '../../../protocol/timing.ts';

const deliveryLabels = {
  get pending() {
    return t('Preparing');
  },
  get running() {
    return t('Running');
  },
  get 'needs-attention'() {
    return t('Configuration needed');
  },
  get 'awaiting-confirmation'() {
    return t('Awaiting confirmation');
  },
  get completed() {
    return t('Completed');
  },
  get failed() {
    return t('Failed');
  },
  get interrupted() {
    return t('Interrupted');
  },
};
export function RunResultActions({ run }: { run: Run }) {
  const { snapshot, client, connection } = useProject();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [livePreview, setLivePreview] = useState<RunPreview | null>(null);
  useEffect(() => {
    setLivePreview(null);
    if (
      !snapshot?.capabilities.includes('run.preview.status') ||
      !['starting', 'running'].includes(run.preview?.status || '')
    )
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await client!.command<RunPreview | null>({
          method: 'run.preview.status',
          params: { projectId: snapshot!.project.id, runId: run.id },
        });
        if (!stopped) setLivePreview(value);
      } catch {
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 1500);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [run.id, run.preview?.status, client, snapshot?.project.id]);
  if (run.status !== 'completed' || !run.commit || !snapshot?.capabilities.includes('run.deliver'))
    return null;
  const components = snapshot.profile?.components || [],
    delivery = run.delivery;
  const outcome = run.outcome?.kind || 'pull-request';
  const preview = ['starting', 'running'].includes(run.preview?.status || '')
    ? livePreview && Date.parse(livePreview.updatedAt) >= Date.parse(run.preview!.updatedAt)
      ? livePreview
      : run.preview
    : run.preview;
  async function command(command: ClientCommand) {
    setBusy(true);
    setError('');
    try {
      await client!.command(command);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function configurePreview() {
    if (!snapshot?.research || !snapshot.profile) return;
    setBusy(true);
    setError('');
    try {
      await client!.command({
        method: 'project.research.apply',
        params: {
          projectId: snapshot.project.id,
          researchId: snapshot.research.id,
          expectedRevision: snapshot.profile.revision,
        },
      });
      await client!.command({
        method: 'run.preview.start',
        params: { projectId: snapshot.project.id, runId: run.id },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || connection !== 'connected';
  return (
    <div className="result-operations">
      <h3>{t('Inspect and verify the result')}</h3>
      <p className="caption">
        {getCheckViewState(run, wallDuration(run)).implementationReady
          ? t('Implementation is ready. Preview and delivery do not change its acceptance status.')
          : t('Acceptance evidence is incomplete. Inspect checks and review.')}
      </p>
      {!!run.resultAgents?.length && (
        <div className="team-grid">
          {run.resultAgents.map((agent) => (
            <div className="team-role" key={agent.threadId}>
              <h3>{snapshot.roles.find((r) => r.id === agent.name)?.title || agent.name}</h3>
              <p>
                {agent.status === 'running'
                  ? t('Working')
                  : agent.status === 'completed'
                    ? t('Preparation completed')
                    : t('Preparation failed')}
              </p>
              {agent.messages.map((message, i) => (
                <p className="caption" key={i}>
                  {message}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
      {!components.length && (
        <div className="source-notice">
          {snapshot.research?.status === 'ready' &&
          snapshot.research.components?.some((c) => c.command.trim()) &&
          snapshot.capabilities.includes('project.research.apply') ? (
            <>
              <p>
                {t(
                  'Research found a local launch method. Save it to settings and open this goal result.',
                )}
              </p>
              <Button loading={busy} disabled={disabled} onClick={() => void configurePreview()}>
                {t('Configure and launch locally')}
              </Button>
            </>
          ) : (
            <p>
              {t(
                'Local preview is not configured yet. Research the project or add components in settings.',
              )}
            </p>
          )}
        </div>
      )}
      {components.map((c) => (
        <div className="setting-row" key={c.id}>
          <div>
            <b>
              {c.name} · {c.kind}
            </b>
            <p>{c.instructions || t('Verification instructions are not set yet')}</p>
          </div>
        </div>
      ))}
      <div className="form-actions">
        {components.some((c) => c.command.trim()) && (
          <Button
            variant="light"
            loading={run.preview?.status === 'starting'}
            disabled={
              disabled ||
              run.preview?.status === 'starting' ||
              (run.preview?.status === 'running' &&
                !snapshot.capabilities.includes('run.preview.restart'))
            }
            onClick={() =>
              void command({
                method:
                  run.preview?.status === 'running' ? 'run.preview.restart' : 'run.preview.start',
                params: { projectId: snapshot.project.id, runId: run.id },
              })
            }
          >
            {run.preview?.status === 'running' ? t('Restart locally') : t('Launch locally')}
          </Button>
        )}
        {['starting', 'running'].includes(run.preview?.status || '') && (
          <Button
            variant="default"
            disabled={disabled}
            onClick={() =>
              void command({
                method: 'run.preview.stop',
                params: { projectId: snapshot.project.id, runId: run.id },
              })
            }
          >
            {t('Stop local preview')}
          </Button>
        )}
      </div>
      {preview && (
        <>
          <p className="caption">
            {t('Local preview:')}{' '}
            {
              {
                starting: t('Preparing'),
                running: t('Working'),
                stopped: t('Stopped'),
                failed: t('Failed'),
              }[preview.status]
            }
          </p>
          {preview.error && <Notice tone="error">{preview.error}</Notice>}
          {preview.components.map((c) => (
            <div key={c.id}>
              {c.envFiles && (
                <p className="caption">
                  {t('Env files:')} {c.envFiles.length ? c.envFiles.join(' → ') : t('not found')}
                  {t('. Restart to apply changes.')}
                </p>
              )}
              {c.url && preview.status === 'running' && !busy && (
                <Button component="a" href={c.url} target="_blank" rel="noreferrer" variant="light">
                  {t('Open')} {c.name}
                </Button>
              )}
              <details>
                <summary>
                  {c.name} {t('· logs')}
                </summary>
                <pre className="terminal">{c.output || t('No output yet')}</pre>
              </details>
            </div>
          ))}
        </>
      )}
      {outcome !== 'local' && (
        <div className="delivery-result">
          <h3>{outcome === 'deploy' ? t('Environment delivery') : 'Draft PR'}</h3>
          <p className="caption">
            {delivery ? deliveryLabels[delivery.status] : t('Not prepared yet')} {t('· commit')}{' '}
            {run.commit.slice(0, 8)}
          </p>
          {delivery && <p>{delivery.summary}</p>}
          {delivery?.config && outcome === 'deploy' && (
            <p className="caption">
              {t('Environment:')}{' '}
              {delivery.config.environments.find((e) => e.id === delivery.environmentId)?.name ||
                delivery.environmentId}
            </p>
          )}
          {delivery?.status === 'awaiting-confirmation' && (
            <pre className="terminal">
              {delivery.config?.environments.find((e) => e.id === delivery.environmentId)?.command}
            </pre>
          )}
          {delivery?.branch && (
            <p className="source-path">
              {t('Branch:')} {delivery.branch}
            </p>
          )}
          {delivery?.url && (
            <Button component="a" href={delivery.url} target="_blank" rel="noreferrer">
              {outcome === 'deploy' ? t('Open delivery result') : t('Open PR')}
            </Button>
          )}
          {delivery?.output && (
            <details>
              <summary>{t('Delivery output')}</summary>
              <pre className="terminal">{delivery.output}</pre>
            </details>
          )}
          {delivery?.status !== 'completed' && (
            <Button
              variant={delivery?.status === 'awaiting-confirmation' ? 'filled' : 'light'}
              disabled={disabled || ['running', 'pending'].includes(delivery?.status || '')}
              onClick={() =>
                void command({
                  method: 'run.deliver',
                  params: {
                    projectId: snapshot.project.id,
                    runId: run.id,
                    expectedCommit: run.commit!,
                    confirmed: delivery?.status === 'awaiting-confirmation',
                  },
                })
              }
            >
              {delivery?.status === 'awaiting-confirmation'
                ? t('Confirm delivery of this commit')
                : outcome === 'deploy'
                  ? t('Prepare delivery')
                  : t('Prepare draft PR')}
            </Button>
          )}
          {outcome === 'deploy' &&
            delivery?.status === 'completed' &&
            snapshot.capabilities.includes('run.redeploy') && (
              <Button
                variant="light"
                disabled={disabled}
                onClick={() =>
                  void command({
                    method: 'run.deliver',
                    params: {
                      projectId: snapshot.project.id,
                      runId: run.id,
                      expectedCommit: run.commit!,
                      confirmed: false,
                      redeploy: true,
                    },
                  })
                }
              >
                {t('Repeat delivery')}
              </Button>
            )}
          {!!run.deliveryHistory?.length && (
            <details>
              <summary>
                {t('Delivery history ·')} {run.deliveryHistory.length}
              </summary>
              {run.deliveryHistory.map((attempt, index) => (
                <div className="setting-row" key={index}>
                  <div>
                    <b>
                      {deliveryLabels[attempt.status]} · {attempt.commit.slice(0, 8)}
                    </b>
                    <p>
                      {new Date(attempt.updatedAt).toLocaleString()} · {attempt.environmentId}
                    </p>
                    {attempt.url && (
                      <a href={attempt.url} target="_blank" rel="noreferrer">
                        {t('Open previous result')}
                      </a>
                    )}
                    <p>{attempt.summary}</p>
                  </div>
                </div>
              ))}
            </details>
          )}
          {delivery?.status === 'interrupted' && (
            <Notice>
              {t(
                'Check the external environment before retrying. A service restart never automatically repeats delivery.',
              )}
            </Notice>
          )}
        </div>
      )}
      {error && <Notice tone="error">{t(error)}</Notice>}
    </div>
  );
}
