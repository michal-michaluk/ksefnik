import { withHttpRetry, type HttpRetryOptions } from './retry.js'
import type {
  KsefClient,
  KsefClientConfig,
  KsefSessionState,
  KsefRawInvoice,
} from '@ksefnik/core'

import { ENDPOINTS, type KsefEnvironment } from './endpoints.js'
import { HttpClient } from './http.js'
import {
  initKsefSession,
  refreshAccessToken,
  revokeCurrentSession,
  shouldRefresh,
  type ActiveSession,
} from './session.js'
import { fetchInvoices as fetchInvoicesHttp, fetchInvoiceXml as fetchInvoiceXmlHttp } from './invoices.js'
import { fetchInvoiceStatus, upoStatusFromCode } from './upo.js'
import { generateAesKey, encryptAes256Cbc, sha256Base64, encryptSymmetricKeyWithRsaOaep } from './crypto.js'
import { openOnlineSession, sendOnlineInvoice, closeOnlineSession } from './send-invoice.js'
import { KsefApiError } from './errors.js'
import { fetchKsefTokenEncryptionKey, fetchSymmetricKeyEncryptionKey } from './public-key.js'

export interface KsefHttpClientOptions {
  environment: KsefEnvironment
  /**
   * MF RSA public key in PEM/SPKI format used for `/auth/ksef-token` encryption.
   * If omitted, the client auto-fetches it from `GET /security/public-key-certificates`
   * on first `initSession()` call and caches it for the lifetime of the client.
   */
  publicKeyPem?: string
  /**
   * MF RSA public key in PEM/SPKI format used for invoice symmetric key encryption.
   * If omitted, the client auto-fetches it from `GET /security/public-key-certificates`
   * on first `sendInvoice()` call and caches it for the lifetime of the client.
   */
  symmetricKeyPem?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  userAgent?: string
  timeoutMs?: number
  retry?: HttpRetryOptions
}

/**
 * Delimiter between fields of the encoded session token. JWTs (access and
 * refresh tokens returned by KSeF 2.0) are base64url-encoded and cannot
 * contain `||`, so this round-trips safely through `KsefClient.fetchInvoices`.
 */
const SESSION_TOKEN_SEPARATOR = '||'

function encodeSessionToken(session: ActiveSession): string {
  return [
    'v1',
    session.accessToken,
    session.refreshToken,
    session.accessExpiresAt.toISOString(),
    session.referenceNumber,
  ].join(SESSION_TOKEN_SEPARATOR)
}

function decodeSessionToken(token: string): ActiveSession | null {
  const parts = token.split(SESSION_TOKEN_SEPARATOR)
  if (parts.length !== 5 || parts[0] !== 'v1') return null
  const [, accessToken, refreshToken, expiresAtIso, referenceNumber] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  const accessExpiresAt = new Date(expiresAtIso)
  if (Number.isNaN(accessExpiresAt.getTime())) return null
  return { accessToken, refreshToken, accessExpiresAt, referenceNumber }
}

export class KsefHttpClient implements KsefClient {
  private readonly http: HttpClient
  private readonly retryOpts: HttpRetryOptions
  private cachedPublicKeyPem: string | undefined
  private cachedSymmetricKeyPem: string | undefined


  constructor(private readonly opts: KsefHttpClientOptions) {
    const baseUrl = opts.baseUrl ?? ENDPOINTS[opts.environment]
    this.http = new HttpClient({
      baseUrl,
      fetchImpl: opts.fetchImpl,
      userAgent: opts.userAgent,
      defaultTimeoutMs: opts.timeoutMs,
    })
    this.retryOpts = opts.retry ?? {}
    this.cachedPublicKeyPem = opts.publicKeyPem
    this.cachedSymmetricKeyPem = opts.symmetricKeyPem
  }

  private async resolvePublicKey(): Promise<string> {
    if (this.cachedPublicKeyPem) return this.cachedPublicKeyPem
    const pem = await fetchKsefTokenEncryptionKey(this.http)
    this.cachedPublicKeyPem = pem
    return pem
  }

  private async resolveSymmetricKey(): Promise<string> {
    if (this.cachedSymmetricKeyPem) return this.cachedSymmetricKeyPem
    const pem = await fetchSymmetricKeyEncryptionKey(this.http)
    this.cachedSymmetricKeyPem = pem
    return pem
  }

  async initSession(config: KsefClientConfig): Promise<KsefSessionState> {
    if (!config.token) {
      throw new Error('KsefHttpClient.initSession: config.token (KSeF token) is required')
    }
    const publicKeyPem = await this.resolvePublicKey()
    const session = await withHttpRetry(
      () =>
        initKsefSession(this.http, {
          nip: config.nip,
          ksefToken: config.token,
          publicKeyPem,
        }),
      this.retryOpts,
    )

    return {
      token: encodeSessionToken(session),
      nip: config.nip,
      environment: config.environment,
      expiresAt: session.accessExpiresAt,
      referenceNumber: session.referenceNumber,
    }
  }

  async terminateSession(token: string, onlineSessionReferenceNumber?: string): Promise<void> {
    const session = decodeSessionToken(token)
    if (!session) return
    if (onlineSessionReferenceNumber) {
      await closeOnlineSession(this.http, session.accessToken, onlineSessionReferenceNumber).catch(() => {})
    }
    await revokeCurrentSession(this.http, session)
  }

