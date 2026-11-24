import { randomUUID } from 'node:crypto';
import type { Notifications } from '../events/notifications.ts';
import type { Task, TaskInput, TaskStore, Tasks } from './task.ts';

/** Owns task records; other features reference tasks by ID. */
export class TaskService implements Tasks {
  private store: TaskStore;
  private events: Notifications;

  /** Connects the module's storage and change-notification channel. */
  constructor(input: { store: TaskStore; events: Notifications }) {
    this.store = input.store;
    this.events = input.events;
  }

  /** Lists tasks, optionally restricted to one project. */
  async list(input: { projectId?: string } = {}): Promise<Task[]> {
    return (await this.store.list()).filter(task => !input.projectId || task.projectId === input.projectId);
  }

  /** Returns one task, or undefined for a missing ID. */
  async get(input: { id: string }): Promise<Task | undefined> {
    return this.store.get(input.id);
  }

  /** Creates a task without opening a session or starting an attempt. */
  async create(input: TaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    await this.store.save(task);
    this.events.publish({ type: 'task.created', data: task });
    return task;
  }

  /** Replaces editable fields; a missing task is an ordinary absent result. */
  async update(input: TaskInput & { id: string }): Promise<Task | undefined> {
    const previous = await this.store.get(input.id);
    if (!previous) return undefined;
    const task: Task = { ...previous, ...input, updatedAt: new Date().toISOString() };
    await this.store.save(task);
    this.events.publish({ type: 'task.updated', data: task });
    return task;
  }

  /** Removes a task; historical runs and sessions retain their own records. */
  async delete(input: { id: string }): Promise<void> {
    await this.store.delete(input.id);
    this.events.publish({ type: 'task.deleted', data: input });
  }
}
