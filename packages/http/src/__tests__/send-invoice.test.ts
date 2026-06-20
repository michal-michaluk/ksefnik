import { describe, expect, it, beforeAll } from 'vitest'
import { webcrypto } from 'node:crypto'
import { KsefHttpClient } from '../client.js'
import { openOnlineSession, sendOnlineInvoice, closeOnlineSession } from '../send-invoice.js'
import { generateAesKey, encryptAes256Cbc, sha256Base64, encryptSymmetricKeyWithRsaOaep } from '../crypto.js'
import { HttpClient } from '../http.js'

interface MockResponseDef {
  status: number
  body: string
  headers?: Record<string, string>
}

interface RouteHandler {
  (req: { url: string; method: string; headers: Record<string, string>; body: unknown }): MockResponseDef
}

function makeMockFetch(routes: Record<string, RouteHandler>) {
  const calls: Array<{ url: string; method: string }> = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    const urlNoQuery = url.split('?')[0]!
    const routeKey = `${method} ${urlNoQuery}`
    const handler = routes[routeKey]
    if (!handler) throw new Error(`mockFetch: no route for ${routeKey}`)
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as Record<string, string>
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v
    }
    const parsedBody: unknown = init?.body
      ? (() => {
          try { return JSON.parse(String(init.body)) } catch { return init.body }
        })()
      : undefined
    const res = handler({ url, method, headers, body: parsedBody })
    const body = res.status === 204 ? null : res.body
    return new Response(body, {
      status: res.status,
      headers: res.headers ?? { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return Object.assign(impl, { calls })
}

async function generateKeyPair(): Promise<{ publicPem: string; privateKey: CryptoKey }> {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )
  const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey)
  const b64 = Buffer.from(spki).toString('base64')
  const chunks = b64.match(/.{1,64}/g) ?? [b64]
  const pem = `-----BEGIN PUBLIC KEY-----\n${chunks.join('\n')}\n-----END PUBLIC KEY-----\n`
  return { publicPem: pem, privateKey: pair.privateKey }
}

let publicPem: string
let privateKey: CryptoKey

function futureValidUntil(): string {
  return new Date(Date.now() + 10 * 60 * 1000).toISOString()
}

beforeAll(async () => {
  const pair = await generateKeyPair()
  publicPem = pair.publicPem
  privateKey = pair.privateKey
})

function makeClient(baseUrl: string, routes: Record<string, RouteHandler>): KsefHttpClient {
  return new KsefHttpClient({
    environment: 'test',
    baseUrl,
    publicKeyPem: publicPem,
    fetchImpl: makeMockFetch(routes),
    retry: { maxAttempts: 1 },
  })
}

describe('send-invoice module functions', () => {
  it('openOnlineSession sends POST /sessions/online with formCode and encryption', async () => {
    const BASE = 'https://test.test/v2'
    const fetchImpl = makeMockFetch({
      [`POST ${BASE}/sessions/online`]: ({ body }) => ({
        status: 200,
        body: JSON.stringify({
          referenceNumber: 'SESSION-REF-1',
          validUntil: futureValidUntil(),
        }),
      }),
    })
    const http = new HttpClient({ baseUrl: BASE, fetchImpl })

    const result = await openOnlineSession(http, 'access-jwt', {
      formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
      encryption: { encryptedSymmetricKey: 'base64key==', initializationVector: 'base64iv==' },
    })

    expect(result.referenceNumber).toBe('SESSION-REF-1')
    expect(result.validUntil).toBeDefined()
  })

  it('sendOnlineInvoice sends POST /sessions/online/{ref}/invoices', async () => {
    const BASE = 'https://test.test/v2'
    const fetchImpl = makeMockFetch({
      [`POST ${BASE}/sessions/online/SESSION-42/invoices`]: ({ body }) => ({
        status: 200,
        body: JSON.stringify({ referenceNumber: 'KSEF-REF-1' }),
      }),
    })
    const http = new HttpClient({ baseUrl: BASE, fetchImpl })

    const result = await sendOnlineInvoice(http, 'access-jwt', 'SESSION-42', {
      invoiceHash: 'hash1',
      invoiceSize: 100,
      encryptedInvoiceHash: 'ehash1',
      encryptedInvoiceSize: 128,
      encryptedInvoiceContent: 'base64encrypted==',
      offlineMode: false,
    })

    expect(result.referenceNumber).toBe('KSEF-REF-1')
  })

  it('closeOnlineSession sends POST /sessions/online/{ref}/close', async () => {
    const BASE = 'https://test.test/v2'
    let called = false
    const fetchImpl = makeMockFetch({
      [`POST ${BASE}/sessions/online/SESSION-99/close`]: () => {
        called = true
        return { status: 204, body: '' }
      },
    })
    const http = new HttpClient({ baseUrl: BASE, fetchImpl })

    await closeOnlineSession(http, 'access-jwt', 'SESSION-99')
    expect(called).toBe(true)
  })
})

