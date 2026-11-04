/** Staff login redirect: login URL validation, socket and unary redirect triggers, and one-shot navigation. */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createStaffLogin,
  readStaffLoginUrl,
  STAFF_LOGIN_META_NAME,
  type StaffLoginDocument,
  type StaffLoginLocation,
} from '../src/client/staff-login.ts'
import { createWebConnectionRpc } from '../src/client/rpc.ts'
import type { ConnectionWebSocket, ConnectionWebSocketEventMap } from '../src/client/socket.ts'

afterEach(() => { vi.restoreAllMocks() })

function locationProbe(
  pathname: string,
  search = '',
): StaffLoginLocation & { readonly assign: Mock<(url: string) => void> } {
  return { pathname, search, assign: vi.fn<(url: string) => void>() }
}

function metaDocument(content: string | null): StaffLoginDocument {
  return {
    querySelector: (selector: string) => {
      expect(selector).toBe(`meta[name="${STAFF_LOGIN_META_NAME}"]`)
      return { getAttribute: (name: string) => (name === 'content' ? content : null) }
    },
  }
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function recordingSocket(): { socket: ConnectionWebSocket; fire: (event: 'error' | 'close') => void } {
  const listeners: { [E in keyof ConnectionWebSocketEventMap]: Array<(event: ConnectionWebSocketEventMap[E]) => void> } = {
    open: [],
    error: [],
    close: [],
    message: [],
  }
  const socket: ConnectionWebSocket = {
    readyState: 0,
    send: vi.fn<(data: string) => void>(),
    close: vi.fn<(code?: number, reason?: string) => void>(),
    addEventListener<Event extends keyof ConnectionWebSocketEventMap>(
      event: Event,
      listener: (event: ConnectionWebSocketEventMap[Event]) => void,
    ): void {
      listeners[event].push(listener)
    },
    removeEventListener: vi.fn<ConnectionWebSocket['removeEventListener']>(),
  }
  return {
    socket,
    fire: (event) => {
      for (const listener of listeners[event]) listener({})
    },
  }
}

describe('readStaffLoginUrl', () => {
  it.each(['/login', '/signin/x'])('returns the valid login path %s', (value) => {
    expect(readStaffLoginUrl(metaDocument(value))).toBe(value)
  })

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', 'login', ''])(
    'rejects %j with one console error',
    (value) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})

      expect(readStaffLoginUrl(metaDocument(value))).toBeUndefined()
      expect(error).toHaveBeenCalledTimes(1)
    },
  )

  it('returns undefined without console output when the meta element has no content attribute', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(readStaffLoginUrl(metaDocument(null))).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })

  it('returns undefined without console output when the meta element is absent', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const doc: StaffLoginDocument = { querySelector: () => null }

    expect(readStaffLoginUrl(doc)).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })

  it('returns undefined without console output when the document has no querySelector', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(readStaffLoginUrl({})).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })

  it('returns undefined outside a document', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(readStaffLoginUrl(undefined)).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })
})

describe('createStaffLogin unauthorized redirect', () => {
  it('navigates once to the login path with the encoded page path and query', () => {
    const location = locationProbe('/chat/room 1', '?q=a&x=%20')
    const login = createStaffLogin({ loginUrl: '/login', location, probe: vi.fn<() => Promise<number>>() })

    login.unauthorized()

    expect(location.assign).toHaveBeenCalledExactlyOnceWith(
      `/login?next=${encodeURIComponent('/chat/room 1?q=a&x=%20')}`,
    )
  })

  it.each(['/login', '/login/callback'])('never navigates from the login path %s', (pathname) => {
    const location = locationProbe(pathname)
    const login = createStaffLogin({ loginUrl: '/login', location, probe: vi.fn<() => Promise<number>>() })

    login.unauthorized()

    expect(location.assign).not.toHaveBeenCalled()
  })

  it('navigates at most once per page load', () => {
    const location = locationProbe('/chat')
    const login = createStaffLogin({ loginUrl: '/login', location, probe: vi.fn<() => Promise<number>>() })

    login.unauthorized()
    login.unauthorized()

    expect(location.assign).toHaveBeenCalledOnce()
  })
})

