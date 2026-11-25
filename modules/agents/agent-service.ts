import { randomUUID } from 'node:crypto';
import type { Notifications } from '../events/notifications.ts';
import type { Agent, Agents, AgentStore } from './agent.ts';

/** Owns reusable instructions independently of sessions and run completion. */
export class AgentService implements Agents {
  private store: AgentStore;
  private events: Notifications;

  /** Connects agent storage and change notifications. */
  constructor(input: { store: AgentStore; events: Notifications }) {
    this.store = input.store;
    this.events = input.events;
  }

  /** Lists descriptions without assigning special meaning to their names. */
  async list(): Promise<Agent[]> {
    return this.store.list();
  }

  /** Reads one saved description. */
  async get(input: { id: string }): Promise<Agent | undefined> {
    return this.store.get(input.id);
  }

  /** Creates or replaces instructions; existing sessions keep their own instructions. */
  async save(input: Omit<Agent, 'id'> & { id?: string }): Promise<Agent> {
    const agent: Agent = { ...structuredClone(input), id: input.id ?? randomUUID() };
    await this.store.save(agent);
    this.events.publish({
      type: 'agent.saved',
      data: agent,
    });
    return agent;
  }

  /** Removes a description without deleting sessions that referenced it. */
  async delete(input: { id: string }): Promise<void> {
    await this.store.delete(input.id);
    this.events.publish({
      type: 'agent.deleted',
      data: input,
    });
  }
}
