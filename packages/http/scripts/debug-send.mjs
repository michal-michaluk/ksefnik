// Debug script: step-by-step send invoice with full logging
// Usage: KSEF_DEBUG=1 node --env-file=.env packages/http/scripts/debug-send.mjs
import { readFileSync } from 'node:fs'
import { KsefHttpClient } from '../dist/client.js'
import { HttpClient } from '../dist/http.js'
import { openOnlineSession, sendOnlineInvoice, closeOnlineSession } from '../dist/send-invoice.js'
import { generateAesKey, encryptAes256Cbc, sha256Base64, encryptSymmetricKeyWithRsaOaep } from '../dist/crypto.js'
import { fetchKsefTokenEncryptionKey } from '../dist/public-key.js'

function required(name) {
  const value = process.env[name]
  if (!value) { console.error(`[test] Missing env: ${name}`); process.exit(2) }
  return value
}

async function main() {
  const nip = required('KSEF_TEST_NIP')
  const token = required('KSEF_TEST_TOKEN')

  const client = new KsefHttpClient({ environment: 'test' })
  const session = await client.initSession({ nip, environment: 'test', token })
  console.log('Auth session:', session.referenceNumber)

  // Decode token to get raw access/refresh tokens
  const parts = session.token.split('||')
  const accessToken = parts[1]
  console.log('Access token length:', accessToken.length)

  const http = new HttpClient({ baseUrl: 'https://api-test.ksef.mf.gov.pl/v2' })

  // Read sample XML
  const samplePath = process.argv[2] || '../fa3-samples/Przykładowe pliki dla struktury logicznej e-Faktury FA(3)/FA_3_Przykład_1.xml'
  const invoiceXml = readFileSync(samplePath, 'utf8')
  console.log('XML length:', invoiceXml.length)

  // Fetch public key PEM
  const publicKeyPem = process.env.KSEF_TEST_PUBLIC_KEY_PATH
    ? readFileSync(process.env.KSEF_TEST_PUBLIC_KEY_PATH, 'utf8')
    : await fetchKsefTokenEncryptionKey(http)
  console.log('Public key PEM length:', publicKeyPem.length)
  console.log('Public key PEM line 1:', publicKeyPem.split('\n')[0])

  // Generate encryption
  const { key, iv } = generateAesKey()
  const xmlBytes = Buffer.from(invoiceXml, 'utf8')
  const encryptedXml = encryptAes256Cbc(xmlBytes, key, iv)
  const invoiceHash = sha256Base64(xmlBytes)
  const encryptedInvoiceHash = sha256Base64(encryptedXml)

  console.log('key length:', key.length)
  console.log('iv length:', iv.length)
  console.log('iv base64:', iv.toString('base64'))
  const encryptedKey = encryptSymmetricKeyWithRsaOaep(key, publicKeyPem)
  console.log('encryptedSymmetricKey length:', encryptedKey.length)
  console.log('invoiceHash:', invoiceHash)
  console.log('encryptedInvoiceHash:', encryptedInvoiceHash)
  console.log('invoiceSize:', xmlBytes.length)
  console.log('encryptedInvoiceSize:', encryptedXml.length)

  // Step 1: Open online session
  console.log('\n--- Step 1: openOnlineSession ---')
  const openResult = await openOnlineSession(http, accessToken, {
    formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
    encryption: {
      encryptedSymmetricKey: encryptedKey,
      initializationVector: iv.toString('base64'),
    },
  })
  console.log('Open result:', JSON.stringify(openResult))

  // Step 2: Send invoice
  console.log('\n--- Step 2: sendOnlineInvoice ---')
  const sendResult = await sendOnlineInvoice(http, accessToken, openResult.referenceNumber, {
    invoiceHash,
    invoiceSize: xmlBytes.length,
    encryptedInvoiceHash,
    encryptedInvoiceSize: encryptedXml.length,
    encryptedInvoiceContent: encryptedXml.toString('base64'),
    offlineMode: false,
  })
  console.log('Send result:', JSON.stringify(sendResult))

  // Step 3: Check invoice status immediately (before close)
  console.log('\n--- Step 3: invoice status (before close) ---')
  try {
    const status = await http.request({
      method: 'GET',
      path: `/sessions/${openResult.referenceNumber}/invoices/${sendResult.referenceNumber}`,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    console.log('Status:', JSON.stringify(status, null, 2))
  } catch (e) {
    console.error('Status error:', e.message)
  }

  // Step 4: Close session
  console.log('\n--- Step 4: closeOnlineSession ---')
  try {
    await closeOnlineSession(http, accessToken, openResult.referenceNumber)
    console.log('Session closed successfully')
  } catch (e) {
    console.error('Close error:', e.detailCode, e.message)
    if (e.context) console.error('Close context:', JSON.stringify(e.context, null, 2))
  }

  // Step 5: Check invoice status (after close)
  console.log('\n--- Step 5: invoice status (after close) ---')
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000))
    try {
      const status = await http.request({
        method: 'GET',
        path: `/sessions/${openResult.referenceNumber}/invoices/${sendResult.referenceNumber}`,
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      console.log(`Poll ${i+1}:`, JSON.stringify(status, null, 2))
      if (status.upoDownloadUrl) {
        console.log('UPO URL available!')
        break
      }
    } catch (e) {
      console.error(`Poll ${i+1} error:`, e.message)
    }
  }

  // Cleanup
  await client.terminateSession(session.token)
}

main().catch(err => {
  console.error('FAILED:', err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  process.exit(1)
})
