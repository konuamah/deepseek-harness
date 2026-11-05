import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Id the stub registry gives the shared staff Workspace. */
export const SHARED_WORKSPACE_ID = 'staff-ws' as WorkspaceId

/**
 * Provide a `workspaceRegistry` whose `create` records each directory and answers with the shared id.
 * @param ctx - Context the staff plugin mounts into.
 * @param created - receives each directory path passed to `create`.
 */
export function provideWorkspaceRegistry(ctx: Context, created: string[] = []): void {
  ctx.provide('workspaceRegistry', {
    create: (path: string) => {
      created.push(path)
      return Promise.resolve({ id: SHARED_WORKSPACE_ID, path })
    },
  } as never)
}

/** Let pending microtasks, including the shared Workspace registration, settle. */
export function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}
