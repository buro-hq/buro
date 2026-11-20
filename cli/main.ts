import { runPerformance } from '../protocol/performance.ts';
import { readFile } from 'node:fs/promises';
import type { Project, ProjectProfile, RepositoryInfo } from '../protocol/domain.ts';
import { ProjectProfileSchema } from '../protocol/projects.ts';
import { SocketProjectClient } from '../clients/socket-client.ts';
const [command = 'status', ...args] = process.argv.slice(2);
const client = new SocketProjectClient(
  process.env.PROJECT_DAEMON_URL || 'ws://127.0.0.1:4341',
  process.env.PROJECT_ID || 'codex-panel',
);
try {
  const state = await Promise.race([
    client.connect(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(Error('Daemon unavailable. Run npm run daemon.')), 4000).unref(),
    ),
  ]);
  if (command === 'status')
    console.log(
      JSON.stringify(
        {
          project: state.project,
          goals: state.goals.length,
          roles: state.roles.map((r) => ({ id: r.id, version: r.version })),
          runs: state.runs.length,
          sequence: state.sequence,
          capabilities: state.capabilities,
        },
        null,
        2,
      ),
    );
  else if (command === 'resources') {
    const subcommand = args[0] || 'list';
    let result: unknown;
    if (subcommand === 'list')
      result = await client.command({
        method: 'resources.list',
        params: { projectId: state.project.id },
      });
    else if (subcommand === 'init')
      result = await client.command({ method: 'resources.init', params: {} });
    else if (subcommand === 'models' && args[1])
      result = await client.command({
        method: 'resources.models',
        params: { connectionId: args[1] },
      });
    else if (subcommand === 'probe' && args[1])
      result = await client.command({ method: 'resources.probe', params: { runtimeId: args[1] } });
    else if (subcommand === 'use' && args[1])
      result = await client.command({ method: 'resources.use', params: { profileId: args[1] } });
    else throw Error('Use resources list|init|models CONNECTION|probe RUNTIME|use PROFILE.');
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'projects')
    console.log(
      JSON.stringify(await client.command({ method: 'project.list', params: {} }), null, 2),
    );
  else if (command === 'project' && args[0] === 'research')
    console.log(
      JSON.stringify(
        await client.command({
          method:
            args[1] === 'status'
              ? 'project.research.status'
              : args[1] === 'cancel'
                ? 'project.research.cancel'
                : 'project.research',
          params: { projectId: state.project.id },
        }),
        null,
        2,
      ),
    );
  else if (command === 'run' && args[0] === 'preview' && args[1])
    console.log(
      JSON.stringify(
        await client.command({
          method:
            args[2] === 'stop'
              ? 'run.preview.stop'
              : args[2] === 'restart'
                ? 'run.preview.restart'
                : 'run.preview.start',
          params: { projectId: state.project.id, runId: args[1] },
        }),
        null,
        2,
      ),
    );
  else if (command === 'run' && args[0] === 'deliver' && args[1]) {
    const run = state.runs.find((r) => r.id === args[1]);
    if (!run?.commit) throw Error('No accepted commit.');
    console.log(
      JSON.stringify(
        await client.command({
          method: 'run.deliver',
          params: {
            projectId: state.project.id,
            runId: run.id,
            expectedCommit: run.commit,
            confirmed: args.includes('--confirm'),
            ...(args.includes('--redeploy') ? { redeploy: true } : {}),
          },
        }),
        null,
        2,
      ),
    );
  } else if (command === 'project' && args[0] === 'inspect' && args[1])
    console.log(
      JSON.stringify(
        await client.command({ method: 'project.inspect', params: { root: args[1] } }),
        null,
        2,
      ),
    );
  else if (command === 'project' && args[0] === 'connect' && args[1]) {
    const info = await client.command<RepositoryInfo>({
      method: 'project.inspect',
      params: { root: args[1] },
    });
    let profile = info.profile,
      name = info.name;
    if (args[2]) {
      const data = JSON.parse(await readFile(args[2], 'utf8'));
      profile = ProjectProfileSchema.parse(data.profile || data);
      name = data.name || name;
    }
    const project = await client.command<Project>({
      method: 'project.connect',
      params: { root: info.root, name, profile, ignoreLocal: true },
    });
    console.log(JSON.stringify(project, null, 2));
  } else if (command === 'project' && ['storage', 'gc'].includes(args[0]))
    console.log(
      JSON.stringify(
        await client.command({
          method: args[0] === 'gc' ? 'project.storage.gc' : 'project.storage',
          params: { projectId: state.project.id },
        }),
        null,
        2,
      ),
    );
  else if (command === 'project' && args[0] === 'info')
    console.log(
      JSON.stringify(
        await client.command({ method: 'project.info', params: { projectId: state.project.id } }),
        null,
        2,
      ),
    );
  else if (command === 'project' && args[0] === 'configure' && args[1]) {
    const data = JSON.parse(await readFile(args[1], 'utf8'));
    if (!state.profile) throw Error('The project has no user profile.');
    console.log(
      JSON.stringify(
        await client.command({
          method: 'project.configure',
          params: {
            projectId: state.project.id,
            profile: ProjectProfileSchema.parse(data.profile || data),
            expectedRevision: state.profile.revision,
          },
        }),
        null,
        2,
      ),
    );
  } else if (command === 'project' && args[0] === 'verify') {
    const checkIds = args[1]?.split(',') || state.profile?.defaultCheckIds || [];
    if (!checkIds.length) throw Error('Configure or select at least one check.');
    console.log(
      JSON.stringify(
        await client.command({
          method: 'project.verify',
          params: { projectId: state.project.id, checkIds },
        }),
        null,
        2,
      ),
    );
  } else if (command === 'run' && args[0] === 'apply' && args[1]) {
    const info = await client.command<RepositoryInfo>({
      method: 'project.info',
      params: { projectId: state.project.id },
    });
    console.log(
      JSON.stringify(
        await client.command({
          method: 'run.apply',
          params: {
            projectId: state.project.id,
            runId: args[1],
            expectedBranch: info.branch,
            expectedHead: info.head,
          },
        }),
        null,
        2,
      ),
    );
  } else if (command === 'goals') console.log(JSON.stringify(state.goals, null, 2));
  else if (command === 'roles') console.log(JSON.stringify(state.roles, null, 2));
  else if (command === 'runs')
    console.log(
      JSON.stringify(
        state.runs.map(({ id, title, status, phase, workspace, commit }) => ({
          id,
          title,
          status,
          phase,
          workspace,
          commit,
        })),
        null,
        2,
      ),
    );
  else if (command === 'run' && args[0] === 'resume' && args[1])
    console.log(
      JSON.stringify(
        await client.command({
          method: 'run.resume',
          params: {
            projectId: state.project.id,
            runId: args[1],
            mode: args[2] === 'recheck' ? 'recheck' : 'repair',
            instructions: args[3] || '',
            useCurrentProfile: args.includes('--current-profile'),
          },
        }),
        null,
        2,
      ),
    );
  else if (command === 'run' && args[0] === 'start' && args[1])
    console.log(
      JSON.stringify(
        await client.command({
          method: 'run.start',
          params: {
            projectId: state.project.id,
            goalId: args[1],
            ...(args[2] ? { checkIds: args[2].split(',') } : {}),
          },
        }),
        null,
        2,
      ),
    );
  else if (command === 'run' && args[0] === 'cancel' && args[1])
    console.log(
      JSON.stringify(
        await client.command({
          method: 'run.cancel',
          params: { projectId: state.project.id, runId: args[1] },
        }),
        null,
        2,
      ),
    );
  else if (command === 'run' && args[0] === 'watch' && args[1]) {
    const runId = args[1];
    if (!state.runs.some((r) => r.id === runId)) throw Error('Run not found.');
    await new Promise<void>((resolve) => {
      let seen = 0,
        off = () => {};
      const stop = () => {
        off();
        process.removeListener('SIGINT', stop);
        resolve();
      };
      const show = (snapshot: typeof state) => {
        const run = snapshot.runs.find((r) => r.id === runId);
        if (!run) return;
        for (const event of run.events.slice(seen)) {
          const elapsed = Math.max(
            0,
            Math.floor((Date.parse(event.at) - Date.parse(run.createdAt)) / 1000),
          );
          const actor =
            run.agents.find((a) => a.threadId === event.threadId)?.name || 'coordinator';
          console.log(
            `[+${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}] ${event.type} ${actor}: ${(event.text || '').split('\n')[0].slice(0, 240)}`,
          );
        }
        seen = run.events.length;
        if (
          !run.status ||
          ['completed', 'failed', 'interrupted', 'needs-attention'].includes(run.status)
        )
          stop();
      };
      off = client.onChange(show);
      process.once('SIGINT', stop);
      show(state);
    });
  } else if (command === 'run' && args[0] === 'timings' && args[1]) {
    const run = state.runs.find((r) => r.id === args[1]);
    if (!run) throw Error('Run not found.');
    console.log(JSON.stringify(runPerformance(run), null, 2));
  } else if (command === 'run' && args[0] === 'show' && args[1])
    console.log(
      JSON.stringify(
        state.runs.find((r) => r.id === args[1]),
        null,
        2,
      ),
    );
  else if (command === 'goal' && args[0] === 'create' && args[1] && args[2]) {
    const [title, body, criteria = ''] = args.slice(1).filter((value) => !value.startsWith('--'));
    const parentRunId = args.find((a) => a.startsWith('--parent='))?.slice(9);
    const result = args.find((a) => a.startsWith('--result='))?.slice(9) || 'pr';
    if (!['local', 'pr'].includes(result) && !result.startsWith('deploy:'))
      throw Error('--result: local, pr or deploy:environment-id');
    console.log(
      JSON.stringify(
        await client.createGoal({
          projectId: state.project.id,
          title,
          body,
          criteria,
          ...(parentRunId ? { parentRunId } : {}),
          outcome: result.startsWith('deploy:')
            ? { kind: 'deploy', environmentId: result.slice(7) }
            : { kind: result === 'local' ? 'local' : 'pull-request' },
          ...(args.includes('--repair-environment') ? { repairEnvironment: true } : {}),
        }),
        null,
        2,
      ),
    );
  } else
    throw Error(
      'Commands: status | resources list/init/models <connection>/probe <runtime>/use <profile> | projects | project inspect/connect <path> [profile.json] | project research [status|cancel] | project info/configure <profile.json>/verify [checks] | run apply <runId> | run preview <runId> [stop|restart] | run deliver <runId> [--confirm] [--redeploy] | goals | roles | runs | goal create <title> <body> [criteria] [--repair-environment] [--parent=R-ID] [--result=pr|local|deploy:environment] | run start <goalId> [check1,check2] | run cancel/show/watch/timings <runId>',
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  client.close();
}