  async fetchInvoices(params: {
    token: string
    dateFrom: string
    dateTo: string
    subjectNip?: string
    subjectType?: 'Subject1' | 'Subject2' | 'Subject3'
    pageSize?: number
    pageOffset?: number
    includeXml?: boolean
  }): Promise<{ invoices: KsefRawInvoice[]; total: number }> {
    let session = decodeSessionToken(params.token)
    if (!session) {
      throw new Error(
        'KsefHttpClient.fetchInvoices: invalid session token — expected the opaque ' +
          'string returned by initSession() (format `v1||access||refresh||validUntil||ref`), ' +
          'not a raw KSeF or JWT token',
      )
    }
    if (shouldRefresh(session)) {
      session = await withHttpRetry(() => refreshAccessToken(this.http, session as ActiveSession), this.retryOpts)
    }

    const result = await withHttpRetry(
      () =>
        fetchInvoicesHttp(this.http, {
          accessToken: (session as ActiveSession).accessToken,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          pageSize: params.pageSize,
          pageOffset: params.pageOffset,
          subjectType: params.subjectType ?? 'Subject2',
          includeXml: params.includeXml,
        }),
      this.retryOpts,
    )
    return result
  }

  async fetchInvoiceXml(params: { token: string; ksefNumber: string }): Promise<string> {
    let session = decodeSessionToken(params.token)
    if (!session) {
      throw new Error('KsefHttpClient.fetchInvoiceXml: invalid session token')
    }
    if (shouldRefresh(session)) {
      session = await withHttpRetry(
        () => refreshAccessToken(this.http, session as ActiveSession),
        this.retryOpts,
      )
    }
    return withHttpRetry(
      () =>
        fetchInvoiceXmlHttp(this.http, (session as ActiveSession).accessToken, params.ksefNumber),
      this.retryOpts,
    )
  }

  async sendInvoice(params: {
    token: string
    xml: string
  }): Promise<{ ksefReferenceNumber: string; timestamp: string; onlineSessionReferenceNumber: string }> {
    let session = decodeSessionToken(params.token)
    if (!session) {
      throw new Error(
        'KsefHttpClient.sendInvoice: invalid session token — expected the opaque ' +
        'string returned by initSession()',
      )
    }
    if (shouldRefresh(session)) {
      session = await withHttpRetry(
        () => refreshAccessToken(this.http, session as ActiveSession),
        this.retryOpts,
      )
    }

    const symmetricKeyPem = await this.resolveSymmetricKey()
    const { key, iv } = generateAesKey()
    const xmlBytes = Buffer.from(params.xml, 'utf8')
    const encryptedXml = encryptAes256Cbc(xmlBytes, key, iv)
    const invoiceHash = sha256Base64(xmlBytes)
    const encryptedInvoiceHash = sha256Base64(encryptedXml)

    const openResult = await withHttpRetry(
      () => openOnlineSession(this.http, session!.accessToken, {
        formCode: {
          systemCode: 'FA (3)',
          schemaVersion: '1-0E',
          value: 'FA',
        },
        encryption: {
          encryptedSymmetricKey: encryptSymmetricKeyWithRsaOaep(key, symmetricKeyPem),
          initializationVector: iv.toString('base64'),
        },
      }),
      this.retryOpts,
    )

    const sendResult = await withHttpRetry(
      () => sendOnlineInvoice(this.http, session!.accessToken, openResult.referenceNumber, {
        invoiceHash,
        invoiceSize: xmlBytes.length,
        encryptedInvoiceHash,
        encryptedInvoiceSize: encryptedXml.length,
        encryptedInvoiceContent: encryptedXml.toString('base64'),
        offlineMode: false,
      }),
      this.retryOpts,
    )

    if (process.env['KSEF_DEBUG']) {
      console.error('[ksef-debug] returning send result...')
    }

    return {
      ksefReferenceNumber: sendResult.referenceNumber,
      onlineSessionReferenceNumber: openResult.referenceNumber,
      timestamp: new Date().toISOString(),
    }
  }

  async getUpo(params: {
    token: string
    ksefReferenceNumber: string
    onlineSessionReferenceNumber: string
  }): Promise<{ xml: string; status: 'confirmed' | 'pending' | 'rejected' }> {
    let session = decodeSessionToken(params.token)
    if (!session) {
      throw new Error('KsefHttpClient.getUpo: invalid session token')
    }
    if (shouldRefresh(session)) {
      session = await withHttpRetry(
        () => refreshAccessToken(this.http, session as ActiveSession),
        this.retryOpts,
      )
    }

    try {
      const invoiceStatus = await withHttpRetry(
        () =>
          fetchInvoiceStatus(this.http, {
            accessToken: session!.accessToken,
            sessionReferenceNumber: params.onlineSessionReferenceNumber,
            invoiceReferenceNumber: params.ksefReferenceNumber,
          }),
        this.retryOpts,
      )

      const mapStatus = upoStatusFromCode(invoiceStatus.statusCode)

      if (process.env['KSEF_DEBUG']) {
        console.error('[ksef-debug] invoice status:', JSON.stringify(invoiceStatus))
      }

      if (invoiceStatus.upoDownloadUrl) {
        const response = await this.http.request<string>({
          method: 'GET',
          url: invoiceStatus.upoDownloadUrl,
          responseType: 'text',
          headers: {},
        })
        return { xml: response, status: mapStatus }
      }

      return { xml: '', status: mapStatus }
    } catch (error: unknown) {
      if (error instanceof KsefApiError && error.detailCode === '21178') {
        return { xml: '', status: 'pending' }
      }
      throw error
    }
  }
}
