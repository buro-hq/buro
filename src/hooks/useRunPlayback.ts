import { skipInactiveTime } from '../../protocol/timing.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { duration, isTerminal, type Run } from '../model';
export function useRunPlayback(run?: Run) {
  const [position, setPosition] = useState(() =>
      run ? (run.goalId ? duration(run) : Math.min(100, duration(run))) : 0,
    ),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState('8');
  const previousRun = useRef(run?.id),
    liveRun = useRef<string | null>(null);
  const end = run ? duration(run) : 0,
    cursor = Math.min(position, end),
    complete = !!run && isTerminal(run) && cursor >= end - 0.05;
  useEffect(() => {
    if (!playing || !run) return;
    const timer = setInterval(
      () =>
        setPosition((value) => {
          const next = Math.min(end, skipInactiveTime(run, value + Number(speed) / 10));
          if (next >= end) setPlaying(false);
          return next;
        }),
      100,
    );
    return () => clearInterval(timer);
  }, [playing, speed, end, run?.id]);
  useEffect(() => {
    if (!run) return;
    if (previousRun.current !== run.id) {
      previousRun.current = run.id;
      setPosition(duration(run));
      setPlaying(false);
    }
    if (!isTerminal(run)) {
      liveRun.current = run.id;
      setPosition(duration(run));
      const timer = setInterval(() => setPosition(duration(run)), 1000);
      return () => clearInterval(timer);
    }
    if (liveRun.current === run.id) {
      setPosition(duration(run));
      liveRun.current = null;
    }
  }, [run]);
  const seek = useCallback(
    (time: number) => {
      setPosition(Math.max(0, Math.min(end, time)));
      setPlaying(false);
    },
    [end],
  );
  const play = useCallback(() => {
    if (!run || !isTerminal(run)) return;
    if (complete) setPosition(0);
    setPlaying((value) => !value);
  }, [run, complete]);
  return { cursor, end, complete, playing, speed, setSpeed, seek, play };
}
export type RunPlayback = ReturnType<typeof useRunPlayback>;
