// Bootstrap KSeF test environment: generate test token without Python dependency
// Usage: node --env-file=.env packages/http/scripts/bootstrap.mjs
//
// Flow:
//   1. Generate self-signed RSA 2048 cert (node-forge)
//   2. POST /auth/challenge
//   3. Build + XAdES-sign AuthTokenRequest XML
//   4. POST /auth/xades-signature → get auth token
//   5. Poll auth status until ready
//   6. POST /auth/token/redeem → get access+refresh tokens
//   7. POST /tokens with InvoiceWrite → generate test token
//   8. Persist to .env

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TEST_BASE_URL = 'https://api-test.ksef.mf.gov.pl/v2'

// NIP checksum weights: 6,5,7,2,3,4,5,6,7
function randomValidNip() {
  for (;;) {
    const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
    const sum = d[0]*6 + d[1]*5 + d[2]*7 + d[3]*2 + d[4]*3 + d[5]*4 + d[6]*5 + d[7]*6 + d[8]*7
    const check = sum % 11
    if (check < 10) {
      d.push(check)
      return d.join('')
    }
    // checksum 10 → invalid NIP, retry
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function readNipFromEnvFile() {
  const envPath = process.env.KSEF_ENV_PATH || resolve(__dirname, '../../../.env')
  if (!existsSync(envPath)) return null
  const content = readFileSync(envPath, 'utf8')
  const m = content.match(/^KSEF_TEST_NIP=(\d+)/m)
  return m ? m[1] : null
}

async function main() {
  const nip = process.env['KSEF_TEST_NIP'] || readNipFromEnvFile() || randomValidNip()

  console.log(`[bootstrap] NIP=${nip}  env=test`)

  // 1. Generate self-signed certificate
  console.log('[bootstrap] 1. generating self-signed certificate…')
  const { generateSelfSignedCert, buildAuthTokenRequestXml, signXml } = await import('../dist/xades.js')
  const { certPem, keyPem } = generateSelfSignedCert(nip)
  console.log('[bootstrap]    certificate generated (RSA 2048, SHA-256)')

  // 2. Get challenge (POST)
  console.log('[bootstrap] 2. fetching auth challenge…')
  const challengeResp = await fetch(`${TEST_BASE_URL}/auth/challenge`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  })
  if (!challengeResp.ok) {
    const body = await challengeResp.text()
    console.error(`[bootstrap]    challenge failed: ${challengeResp.status} ${body.substring(0, 200)}`)
    process.exit(1)
  }
  const challengeData = await challengeResp.json()
  const challenge = challengeData.challenge
  console.log(`[bootstrap]    challenge: ${challenge.substring(0, 20)}…`)

  // 3. Build and sign XML
  console.log('[bootstrap] 3. building XAdES-signed AuthTokenRequest…')
  const unsignedXml = buildAuthTokenRequestXml(challenge, nip)
  const signedXml = await signXml(unsignedXml, certPem, keyPem)
  console.log(`[bootstrap]    signed XML: ${signedXml.length} bytes`)

  // 4. POST XAdES auth
  console.log('[bootstrap] 4. authenticating via XAdES…')
  const authResp = await fetch(
    `${TEST_BASE_URL}/auth/xades-signature?verifyCertificateChain=false`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: signedXml,
    },
  )
  if (!authResp.ok) {
    const body = await authResp.text()
    console.error(`[bootstrap]    auth failed: ${authResp.status} ${body.substring(0, 300)}`)
    process.exit(1)
  }
  const authData = await authResp.json()
  const authToken = authData.authenticationToken?.token
  const authRef = authData.referenceNumber
  if (!authToken || !authRef) {
    console.error(`[bootstrap]    unexpected auth response: ${JSON.stringify(authData)}`)
    process.exit(1)
  }
  console.log(`[bootstrap]    auth initiated: ref=${authRef}`)

  // 5. Poll auth status
  console.log('[bootstrap] 5. polling auth status…')
  let authReady = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const statusResp = await fetch(`${TEST_BASE_URL}/auth/${authRef}`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: 'application/json',
      },
    })
    if (!statusResp.ok) continue
    const statusData = await statusResp.json()
    const code = statusData.status?.code ?? statusData.statusCode
    console.log(`   poll ${i + 1}: code=${code} desc='${statusData.status?.description ?? ''}'`)
    if (code >= 200) {
      if (code >= 400) {
        console.error(`[bootstrap]    auth failed: ${statusData.status?.description ?? statusData.statusDescription}`)
        process.exit(1)
      }
      authReady = true
      break
    }
  }
  if (!authReady) {
    console.error('[bootstrap]    auth polling timed out')
    process.exit(1)
  }
  console.log('[bootstrap]    authentication complete!')

  // 6. Redeem token (POST with auth header, no body)
  console.log('[bootstrap] 6. redeeming access token…')
  const redeemResp = await fetch(`${TEST_BASE_URL}/auth/token/redeem`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
  })
  if (!redeemResp.ok) {
    const body = await redeemResp.text()
    console.error(`[bootstrap]    redeem failed: ${redeemResp.status} ${body.substring(0, 300)}`)
    process.exit(1)
  }
  const redeemData = await redeemResp.json()
  const accessToken = redeemData.accessToken?.token
  const refreshToken = redeemData.refreshToken?.token
  if (!accessToken) {
    console.error(`[bootstrap]    unexpected redeem response: ${JSON.stringify(redeemData)}`)
    process.exit(1)
  }
  console.log('[bootstrap]    access token obtained')

  // 7. Generate InvoiceWrite token
  console.log('[bootstrap] 7. generating token with InvoiceWrite…')
  const tokenResp = await fetch(`${TEST_BASE_URL}/tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      permissions: ['InvoiceRead', 'InvoiceWrite', 'Introspection'],
      description: 'KSeF test token for ksefnik integration tests',
    }),
  })
  if (!tokenResp.ok) {
    const body = await tokenResp.text()
    console.error(`[bootstrap]    token gen failed: ${tokenResp.status} ${body.substring(0, 300)}`)
    process.exit(1)
  }
  const tokenInitData = await tokenResp.json()
  const ksefToken = tokenInitData.token
  if (!ksefToken) {
    console.error(`[bootstrap]    no token in response: ${JSON.stringify(tokenInitData)}`)
    process.exit(1)
  }
  console.log(`[bootstrap]    token generated (${ksefToken.substring(0, 30)}…)`)

  console.log()
  console.log('========================================')
  console.log('  KSeF Test Token Generated!')
  console.log('========================================')
  console.log()
  console.log(ksefToken)
  console.log()
  console.log('========================================')

  // 9. Persist to .env
  const envPath = process.env.KSEF_ENV_PATH || resolve(__dirname, '../../../.env')
  let envContent = ''
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf8')
    // Ensure KSEF_TEST_NIP is set
    if (!envContent.includes('KSEF_TEST_NIP=')) {
      envContent = `KSEF_TEST_NIP=${nip}\nKSEF_ENV=test\n` + envContent
    }
    // Update token line
    if (envContent.includes('KSEF_TEST_TOKEN=')) {
      envContent = envContent.replace(/^KSEF_TEST_TOKEN=.*$/m, `KSEF_TEST_TOKEN=${ksefToken}`)
    } else {
      envContent += `\nKSEF_TEST_TOKEN=${ksefToken}\n`
    }
  } else {
    envContent = `# KSeF test credentials\nKSEF_TEST_NIP=${nip}\nKSEF_TEST_TOKEN=${ksefToken}\nKSEF_ENV=test\n`
  }
  writeFileSync(envPath, envContent)
  console.log(`[bootstrap]    .env updated at ${envPath}`)

  console.log('[bootstrap] ✅ bootstrap complete!')
}

main().catch(err => {
  console.error('[bootstrap] ❌ FAILED:', err)
  process.exit(1)
})
