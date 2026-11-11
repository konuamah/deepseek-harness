/** Chat renderer for staff cards outside collapsed tool groups. */
import { useEffect, useId } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ApplicationsCard, type ApplicationsCardProps } from './ApplicationsCard.tsx'
import { ConfirmCard } from './ConfirmCard.tsx'
import type { CardData } from './card-definition.ts'
import { EMPTY_FORM, type TurnCard } from './confirm-store.ts'
import type { ApplicationFormApi } from './application-form-api.ts'
import type { OfferFormApi } from './offer-form-api.ts'
import { ACTIONS, parseApplications, parseFormMarker, wireName } from './model.ts'
import { PrivateForm } from './PrivateForm.tsx'
import css from './ApplicationsCard.module.css'

type CardNodeProps = Pick<PropsRuntime<'conversation.chat.node', 'ai-confirm-card'>, 'node'>
  & Omit<ApplicationsCardProps, keyof CardData>
  & {
    readonly serverName: string
    readonly applicationApi: ApplicationFormApi
    readonly offerApi: OfferFormApi
  }

/** Whether a later loaded card in the same turn shows every application this card shows. */
function superseded(
  turnCards: readonly TurnCard[] | undefined,
  card: { readonly callId: string; readonly seq: number; readonly applicationIds: readonly number[] },
): boolean {
  return turnCards !== undefined && card.applicationIds.length > 0
    && turnCards.some(other =>
      other.callId !== card.callId && other.seq > card.seq && other.loaded
      && other.applicationIds.length > 0
      && card.applicationIds.every(id => other.applicationIds.includes(id)))
}

/** The turn number a Chat node sits in, or undefined outside a turn. */
function turnOf(location: { readonly kind: string; readonly turn?: { readonly turn: number } }): number | undefined {
  return location.kind === 'turn' || location.kind === 'step' ? location.turn?.turn : undefined
}

/** Whether a card is a lookup, and whether it settled with applications to show. */
function readFacts(data: CardData): { readonly isRead: boolean; readonly loaded: boolean } {
  const name = data.toolName.split('__').at(-1)
  const isRead = name === 'list_applications' || name === 'get_application'
  const loaded = data.phase === 'result' && !data.isError && (!isRead || data.applicationIds.length > 0)
  return { isRead, loaded }
}

/**
 * Render staff cards with Session-scoped disclosure and interaction state.
 * @param props - Chat node and injected card services.
 * @returns A collapsible application or confirmation card.
 */
export function CardNode({ node, serverName, applicationApi, offerApi, ...props }: CardNodeProps) {
  const contentId = useId()
  const data = node.data
  const collapsed = props.useStore(state => state.collapsed[data.callId] ?? false)
  const form = data.phase === 'result' && !data.isError ? parseFormMarker(data.toolName, data.text) : null
  const formState = props.useStore(state => state.forms[data.callId] ?? EMPTY_FORM)
  const locks = props.useStore(state => state.locks)
  const spec = ACTIONS.find(action => wireName(serverName, action) === data.toolName)

  const turn = turnOf(node.location)
  const { isRead, loaded } = readFacts(data)
  const turns = props.useStore(state => state.turns)

  useEffect(() => {
    if (turn === undefined) return
    props.actions.seeCard(turn, { seq: node.anchorSeq, callId: data.callId, applicationIds: data.applicationIds, loaded })
  }, [turn, node.anchorSeq, data.callId, data.applicationIds, loaded, props.actions])

  // A read card hides once a later loaded card in the same turn shows every application it shows.
  const hidden = isRead && turn !== undefined
    && superseded(turns[turn], { callId: data.callId, seq: node.anchorSeq, applicationIds: data.applicationIds })
  if (hidden) return null

  if (spec === undefined && form === null
    && (data.phase !== 'result' || data.isError || parseApplications(data.text) === null)) return null
  return (
    <div className={css.disclosure}>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className={css.toggle}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={() => { props.actions.collapse(data.callId, !collapsed) }}
      >
        {props.t(collapsed ? 'card.show' : 'card.hide')}
        {collapsed ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}
      </Button>
      <div id={contentId} hidden={collapsed}>
        {spec !== undefined
          ? <ConfirmCard {...props} {...data} spec={spec} />
          : form !== null
            ? <PrivateForm {...props} form={form} callId={data.callId} state={formState} locks={locks}
              applicationApi={applicationApi} offerApi={offerApi} />
            : <ApplicationsCard {...props} {...data} />}
      </div>
    </div>
  )
}
