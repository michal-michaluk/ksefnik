import type { KsefSendInvoiceRequest, KsefOpenOnlineSessionRequest, KsefOpenOnlineSessionResponse, KsefSendInvoiceResponse } from './generated/index.js'
import { PATHS } from './endpoints.js'
import type { HttpClient } from './http.js'

export async function openOnlineSession(
  http: HttpClient,
  accessToken: string,
  body: KsefOpenOnlineSessionRequest,
): Promise<KsefOpenOnlineSessionResponse> {
  return http.request<KsefOpenOnlineSessionResponse>({
    method: 'POST',
    path: PATHS.sessionsOnline,
    headers: { Authorization: `Bearer ${accessToken}` },
    body,
  })
}

export async function sendOnlineInvoice(
  http: HttpClient,
  accessToken: string,
  sessionReferenceNumber: string,
  body: KsefSendInvoiceRequest,
): Promise<KsefSendInvoiceResponse> {
  return http.request<KsefSendInvoiceResponse>({
    method: 'POST',
    path: PATHS.sessionSendInvoice(sessionReferenceNumber),
    headers: { Authorization: `Bearer ${accessToken}` },
    body,
  })
}

export async function closeOnlineSession(
  http: HttpClient,
  accessToken: string,
  sessionReferenceNumber: string,
): Promise<void> {
  await http.request<unknown>({
    method: 'POST',
    path: PATHS.sessionClose(sessionReferenceNumber),
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}
