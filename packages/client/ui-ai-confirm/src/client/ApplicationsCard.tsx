import { useEffect, useId } from 'react'
import { Button, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ConfirmApi } from './api.ts'
import { resultText, statusLabel } from './ConfirmCard.tsx'
import { openList } from './controller.ts'
import type { createConfirmStore } from './confirm-store.ts'
import { parseApplications, type ListedApplication } from './model.ts'
import css from './ApplicationsCard.module.css'

/** What the plugin injects into every read card. */
export interface ApplicationsInjected {
  readonly api: ConfirmApi
}

/** Full props of a registered read card. */
export type ApplicationsCardProps = ToolCallViewProps
  & PropsStore<ReturnType<typeof createConfirmStore>>
  & InjectFace<ApplicationsInjected>
  & PropsLocale<'aiConfirm'>

/**
 * Render the result of `list_applications` or `get_application` as a table. The AI result holds no
 * names; the browser fills them in from the staff-only summaries call, and shows the table without
 * them when that call fails.
 * @param props - keyed toolview payload, the card store, the injected face and the locale seat.
 * @returns the table, or nothing while the call runs or when the result has no applications.
 */
export function ApplicationsCard(props: ApplicationsCardProps) {
  if (props.phase !== 'result' || props.block.isError) return null
  const rows = parseApplications(resultText(props.block))
  return rows === null ? null : <ApplicationsTable {...props} rows={rows} />
}

type TableProps = ApplicationsCardProps & { readonly rows: readonly ListedApplication[] }

function ApplicationsTable({ rows, callId, api, t, useStore, actions }: TableProps) {
  const titleId = useId()
  const list = useStore(state => state.lists[callId])
  const started = list !== undefined
  useEffect(() => {
    // One automatic load per logged call; a remount finds the stored state. Retry is the button.
    if (!started) void openList(api, actions, callId, rows.map(row => row.id))
  }, [started, api, actions, callId, rows])

  const loading = list === undefined || list.phase === 'loading'
  return (
    <section className={css.card} data-tool="ai-applications" data-state={list?.phase ?? 'loading'} aria-labelledby={titleId}>
      <h3 id={titleId} className={css.title}>
        {t(rows.length === 1 ? 'applications.title.one' : 'applications.title.other', { count: rows.length })}
      </h3>
      <table className={css.table}>
        <thead>
          <tr>
            <th scope="col">{t('applications.col.name')}</th>
            <th scope="col">{t('applications.col.reference')}</th>
            <th scope="col">{t('applications.col.status')}</th>
            <th scope="col">{t('applications.col.program')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id}>
              <td className={css.name}>{list?.names[row.id] ?? '—'}</td>
              <td>{row.reference}</td>
              <td>{statusLabel(t, row.status)}</td>
              <td>{row.program}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && <div role="status" className={css.note}><TextShimmer active>{t('applications.loading')}</TextShimmer></div>}
      {list?.phase === 'failed' && (
        <div role="status" className={css.note}>
          <span>{t('applications.namesFailed')}</span>
          <Button variant="outline" size="sm" onClick={() => { void openList(api, actions, callId, rows.map(row => row.id)) }}>
            {t('action.retry')}
          </Button>
        </div>
      )}
    </section>
  )
}