describe('createStaffLogin socket watch', () => {
  it.each(['close', 'error'] as const)('redirects after a %s event when the probe answers 401', async (event) => {
    const location = locationProbe('/chat')
    const probe = vi.fn(() => Promise.resolve(401))
    const { socket, fire } = recordingSocket()
    createStaffLogin({ loginUrl: '/login', location, probe }).watchSocket(socket)

    fire(event)
    await flush()

    expect(probe).toHaveBeenCalledOnce()
    expect(location.assign).toHaveBeenCalledExactlyOnceWith(`/login?next=${encodeURIComponent('/chat')}`)
  })

  it.each([
    ['status 200', () => Promise.resolve(200)],
    ['status 500', () => Promise.resolve(500)],
    ['a rejected probe', () => Promise.reject(new Error('network'))],
  ])('does not redirect on %s', async (_label, probe) => {
    const location = locationProbe('/chat')
    const probeSpy = vi.fn<() => Promise<number>>(probe)
    const { socket, fire } = recordingSocket()
    createStaffLogin({ loginUrl: '/login', location, probe: probeSpy }).watchSocket(socket)

    fire('close')
    await flush()

    expect(probeSpy).toHaveBeenCalledOnce()
    expect(location.assign).not.toHaveBeenCalled()
  })
})

describe('createWebConnectionRpc unauthorized hook', () => {
  const target = { channel: '/api', endpoint: 'remote.mux' }

  function callWith(fetchImpl: () => Promise<Response>, onUnauthorized?: () => void): Promise<unknown> {
    const rpc = createWebConnectionRpc(() => fetchImpl(), undefined, onUnauthorized)
    return rpc.call(target.channel, target.endpoint, {}, undefined)
  }

  it('calls onUnauthorized once for a 401 and rejects with HTTP 401', async () => {
    const onUnauthorized = vi.fn<() => void>()

    await expect(callWith(() => Promise.resolve(new Response('', { status: 401 })), onUnauthorized))
      .rejects.toThrow('HTTP 401')
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('does not call onUnauthorized for a 500 and rejects with HTTP 500', async () => {
    const onUnauthorized = vi.fn<() => void>()

    await expect(callWith(() => Promise.resolve(new Response('', { status: 500 })), onUnauthorized))
      .rejects.toThrow('HTTP 500')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('does not call onUnauthorized for a network error and rejects with that error', async () => {
    const onUnauthorized = vi.fn<() => void>()
    const failure = new Error('network down')

    await expect(callWith(() => Promise.reject(failure), onUnauthorized)).rejects.toBe(failure)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('rejects a 401 with HTTP 401 and no further effect when staff mode is off', async () => {
    await expect(callWith(() => Promise.resolve(new Response('', { status: 401 }))))
      .rejects.toThrow('HTTP 401')
  })
})

describe('staff login through the unary RPC', () => {
  it('navigates once with the page path on the first 401 and never again', async () => {
    const location = locationProbe('/chat', '?room=1')
    const login = createStaffLogin({ loginUrl: '/login', location, probe: vi.fn<() => Promise<number>>() })
    const rpc = createWebConnectionRpc(
      () => Promise.resolve(new Response('', { status: 401 })),
      undefined,
      login.unauthorized,
    )

    await expect(rpc.call('/api', 'remote.mux', {}, undefined)).rejects.toThrow('HTTP 401')
    await expect(rpc.call('/api', 'remote.mux', {}, undefined)).rejects.toThrow('HTTP 401')

    expect(location.assign).toHaveBeenCalledExactlyOnceWith(
      `/login?next=${encodeURIComponent('/chat?room=1')}`,
    )
  })
})
