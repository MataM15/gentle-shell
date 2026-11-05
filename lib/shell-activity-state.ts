import { isJobsSidebarSnapshot, type RunningJobDisplay } from './jobs-sidebar-state.ts';

export function acceptedJobs(sessionId: string | undefined, value: unknown): RunningJobDisplay[] | undefined {
 if (!sessionId || !value || typeof value !== 'object') return undefined;
 const event = value as { sessionId?: unknown; snapshot?: unknown };
 if (event.sessionId !== sessionId || !isJobsSidebarSnapshot(event.snapshot)) return undefined;
 // Optional finished-tail fields pass through only when the publisher set
 // them: a running job keeps the exact {id,label,startedAt} shape.
 return event.snapshot.jobs.map(({id,label,startedAt,status,endedAt,exitCode}) => {
  const display: RunningJobDisplay = {id,label,startedAt};
  if (status !== undefined) display.status = status;
  if (endedAt !== undefined) display.endedAt = endedAt;
  if (exitCode !== undefined) display.exitCode = exitCode;
  return display;
 });
}
