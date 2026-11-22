import { t } from '../../i18n/index.ts';
import { Button, Loader } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { ProjectResearch, RepositoryInfo } from '../../../protocol/domain';
import { useProject } from '../../data/provider';
import { Notice } from '../atoms/Notice';
import { useResourceCatalog } from '../../features/resources/useResourceCatalog';
import { operationResourceReady } from '../../features/resources/readiness';

export function ProjectResearchPanel({
  projectId,
  autoStart = false,
  onReady,
  onApply,
  onAccept,
  disabled = false,
}: {
  projectId?: string;
  autoStart?: boolean;
  onReady?: (research: ProjectResearch) => void;
  onApply?: (research: ProjectResearch) => void;
  onAccept?: (research: ProjectResearch) => Promise<void>;
  disabled?: boolean;
}) {
  const { snapshot, client, connection } = useProject();
  const id = projectId || snapshot!.project.id;
  const resources = useResourceCatalog(id);
  const canResearch = operationResourceReady(resources.catalog, 'project.research');
  const [research, setResearch] = useState<ProjectResearch | null>(null),
    [error, setError] = useState(''),
    [starting, setStarting] = useState(false);
  const [applying, setApplying] = useState(false);
  async function accept() {
    if (!research || !onAccept) return;
    setApplying(true);
    setError('');
    try {
      await onAccept(research);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }
  const [source, setSource] = useState<{ head: string; revision: number } | null>(null);
  useEffect(() => {
    let stopped = false;
    if (research?.status === 'ready')
      void client!
        .command<RepositoryInfo>({ method: 'project.info', params: { projectId: id } })
        .then((info) => {
          if (!stopped) setSource({ head: info.head, revision: info.profile.revision });
        })
        .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [client, id, research?.id, research?.status, snapshot?.profile?.revision]);
  const applied = !!research?.appliedProfileRevision;
  const stale = !!research && !!source && source.head !== research.sourceHead;
  const notified = useRef(''),
    started = useRef(false),
    readyRef = useRef(onReady);
  readyRef.current = onReady;
  async function start() {
    setStarting(true);
    setError('');
    try {
      await client!.command({ method: 'project.research', params: { projectId: id } });
      setResearch(
        await client!.command({ method: 'project.research.status', params: { projectId: id } }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await client!.command<ProjectResearch | null>({
          method: 'project.research.status',
          params: { projectId: id },
        });
        if (!stopped) {
          setResearch(value);
          if (value && value.status !== 'running' && notified.current !== value.id + value.status) {
            notified.current = value.id + value.status;
            readyRef.current?.(value);
          }
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 1500);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, id]);
  useEffect(() => {
    if (autoStart && canResearch && !disabled && !started.current) {
      started.current = true;
      void start();
    }
  }, [autoStart, canResearch, disabled]);
  return (
    <div className="content-panel project-research-panel">
      <div className="section-heading">
        <div>
          <h2>{t('Project research')}</h2>
          <p className="caption">
            {t(
              'An agent reads project files and suggests configuration. It does not modify sources, install dependencies or run migrations.',
            )}
          </p>
        </div>
        {(starting || research?.status === 'running') && (
          <Loader size="sm" aria-label={t('Agent is researching the project')} />
        )}
      </div>
      {error && <Notice tone="error">{t(error)}</Notice>}
      {!canResearch && !resources.loading && (
        <Notice>
          {t(
            'Configure and select an eligible model profile in User settings to start research. Saved research stays available.',
          )}
        </Notice>
      )}
      {research && (
        <>
          <p>{research.summary}</p>
          <details open={research.status === 'running'}>
            <summary>
              {t('Research log ·')} {research.events.length} {t('events')}
            </summary>
            <ol className="setup-events">
              {research.events.map((e, i) => (
                <li key={i}>{e.text}</li>
              ))}
            </ol>
          </details>
          {research.error && <Notice tone="error">{research.error}</Notice>}
          {research.components?.map((c) => (
            <div className="setting-row" key={c.id}>
              <div>
                <b>
                  {c.name} · {c.kind}
                </b>
                <p>
                  {c.path} {c.command && `· ${c.command}`}
                </p>
                <p>{c.evidence}</p>
                <p>{c.instructions}</p>
              </div>
              <span className="micro muted">{applied ? t('Applied') : t('Suggested')}</span>
            </div>
          ))}
          {!!research.questions?.length && (
            <Notice>
              <div>
                <b>{t('What the application needs to run')}</b>
                <ul className="setup-questions">
                  {research.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            </Notice>
          )}
          {research.status === 'ready' && (
            <p className="caption">
              {applied
                ? t(
                    'Settings saved. You can edit them below; local preview is available from a completed goal result.',
                  )
                : t(
                    'Applying adds discovered components and checks. Manually configured commands and boundaries are preserved.',
                  )}
            </p>
          )}
          {applied && (
            <p className="green-text">
              {t('Suggestions applied to profile v')}
              {research.appliedProfileRevision}.
            </p>
          )}
          {!applied && research.reviewedProfileRevision && (
            <p className="green-text">
              {t('Settings saved to profile v')}
              {research.reviewedProfileRevision}
              {t('. You can apply suggestions separately.')}
            </p>
          )}
          {stale && (
            <Notice>
              {t(
                'The repository changed after research. Research again before applying new suggestions. Current settings are preserved.',
              )}
            </Notice>
          )}
        </>
      )}
      <div className="form-actions">
        {research?.status === 'running' ? (
          <Button
            variant="default"
            onClick={() =>
              void client!.command({ method: 'project.research.cancel', params: { projectId: id } })
            }
          >
            {t('Stop research')}
          </Button>
        ) : (
          <Button
            variant="light"
            disabled={disabled || starting || connection !== 'connected' || !canResearch}
            onClick={() => void start()}
          >
            {research ? t('Research again') : t('Research project')}
          </Button>
        )}
        {onApply && research?.status === 'ready' && (
          <Button
            variant="default"
            disabled={disabled || stale || applied || applying}
            onClick={() => onApply(research)}
          >
            {t('Edit before saving')}
          </Button>
        )}
        {onAccept && research?.status === 'ready' && (
          <Button
            loading={applying}
            disabled={disabled || stale || applied || connection !== 'connected'}
            onClick={() => void accept()}
          >
            {applied ? t('Research settings applied') : t('Apply and save')}
          </Button>
        )}
      </div>
    </div>
  );
}
