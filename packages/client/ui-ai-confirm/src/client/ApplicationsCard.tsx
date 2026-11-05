import { useEffect, useId } from 'react'
import { Button, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardData } from './card-definition.ts'
import type { ConfirmApi } from './api.ts'
import type { FilesState } from './confirm-store.ts'
import { statusLabel } from './ConfirmCard.tsx'
import { openDocuments, openList } from './controller.ts'
import type { createConfirmStore } from './confirm-store.ts'
import { parseApplications, type ListedApplication } from './model.ts'
import css from './ApplicationsCard.module.css'

/** What the plugin injects into every read card. */
export interface ApplicationsInjected {
  readonly api: ConfirmApi
  readonly signInUrl: string
}

/** Full props of a registered read card. */
export type ApplicationsCardProps = CardData
  & PropsStore<ReturnType<typeof createConfirmStore>>
  & InjectFace<ApplicationsInjected>
  & PropsLocale<'aiConfirm'>

/**
 * Render application results with names and private files loaded using the staff's browser session.
 * @param props - logged card data, the card store, the injected face and the locale seat.
 * @returns the table, or nothing while the call runs or when the result has no applications.
 */
export function ApplicationsCard(props: ApplicationsCardProps) {
  if (props.phase !== 'result' || props.isError) return null
  const rows = parseApplications(props.text)
  if (rows === null) return null
  const tool = props.toolName.split('__').at(-1)
  return <ApplicationsTable {...props} rows={rows} withDocuments={tool === 'get_application' && rows.length === 1} />
}

type TableProps = ApplicationsCardProps & { readonly rows: readonly ListedApplication[]; readonly withDocuments: boolean }

function ApplicationsTable({ rows, withDocuments, callId, api, signInUrl, t, useStore, actions }: TableProps) {
  const titleId = useId()
  const list = useStore(state => state.lists[callId])
  const files = useStore(state => state.files[callId])
  const started = list !== undefined
  const filesStarted = files !== undefined
  const applicationId = rows[0]?.id
  useEffect(() => {
    // One automatic load per logged call; a remount finds the stored state. Retry is the button.
    if (!started) void openList(api, actions, callId, rows.map(row => row.id))
    if (withDocuments && applicationId !== undefined && !filesStarted) void openDocuments(api, actions, callId, applicationId)
  }, [started, filesStarted, withDocuments, applicationId, api, actions, callId, rows])

  const loading = list === undefined || list.phase === 'loading'
  return (
    <section className={css.card} data-tool="ai-applications" data-state={list?.phase ?? 'loading'} aria-labelledby={titleId}>
      <h3 id={titleId} className={css.title}>
        {t(rows.length === 1 ? 'applications.title.one' : 'applications.title.other', { count: rows.length })}
      </h3>
      <div className={css.tableScroll} role="region" aria-labelledby={titleId} tabIndex={0}>
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
      </div>
      {loading && <div role="status" className={css.note}><TextShimmer active>{t('applications.loading')}</TextShimmer></div>}
      {withDocuments && applicationId !== undefined && (
        <ApplicationFiles
          api={api}
          signInUrl={signInUrl}
          t={t}
          callId={callId}
          applicationId={applicationId}
          files={files}
          actions={actions}
        />
      )}
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

function ApplicationFiles({
  api, signInUrl, t, callId, applicationId, files, actions,
}: {
  readonly api: ConfirmApi
  readonly signInUrl: string
  readonly t: ApplicationsCardProps['t']
  readonly callId: string
  readonly applicationId: number
  readonly files: FilesState | undefined
  readonly actions: ApplicationsCardProps['actions']
}) {
  if (files === undefined || files.phase === 'loading') {
    return <div role="status" className={css.note}><TextShimmer active>{t('files.loading')}</TextShimmer></div>
  }
  if (files.phase !== 'ready') {
    const signIn = files.phase === 'sign-in'
    return (
      <div role="status" className={css.note}>
        <span>{t(signIn ? 'files.signIn' : 'files.failed')}</span>
        {signIn && <a href={signInUrl} target="_blank" rel="noopener noreferrer">{t('action.signIn')}</a>}
        <Button variant="outline" size="sm" onClick={() => { void openDocuments(api, actions, callId, applicationId) }}>{t('action.retry')}</Button>
      </div>
    )
  }
  if (files.documents.length === 0) return <p className={css.note}>{t('files.empty')}</p>
  return (
    <div className={css.files}>
      {(['uploaded', 'official'] as const).map((kind) => {
        const documents = files.documents.filter(document => document.kind === kind)
        return documents.length === 0 ? null : (
          <section key={kind}>
            <h4>{kind === 'uploaded' ? t('files.uploaded') : t('files.official')}</h4>
            <ul>{documents.map(document => (
              <li key={`${kind}-${document.id}`}>
                <span>{document.title}</span>
                {document.status !== null && <span>{statusLabel(t, document.status)}</span>}
                {document.availableToApplicant === false && <span>{t('files.notReleased')}</span>}
                <span className={css.fileLinks}>
                  {document.previewable && <a href={api.documentUrl(kind, document.id, 'view')} target="_blank" rel="noopener noreferrer">{t('files.view')}</a>}
                  <a href={api.documentUrl(kind, document.id, 'download')} target="_blank" rel="noopener noreferrer">{t('files.download')}</a>
                </span>
              </li>
            ))}</ul>
          </section>
        )
      })}
    </div>
  )
}
