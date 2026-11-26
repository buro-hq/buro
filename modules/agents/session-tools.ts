import type { Notifications } from '../events/notifications.ts';
import type { Models } from '../models/model.ts';
import type { Session, Sessions } from '../sessions/session.ts';
import { objectArguments, textArgument } from '../tools/arguments.ts';
import { ToolFailure, type Tool, type ToolContext } from '../tools/tool.ts';
import type { Agents } from './agent.ts';

const string = { type: 'string' };
const parameters = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Registers optional collaboration as ordinary tools; no agent name selects a workflow. */
export const sessionTools = (input: {
  sessions: Sessions;
  models: Models;
  agents: Agents;
  events: Notifications;
}): Tool[] => {
  const related = async (argumentsValue: unknown, context: ToolContext): Promise<Session> => {
    const args = objectArguments(argumentsValue);
    const id = textArgument({
      arguments: args,
      name: 'sessionId',
    })!;
    const session = await input.sessions.get({
      id,
    });
    const sharesRun = session?.runId === context.runId;
    const isCaller = session?.id === context.sessionId;
    const isCollaborator = session?.parentId === context.sessionId;
    const isRelated = context.runId ? sharesRun : isCaller || isCollaborator;
    const isAccessible = session && isRelated;
    if (!isAccessible)
      throw new ToolFailure('No such conversation in this work.');

    return session;
  };

  const summary = (session: Session | undefined): string => JSON.stringify(
    session
      ? {
          sessionId: session.id,
          parentId: session.parentId,
          agentId: session.agentId,
          modelId: session.modelId,
          status: session.status,
          result: session.result,
          error: session.error,
        }
      : { error: 'Session not found.' },
  );

  return [
    {
      effect: 'read',
      definition: {
        name: 'agents_list',
        description:
          'List reusable agent descriptions. Any description can be used or replaced with custom instructions.',
        parameters: parameters({}),
      },
      async execute() {
        return { content: JSON.stringify(await input.agents.list()) };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'models_list',
        description: 'List available models for this or another conversation.',
        parameters: parameters({}),
      },
      async execute() {
        return { content: JSON.stringify(input.models.list()) };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'model_select',
        description: 'Choose the next model for this conversation while retaining its history.',
        parameters: parameters({
          modelId: string,
        }, ['modelId']),
      },
      async execute({ arguments: value, context }) {
        const args = objectArguments(value);
        const modelId = textArgument({
          arguments: args,
          name: 'modelId',
        })!;
        const ok = await input.sessions.switchModel({
          sessionId: context.sessionId,
          modelId,
        });
        return { content: ok ? 'Selected model ' + modelId : 'Model unavailable.', isError: !ok };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'session_start',
        description:
          'Start a collaborator with the shared work policy and context and return its session ID immediately. Put the assignment in input. Omit agentId for an inline collaborator; use it only for an existing agents_list entry. The optional instructions are this collaborator’s own operating rules, not inherited by its own collaborators; the shared policy is. Choose a model when needed. Use session_wait to receive the result; writing collaborators share files, so coordinate edits.',
        parameters: parameters(
          {
            input: string,
            agentId: string,
            instructions: string,
            modelId: string,
            readOnly: { type: 'boolean' },
            tools: { type: 'array', items: string },
          },
          ['input'],
        ),
      },
      async execute({ arguments: value, context }) {
        const args = objectArguments(value);
        const prompt = textArgument({
          arguments: args,
          name: 'input',
        })!;
        const agentId = textArgument({
          arguments: args,
          name: 'agentId',
          optional: true,
        });
        const agent = agentId
          ? await input.agents.get({
              id: agentId,
            })
          : undefined;
        const descriptionMissing = agentId && !agent;
        if (descriptionMissing)
          throw new ToolFailure('Agent description not found.');

        const modelId = textArgument({
          arguments: args,
          name: 'modelId',
          optional: true,
        });
        const instructions = textArgument({
          arguments: args,
          name: 'instructions',
          optional: true,
        });
        const hasReadOnly = args.readOnly !== undefined;
        const invalidReadOnly = hasReadOnly && typeof args.readOnly !== 'boolean';
        if (invalidReadOnly)
          throw new ToolFailure('readOnly must be a boolean.');

        const { tools: requestedTools } = args;
        const hasTools = requestedTools !== undefined;
        const invalidTools = hasTools &&
          (!Array.isArray(requestedTools) || requestedTools.some((name) => typeof name !== 'string'));
        if (invalidTools)
          throw new ToolFailure('tools must be an array of tool names.');

        const requested = (args.tools as string[] | undefined) ?? agent?.tools;
        const tools = context.tools
          ? context.tools.filter((name) => !requested || requested.includes(name))
          : requested;
        const parent = await input.sessions.get({
          id: context.sessionId,
        });
        context.signal.throwIfAborted();
        const created = await input.sessions.create({
          runId: context.runId,
          parentId: context.sessionId,
          agentId,
          modelId: modelId ?? parent?.modelId,
          instructions: instructions ?? agent?.instructions,
          policy: parent?.policy,
          context: parent?.context,
          access: { readOnly: context.readOnly || args.readOnly === true, tools },
        });
        if (!created.ok)
          return { content: created.error ?? 'Unable to start session.', isError: true };

        const job = input.sessions.run({
          sessionId: created.sessionId,
          input: prompt,
          workspace: context.workspace,
          projectId: context.projectId,
          readOnly: context.readOnly || args.readOnly === true,
          tools,
          signal: context.signal,
        });
        void job.catch((error) =>
          input.events.publish({
            type: 'session.error',
            data: {
              sessionId: created.sessionId,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
        return { content: JSON.stringify({
          sessionId: created.sessionId,
          status: 'running',
        }) };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'session_status',
        description: 'Read a collaborator’s state and final result.',
        parameters: parameters({
          sessionId: string,
        }, ['sessionId']),
      },
      async execute({ arguments: value, context }) {
        return { content: summary(await related(value, context)) };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'session_wait',
        description: 'Wait for a collaborator’s current turn and read its result.',
        parameters: parameters({
          sessionId: string,
        }, ['sessionId']),
      },
      async execute({ arguments: value, context }) {
        const session = await related(value, context);
        const result = await input.sessions.wait({
          id: session.id,
          callerId: context.sessionId,
          signal: context.signal,
        });
        return {
          content: result.ok ? summary(result.session) : result.error!,
          isError: !result.ok,
        };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'session_send',
        description: 'Send follow-up work to an idle collaborator and receive its next result.',
        parameters: parameters({
          sessionId: string,
          input: string,
          modelId: string,
        }, [
          'sessionId',
          'input',
        ]),
      },
      async execute({ arguments: value, context }) {
        const session = await related(value, context);
        const args = objectArguments(value);
        const result = await input.sessions.run({
          sessionId: session.id,
          input: textArgument({
            arguments: args,
            name: 'input',
          })!,
          modelId: textArgument({
            arguments: args,
            name: 'modelId',
            optional: true,
          }),
          workspace: context.workspace,
          projectId: context.projectId,
          readOnly: context.readOnly,
          tools: context.tools,
          signal: context.signal,
        });
        return { content: JSON.stringify(result), isError: !result.ok };
      },
    },
    {
      effect: 'read',
      definition: {
        name: 'session_interrupt',
        description: 'Stop a collaborator while preserving its work and history.',
        parameters: parameters({
          sessionId: string,
        }, ['sessionId']),
      },
      async execute({ arguments: value, context }) {
        const session = await related(value, context);
        input.sessions.interrupt({
          sessionId: session.id,
        });
        return { content: 'Interruption requested.' };
      },
    },
  ];
};
