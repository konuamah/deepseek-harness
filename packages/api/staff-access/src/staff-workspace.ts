/**
 * The one Workspace staff callers see and create Sessions in: an empty directory the plugin prepares at mount.
 * A marker file lets a restart reuse the same directory, and any other content makes the mount fail.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/staff-workspace
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory name under the Harness home when `workspaceDir` is omitted. */
export const STAFF_WORKSPACE_DIRECTORY = 'staff-workspace'
/** Empty marker written into a directory the plugin prepared, so a restart may reuse it. */
const MARKER = '.dsh-staff-workspace'

/**
 * Resolve the directory the shared staff Workspace lives in.
 * @param configured - the configured `workspaceDir`, or undefined for the default under the Harness home.
 * @returns the directory path, as configured or the default.
 */
export function resolveStaffWorkspaceDir(configured: string | undefined): string {
  return configured ?? join(resolveDshHome(), STAFF_WORKSPACE_DIRECTORY)
}

/**
 * Create the shared directory, or accept an existing one that holds nothing but the marker.
 * @param dir - absolute directory path from {@link resolveStaffWorkspaceDir}.
 * @throws Error when the path is relative, is not a directory, or holds content the plugin did not create.
 */
export function prepareStaffWorkspaceDir(dir: string): void {
  if (!isAbsolute(dir)) throw new Error('staff-access: workspaceDir must be an absolute path')
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error('staff-access: workspaceDir is not a directory')
    if (readdirSync(dir).some(entry => entry !== MARKER)) {
      throw new Error('staff-access: workspaceDir is not empty and was not prepared by staff access')
    }
  } else {
    mkdirSync(dir, { recursive: true })
  }
  const marker = join(dir, MARKER)
  if (!existsSync(marker)) writeFileSync(marker, '')
}
