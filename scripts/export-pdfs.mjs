#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { chromium } from 'playwright'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const XSL = resolve(scriptDir, '../../schemas/crd/styl.xsl')

const inputDir = process.argv[2] || process.cwd()

if (!existsSync(XSL)) {
  console.error(`XSL stylesheet not found: ${XSL}`)
  process.exit(1)
}

async function main() {
  const findOut = execSync(`find "${inputDir}" -name "*.xml" -type f`, { encoding: 'utf-8' })
  const xmlFiles = findOut.trim().split('\n').filter(Boolean)

  if (xmlFiles.length === 0) {
    console.log('No XML files found in', inputDir)
    return
  }

  const browser = await chromium.launch()
  try {
    for (const xmlPath of xmlFiles) {
      const pdfPath = xmlPath.replace(/\.xml$/, '.pdf')
      if (existsSync(pdfPath)) {
        console.log(`SKIP: ${pdfPath}`)
        continue
      }

      console.log(`→ ${xmlPath}`)
      const html = execSync(`xsltproc "${XSL}" "${xmlPath}"`, { encoding: 'utf-8', timeout: 15000 })
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle' })
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true })
      await page.close()
      console.log(`  PDF: ${pdfPath} (${readFileSync(pdfPath).length} bytes)`)
    }
  } finally {
    await browser.close()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
