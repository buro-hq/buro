import { t } from '../../i18n/index.ts';
import { activeDuration, wallTimeAtActive } from '../../../protocol/timing.ts';
import { ActionIcon, Button, Select, Slider, Tooltip } from '@mantine/core';
import { ChevronsRight, History, Pause, Play, SkipBack } from 'lucide-react';
import { useState } from 'react';
import { useProject } from '../../data/provider';
import type { RunPlayback } from '../../hooks/useRunPlayback';
import { clock, isTerminal, phase, type Run } from '../../model';
import { Notice } from '../atoms/Notice';
export function RunPlayer({ run, playback }: { run: Run; playback: RunPlayback }) {
  const { client, snapshot } = useProject();
  const [error, setError] = useState(''),
    [canceling, setCanceling] = useState(false);
  const { cursor, end, complete, playing, speed, setSpeed, seek, play } = playback;
  const activeEnd = activeDuration(run),
    activeCursor = activeDuration(run, cursor);
  async function cancel() {
    setError('');
    setCanceling(true);
    try {
      await client!.command({
        method: 'run.cancel',
        params: { projectId: snapshot!.project.id, runId: run.id },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCanceling(false);
    }
  }
  if (!isTerminal(run))
    return (
      <div className="player live-player">
        <span className="tiny-dot working" />
        {t('Live ·')} {phase(run, cursor)}
        <span className="mono" title={t('Active execution time excludes pauses between attempts')}>
          {clock(activeEnd)}
        </span>
        <Button
          size="xs"
          variant="light"
          color="orange"
          loading={canceling}
          disabled={run.status === 'canceling'}
          onClick={() => void cancel()}
        >
          {run.status === 'canceling' ? t('Stopping…') : t('Stop')}
        </Button>
        {error && <Notice tone="error">{t(error)}</Notice>}
      </div>
    );
  return (
    <div className="player">
      <div className="player-top">
        <span className="replay-label">
          <History size={13} />
          {t('REPLAY')}
          <span className="player-paused">{playing ? t('playing') : t('paused')}</span>
        </span>
        <span
          className="mono player-counter"
          title={t('Excludes pauses between attempts. Wall time: {p0}', { p0: clock(end) })}
        >
          {clock(activeCursor)}
          <span> / {clock(activeEnd)}</span>
        </span>
      </div>
      <Slider
        thumbLabel={t('Recording position')}
        value={activeCursor}
        onChange={(time) => seek(wallTimeAtActive(run, time))}
        min={0}
        max={Math.max(0.1, activeEnd)}
        step={0.1}
        label={clock}
        size={3}
        thumbSize={10}
        color="sage"
      />
      <div className="player-bottom">
        <div className="player-buttons">
          <Tooltip label={t('Beginning')}>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => seek(0)}
              aria-label={t('Go to recording start')}
            >
              <SkipBack size={15} />
            </ActionIcon>
          </Tooltip>
          <Button
            className="play-button"
            variant="subtle"
            color="gray"
            leftSection={playing ? <Pause size={14} /> : <Play size={14} />}
            onClick={play}
            aria-label={playing ? t('Pause recording') : t('Play recording')}
          >
            {playing ? t('Pause') : complete ? t('Watch from start') : t('Continue')}
          </Button>
          <Select
            aria-label={t('Playback speed')}
            data={['1', '4', '8', '16', '32'].map((value) => ({ value, label: value + '×' }))}
            value={speed}
            onChange={(value) => setSpeed(value || '8')}
            size="xs"
            allowDeselect={false}
            className="speed-select"
          />
        </div>
        <button className="text-button" onClick={() => seek(end)}>
          {t('Full result')}
          <ChevronsRight size={15} />
        </button>
        <span className="player-hint">{t('Space — pause')}</span>
      </div>
    </div>
  );
}
