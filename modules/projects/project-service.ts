import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Notifications } from '../events/notifications.ts';
import type { Project, ProjectStore, Projects } from './project.ts';

/** Owns connected directories; connecting never starts setup, inference or a run. */
export class ProjectService implements Projects {
  private store: ProjectStore;
  private events: Notifications;

  /** Connects project persistence and change notifications. */
  constructor(input: { store: ProjectStore; events: Notifications }) {
    this.store = input.store;
    this.events = input.events;
  }

  /** Lists connected projects. */
  async list(): Promise<Project[]> {
    return this.store.list();
  }

  /** Returns one project or undefined when it is no longer connected. */
  async get(input: { id: string }): Promise<Project | undefined> {
    return this.store.get(input.id);
  }

  /** Connects a real directory; an already connected directory returns its current identity. */
  async connect(input: { root: string; name?: string }): Promise<Project> {
    const root = await fs.realpath(input.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('A project must be a directory.');
    const existing = (await this.store.list()).find(project => project.root === root);
    if (existing) return existing;
    const project: Project = { id: randomUUID(), root, name: input.name ?? path.basename(root) };
    await this.store.save(project);
    this.events.publish({ type: 'project.connected', data: project });
    return project;
  }

  /** Disconnects the project record while preserving its files and historical workspaces. */
  async disconnect(input: { id: string }): Promise<void> {
    await this.store.delete(input.id);
    this.events.publish({ type: 'project.disconnected', data: input });
  }
}
