// Generate a KSeF test token with InvoiceWrite permission
// Usage: node --env-file=.env packages/http/scripts/generate-token.mjs
import { readFileSync } from 'node:fs'
import { KsefHttpClient } from '../dist/client.js'
import { HttpClient } from '../dist/http.js'

async function main() {
  const nip = process.env['KSEF_TEST_NIP'] || '6436306444'
  const existingToken = process.env['KSEF_TEST_TOKEN']
  if (!existingToken) {
    console.error('Set KSEF_TEST_TOKEN in .env')
    process.exit(1)
  }

  const client = new KsefHttpClient({ environment: 'test' })
  const session = await client.initSession({ nip, environment: 'test', token: existingToken })
  console.log('Auth session:', session.referenceNumber)

  // Decode the token to get the raw access token
  const parts = session.token.split('||')
  const accessToken = parts[1]
  console.log('Access token length:', accessToken.length)

  const http = new HttpClient({ baseUrl: 'https://api-test.ksef.mf.gov.pl/v2' })

  // Generate token with InvoiceWrite permission
  const generateResp = await http.request({
    method: 'POST',
    path: '/tokens',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: {
      permissions: ['InvoiceRead', 'InvoiceWrite', 'Introspection'],
      description: 'Token for invoice send testing',
    },
  })
  console.log('Generate response:', JSON.stringify(generateResp, null, 2))

  // Poll until active
  const ref = generateResp.referenceNumber
  console.log('Token ref:', ref)

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const status = await http.request({
      method: 'GET',
      path: `/tokens/${ref}`,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    console.log(`Poll ${i+1}: status=${status.status}, token=${status.token || '(not yet)'}`)
    if (status.status === 'ACTIVE' && status.token) {
      console.log('\n=== NEW TOKEN ===')
      console.log(status.token)
      console.log('=================\n')
      break
    }
  }

  await client.terminateSession(session.token)
}

main().catch(err => {
  console.error('FAILED:', err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  process.exit(1)
})