describe('crypto helpers for sendInvoice', () => {
  it('generateAesKey produces 32-byte key and 16-byte iv', () => {
    const { key, iv } = generateAesKey()
    expect(key.length).toBe(32)
    expect(iv.length).toBe(16)
  })

  it('encryptAes256Cbc produces different ciphertext from plaintext', () => {
    const { key, iv } = generateAesKey()
    const plaintext = Buffer.from('<Faktura>test</Faktura>', 'utf8')
    const encrypted = encryptAes256Cbc(plaintext, key, iv)
    expect(encrypted).not.toEqual(plaintext)
    expect(encrypted.length % 16).toBe(0)
  })

  it('sha256Base64 returns deterministic hash', () => {
    const data = Buffer.from('hello', 'utf8')
    const hash1 = sha256Base64(data)
    const hash2 = sha256Base64(data)
    expect(hash1).toBe(hash2)
    expect(typeof hash1).toBe('string')
  })

  it('encryptSymmetricKeyWithRsaOaep produces base64 string', () => {
    const { key } = generateAesKey()
    const encrypted = encryptSymmetricKeyWithRsaOaep(key, publicPem)
    expect(typeof encrypted).toBe('string')
    expect(encrypted.length).toBeGreaterThan(0)
  })
})

describe('KsefHttpClient.sendInvoice full flow', () => {
  it('sends invoice through interactive session and returns ksefReferenceNumber', async () => {
    const BASE = 'https://example.test/v2'
    const fetchImpl = makeMockFetch({
      [`POST ${BASE}/auth/challenge`]: () => ({
        status: 200,
        body: JSON.stringify({
          challenge: 'CHALLENGE-1',
          timestamp: '2026-04-11T18:09:48.6432641+00:00',
          timestampMs: 1744395288643,
          clientIp: '127.0.0.1',
        }),
      }),
      [`POST ${BASE}/auth/ksef-token`]: () => ({
        status: 200,
        body: JSON.stringify({
          authenticationToken: { token: 'auth-jwt' },
          referenceNumber: 'AUTH-REF-1',
        }),
      }),
      [`GET ${BASE}/auth/AUTH-REF-1`]: () => ({
        status: 200,
        body: JSON.stringify({
          startDate: new Date().toISOString(),
          authenticationMethod: 'Token',
          status: { code: 200, description: 'OK' },
        }),
      }),
      [`POST ${BASE}/auth/token/redeem`]: () => ({
        status: 200,
        body: JSON.stringify({
          accessToken: { token: 'access-jwt', validUntil: futureValidUntil() },
          refreshToken: { token: 'refresh-jwt', validUntil: futureValidUntil() },
        }),
      }),
      [`POST ${BASE}/sessions/online`]: ({ body }) => ({
        status: 200,
        body: JSON.stringify({
          referenceNumber: 'SESSION-REF-123',
          validUntil: futureValidUntil(),
        }),
      }),
      [`POST ${BASE}/sessions/online/SESSION-REF-123/invoices`]: ({ body }) => ({
        status: 200,
        body: JSON.stringify({ referenceNumber: 'KSEF-REF-456' }),
      }),
      [`POST ${BASE}/sessions/online/SESSION-REF-123/close`]: () => ({
        status: 204,
        body: '',
      }),
    })

    const client = new KsefHttpClient({
      environment: 'test',
      baseUrl: BASE,
      publicKeyPem: publicPem,
      fetchImpl,
      retry: { maxAttempts: 1 },
    })

    const session = await client.initSession({
      nip: '7010002137',
      environment: 'test',
      token: 'ksef-token-xyz',
    })

    const result = await client.sendInvoice({
      token: session.token,
      xml: '<?xml version="1.0"?><Faktura></Faktura>',
    })

    expect(result.ksefReferenceNumber).toBe('KSEF-REF-456')
    expect(result.timestamp).toBeDefined()
    expect(new Date(result.timestamp).getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('rejects invalid session token', async () => {
    const client = makeClient('https://test.test/v2', {})
    await expect(
      client.sendInvoice({ token: 'bad-token', xml: '<Faktura/>' }),
    ).rejects.toThrow(/invalid session token/i)
  })

  it('re-throws API error from openOnlineSession', async () => {
    const BASE = 'https://test.test/v2'
    const fetchImpl = makeMockFetch({
      [`POST ${BASE}/auth/challenge`]: () => ({
        status: 200,
        body: JSON.stringify({ challenge: 'C', timestamp: '2026-04-11T18:09:48.6432641+00:00', timestampMs: Date.now(), clientIp: '127.0.0.1' }),
      }),
      [`POST ${BASE}/auth/ksef-token`]: () => ({
        status: 200,
        body: JSON.stringify({ authenticationToken: { token: 'a' }, referenceNumber: 'R' }),
      }),
      [`GET ${BASE}/auth/R`]: () => ({
        status: 200,
        body: JSON.stringify({ startDate: new Date().toISOString(), authenticationMethod: 'Token', status: { code: 200, description: 'OK' } }),
      }),
      [`POST ${BASE}/auth/token/redeem`]: () => ({
        status: 200,
        body: JSON.stringify({ accessToken: { token: 'a', validUntil: futureValidUntil() }, refreshToken: { token: 'r', validUntil: futureValidUntil() } }),
      }),
      [`POST ${BASE}/sessions/online`]: () => ({
        status: 400,
        body: JSON.stringify({
          exception: {
            exceptionDetailList: [{ exceptionCode: 'SOME_ERROR', exceptionDescription: 'Session error' }],
          },
        }),
      }),
    })
    const client = new KsefHttpClient({
      environment: 'test',
      baseUrl: BASE,
      publicKeyPem: publicPem,
      fetchImpl,
      retry: { maxAttempts: 1 },
    })
    const session = await client.initSession({ nip: '7010002137', environment: 'test', token: 'ksef-token' })
    await expect(
      client.sendInvoice({ token: session.token, xml: '<Faktura/>' }),
    ).rejects.toThrow(/Session error/i)
  })
})
