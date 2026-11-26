import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TestContext } from 'node:test';
import { createApplication } from '../../modules/application/create-application.ts';
import type { Application } from '../../modules/application/application.ts';
import type { ModelTransport } from '../../modules/models/model-configuration.ts';

const exec = promisify(execFile);

/** An ordinary application with a temporary repository and a deterministic model transport. */
export interface PresetApplication {
  app: Application;
  directory: string;
  state: string;
  root: string;
  taskId: string;
  modelId: string;
  transport: ModelTransport;
}

/** Keeps preset integration and browser checks independent of host credentials and live models. */
export const presetApplication = async (t: TestContext): Promise<PresetApplication> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buro-preset-flow-'));
  t.after(() => fs.rm(directory, {
    recursive: true,
    force: true,
  }));
  const root = path.join(directory, 'source');
  const state = path.join(directory, 'state');
  await fs.mkdir(root);
  await exec('git', ['init', '-q', root]);
  await fs.writeFile(path.join(root, 'README.md'), 'Initial\n');
  await exec('git', ['add', '.'], {
    cwd: root,
  });
  await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial'], {
    cwd: root,
  });
  const transport: ModelTransport = {
    id: 'fixture',
    create({ configuration }) {
      return {
        id: configuration.id,
        revision: configuration.revision,
        async complete(request) {
          return {
            model: 'fixture',
            finish: 'stop',
            message: {
              role: 'assistant',
              content: request.schema
                ? JSON.stringify({
                    summary: 'Verified',
                    findings: [],
                  })
                : 'Preset launch completed.',
            },
          };
        },
      };
    },
  };
  const app = await createApplication({
    directory: state,
    transports: [transport],
  });
  t.after(() => app.close());
  const model = await app.modelConfigurations.save({
    configuration: { name: 'Preset model', transport: 'fixture', model: 'fixture' },
    default: true,
  });
  await app.settings.update({
    instructions: 'Application instructions',
    review: { enabled: true },
  });
  const project = await app.projects.connect({
    root,
  });
  const task = await app.tasks.create({
    projectId: project.project!.id,
    title: 'Preset goal',
    description: 'Inspect the project',
  });
  return { app, directory, root, state, taskId: task.id, modelId: model.configuration!.id, transport };
};
