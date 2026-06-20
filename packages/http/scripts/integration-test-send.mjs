// Integration test: send invoice to KSeF test environment
// Usage: node --env-file=.env packages/http/scripts/integration-test-send.mjs
// (run from repo root ksef/ksefnik/)
import { readFileSync } from 'node:fs'
import { KsefHttpClient } from '../dist/client.js'

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`[test] Missing env: ${name}`)
    process.exit(2)
  }
  return value
}

async function main() {
  const nip = required('KSEF_TEST_NIP')
  const token = required('KSEF_TEST_TOKEN')

  const pemPath = process.env['KSEF_TEST_PUBLIC_KEY_PATH']
  const publicKeyPem = pemPath ? readFileSync(pemPath, 'utf8') : undefined
  const envName = process.env['KSEF_ENV'] ?? 'test'

  const client = new KsefHttpClient({
    environment: envName,
    publicKeyPem,
  })

  console.log(`[test] NIP=${nip}  env=${envName}`)

  // 1. Init session
  console.log('[test] 1. initSession…')
  const session = await client.initSession({ nip, environment: envName, token })
  console.log(`[test]    session OK: ref=${session.referenceNumber}`)

  // 2. Read sample FA(3) XML and fix seller NIP and invoice number
  const samplePath = process.argv[2] || '../fa3-samples/Przykładowe pliki dla struktury logicznej e-Faktury FA(3)/FA_3_Przykład_1.xml'
  let invoiceXml = readFileSync(samplePath, 'utf8')
  // KSeF validates sender NIP matches session context; replace sample NIP with ours
  invoiceXml = invoiceXml.replace('<NIP>9999999999</NIP>', `<NIP>${nip}</NIP>`)
  // Make invoice number unique to avoid duplicate detection (440)
  const uniqueId = Date.now().toString(36)
  invoiceXml = invoiceXml.replace('<P_2>FV2026/02/150</P_2>', `<P_2>FV2026/02/${uniqueId}</P_2>`)
  console.log(`[test] 2. invoice XML loaded: ${invoiceXml.length} chars (seller NIP=${nip})`)

  // 3. Send invoice
  console.log('[test] 3. sendInvoice…')
  const result = await client.sendInvoice({ token: session.token, xml: invoiceXml })
  console.log(`[test]    sendInvoice OK:`)
  console.log(`[test]    ksefReferenceNumber: ${result.ksefReferenceNumber}`)
  console.log(`[test]    timestamp: ${result.timestamp}`)

  // 4. Poll for UPO
  console.log('[test] 4. polling getUpo…')
  for (let attempt = 1; attempt <= 10; attempt++) {
    await new Promise(r => setTimeout(r, 2000))
    const upo = await client.getUpo({ token: session.token, ksefReferenceNumber: result.ksefReferenceNumber })
    console.log(`[test]    attempt ${attempt}: status=${upo.status}`)
    if (upo.status === 'confirmed') {
      console.log(`[test]    UPO confirmed! (${upo.xml.length} chars)`)
      break
    }
    if (upo.status === 'rejected') {
      console.log(`[test]    UPO rejected!`)
      console.log(upo.xml)
      break
    }
  }

  // 5. Cleanup
  console.log('[test] 5. terminateSession…')
  await client.terminateSession(session.token)
  console.log('[test] ✅ PASS')
}

main().catch(err => {
  console.error('[test] ❌ FAILED:', err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  process.exit(1)
})
