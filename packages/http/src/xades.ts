import forge from 'node-forge'
import { setNodeDependencies } from 'xadesjs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

setNodeDependencies({ DOMParser, XMLSerializer })

import { SignedXml, Application, Parse } from 'xadesjs'
import { webcrypto as nodeWebcrypto, createPrivateKey } from 'node:crypto'

Application.setEngine('NodeJS', nodeWebcrypto as unknown as Crypto)

const AUTH_TOKEN_NS = 'http://ksef.mf.gov.pl/auth/token/2.0'

// Register organizationIdentifier OID (2.5.4.97) used by KSeF test certificates
forge.pki.oids['2.5.4.97'] = 'organizationIdentifier'
forge.pki.oids['organizationIdentifier'] = '2.5.4.97'

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildAuthTokenRequestXml(challenge: string, nip: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<AuthTokenRequest xmlns="${escapeXml(AUTH_TOKEN_NS)}">` +
    `<Challenge>${escapeXml(challenge)}</Challenge>` +
    `<ContextIdentifier><Nip>${escapeXml(nip)}</Nip></ContextIdentifier>` +
    `<SubjectIdentifierType>certificateSubject</SubjectIdentifierType>` +
    `</AuthTokenRequest>`
  )
}

export function generateSelfSignedCert(nip: string): {
  certPem: string
  keyPem: string
} {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString(16)
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
  cert.validity.notBefore.setHours(cert.validity.notBefore.getHours() - 1)

  const attrs = [
    { name: 'organizationName', value: 'KSeF SDK Test' },
    { name: 'commonName', value: 'KSeF SDK Test' },
    { name: 'countryName', value: 'PL' },
    { name: 'organizationIdentifier', value: `VATPL-${nip}` },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([{ name: 'basicConstraints', cA: false }])

  cert.sign(keys.privateKey, forge.md.sha256.create())

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  }
}

export async function signXml(xml: string, certPem: string, keyPem: string): Promise<string> {
  const doc = Parse(xml)
  const root = doc.documentElement!

  const signedXml = new SignedXml(doc)

  // Convert key PEM (legacy RSA format from node-forge) to PKCS8 DER
  const pkcs8Der = createPrivateKey(keyPem).export({ type: 'pkcs8', format: 'der' })

  const signingKey = await nodeWebcrypto.subtle.importKey(
    'pkcs8',
    pkcs8Der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const certB64 = certPem
    .replace(/-----BEGIN [\w ]+-----/g, '')
    .replace(/-----END [\w ]+-----/g, '')
    .replace(/\s+/g, '')

  // Use type assertion to work around xadesjs type issues
  const signArgs: [any, any, any, any] = [
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    signingKey,
    root as any,
    {
      references: [
        {
          uri: '',
          hash: 'SHA-256',
          transforms: ['enveloped'],
        },
      ],
      x509: [certB64],
      signingCertificateV2: { certificate: certB64 },
    },
  ]
  await (signedXml as any).Sign(...signArgs)

  return (signedXml as any).toString()
}
