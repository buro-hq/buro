import { t } from '../../i18n/index.ts';
import { ActionIcon, Badge, Button, Drawer } from '@mantine/core';
import { ArrowRight, ChevronRight, Clipboard, MessageSquare, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import { getRunViewState } from '../../features/runs/view-model';
import {
  agentState,
  at,
  clock,
  eventsAt,
  isTest,
  seconds,
  type Agent,
  type Milestone,
  type RoleView,
  type Run,
} from '../../model';
import { compactKey, localDate, shortCommand, statusLabel } from '../../ui/format';
import { EventIcon as Icon } from '../atoms/EventIcon';
import { RoleIcon } from '../atoms/RoleIcon';
import { RunRecoveryPanel } from './RunRecoveryPanel';

export function RunInspector({
  run,
  cursor,
  roles,
  detail,
  agentDetail,
  onClose,
  onInspect,
  onRepair,
}: {
  run: Run;
  cursor: number;
  roles: Record<string, RoleView>;
  detail: Milestone | null;
  agentDetail: string | null;
  onClose: () => void;
  onInspect: (event: Milestone | null) => void;
  onRepair: (time: number) => void;
}) {
  const { complete } = getRunViewState(run, cursor);
  const repairCommand = detail?.failed
    ? run.commands.find(
        (command) =>
          isTest(command) &&
          command.exitCode === 0 &&
          command.completedAt &&
          Date.parse(command.completedAt) > Date.parse(detail.event.at),
      )
    : undefined;
  const [saved, setSaved] = useState('');
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSaved(t('Copied'));
    } catch {
      setSaved(t('Could not copy'));
    }
  };
  return (
    <Drawer
      opened={!!detail || !!agentDetail}
      onClose={() => {
        onClose();
      }}
      position="right"
      size="lg"
      title={
        <span className="drawer-title">
          {agentDetail ? t('Agent workspace') : t('Event details')}
        </span>
      }
    >
      {saved && (
        <p className="caption" role="status">
          {saved}
        </p>
      )}
      {detail && (
        <div className="detail-content">
          <div className={`detail-kind ${detail.failed ? 'orange-text' : 'green-text'}`}>
            <Icon kind={detail.kind} size={20} />
            {detail.kind === 'test' ? t('CHECK') : detail.event.type}
          </div>
          <h2>{detail.title}</h2>
          <div className="detail-meta">
            <span className="mono">+{clock(at(run, detail.event))}</span>
            <span>
              {localDate(detail.event.at)} {t('MSK')}
            </span>
            <span style={{ color: roles[detail.actor]?.color }}>{detail.actor}</span>
          </div>
          {detail.command ? (
            <>
              <div className="terminal-heading">
                <SquareTerminal size={14} />
                <span>{t('Command')}</span>
                <Badge
                  variant="light"
                  color={detail.command.exitCode ? 'orange' : 'sage'}
                  size="xs"
                >
                  exit {detail.command.exitCode ?? '—'}
                </Badge>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={t('Copy command')}
                  onClick={() => copy(detail.command!.command)}
                >
                  <Clipboard size={14} />
                </ActionIcon>
              </div>
              <pre className="terminal command-terminal">{detail.command.command}</pre>
              <div className="terminal-heading">
                <span>{t('Output')}</span>
              </div>
              <pre className="terminal output-terminal">
                {detail.command.output || t('Output was not saved.')}
              </pre>
            </>
          ) : (
            <pre className="detail-text">{detail.detail}</pre>
          )}
          {detail.failed && <RunRecoveryPanel run={run} />}
          {detail.failed && !run.goalId && repairCommand && (
            <div className="finding-note">
              <MessageSquare size={18} />
              <div>
                <b>{t('Failure is part of the recording')}</b>
                <p>{t('Jump to the next successful test run to inspect the repair.')}</p>
                <Button
                  variant="light"
                  color="orange"
                  size="xs"
                  onClick={() => {
                    onRepair(seconds(run.createdAt, repairCommand.completedAt!));
                    onInspect(null);
                  }}
                >
                  {t('Go to repair')} <ArrowRight size={13} />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {agentDetail &&
        (() => {
          const chosen =
            run.agents.find((a) => a.threadId === agentDetail) ||
            [...run.agents].reverse().find((a) => a.name === agentDetail);
          if (agentDetail !== 'coordinator' && !chosen) return null;
          const agentName = chosen?.name || 'coordinator';
          const a: Agent =
            agentDetail === 'coordinator'
              ? {
                  threadId: run.threadId,
                  name: 'coordinator',
                  agentPath: '/root',
                  startedAt: run.createdAt,
                  completedAt: run.completedAt || '',
                  messages: [],
                  commands: 0,
                  status: 'completed',
                }
              : chosen!;
          const role = roles[agentName];
          const state =
            agentDetail === 'coordinator'
              ? complete
                ? 'done'
                : cursor > 0
                  ? 'working'
                  : 'waiting'
              : agentState(run, a, cursor);
          const commands = run.commands.filter(
            (c) => c.threadId === a.threadId && seconds(run.createdAt, c.startedAt) <= cursor,
          );
          return (
            <div className="detail-content agent-detail">
              <div
                className="agent-detail-heading"
                style={{ '--agent-color': role.color } as React.CSSProperties}
              >
                <span className="team-role-icon">
                  <RoleIcon kind={role.definition?.kind} />
                </span>
                <div>
                  <h2>{role.title}</h2>
                  <span className="mono muted">{a.agentPath}</span>
                </div>
                <Badge color={state === 'working' ? 'sage' : 'gray'} variant="light">
                  {statusLabel[state]}
                </Badge>
              </div>
              <p>{role.description}</p>
              <div className="agent-facts">
                <div>
                  <span>{t('Workspace')}</span>
                  <b className="mono">{role.owns}</b>
                </div>
                <div>
                  <span>Thread ID</span>
                  <button onClick={() => copy(a.threadId)} className="text-button mono">
                    {a.threadId}
                    <Clipboard size={12} />
                  </button>
                </div>
                <div>
                  <span>{t('In goal context')}</span>
                  <b>
                    {compactKey(run.key)} · {run.title}
                  </b>
                </div>
              </div>
              <h3>
                {t('Commands at this point')} <span className="count-badge">{commands.length}</span>
              </h3>
              {commands.map((c) => (
                <button
                  className="agent-command"
                  key={c.id}
                  onClick={() => {
                    const completed =
                      c.completedAt && seconds(run.createdAt, c.completedAt) <= cursor;

                    onInspect({
                      event: {
                        at: completed ? c.completedAt! : c.startedAt,
                        type: completed ? 'command.completed' : 'command.started',
                        threadId: c.threadId,
                      },
                      actor: agentName,
                      kind: 'command',
                      title: shortCommand(c.command),
                      detail: c.command,
                      command: completed
                        ? c
                        : {
                            ...c,
                            output: t('The command is still running at the selected point.'),
                            exitCode: null,
                          },
                    });
                  }}
                >
                  <SquareTerminal size={15} />
                  <span>{shortCommand(c.command)}</span>
                  <span className="mono muted">+{clock(seconds(run.createdAt, c.startedAt))}</span>
                  <ChevronRight size={13} />
                </button>
              ))}
              {commands.length === 0 && (
                <p className="empty">{t('The agent has not started running commands yet.')}</p>
              )}
              <h3>{t('Messages')}</h3>
              {eventsAt(run, cursor)
                .filter((e) => e.threadId === a.threadId && e.type === 'message')
                .map((e, i) => (
                  <div className="agent-message" key={i}>
                    <span className="mono micro">+{clock(at(run, e))}</span>
                    <p>{e.text}</p>
                  </div>
                ))}
            </div>
          );
        })()}
    </Drawer>
  );
}
