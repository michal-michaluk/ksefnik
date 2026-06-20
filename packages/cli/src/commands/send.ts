import type { Command } from 'commander'
import { readFileSync, writeFileSync } from 'node:fs'
import { createKsefnik } from '@ksefnik/core'
import { resolveAdapter, resolveConfig, type CliGlobalOpts } from '../utils/config.js'
import { output } from '../utils/output.js'

async function fetchUpoWithRetry(
  ksef: ReturnType<typeof createKsefnik>,
  ksefReference: string,
  maxRetries = 3,
  delayMs = 2000,
): Promise<{ upoXml: string; status: string } | null> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const upo = await ksef.invoices.getUpo(ksefReference)
      if (upo.status !== 'pending' || i === maxRetries - 1) {
        return upo
      }
      await new Promise((r) => setTimeout(r, delayMs))
    } catch {
      return null
    }
  }
  return null
}

export function registerSendCommand(program: Command): void {
  program
    .command('send <filePath>')
    .description('Send invoice XML to KSeF')
    .option('--format <format>', 'Output format: json|text', 'json')
    .option('--no-upo', 'Skip fetching UPO after sending')
    .option('--save-upo <path>', 'Save UPO XML to file (default: {invoice}.upo.xml)')
    .action(async (filePath: string, opts: { format: string; upo: boolean; saveUpo?: string }) => {
      const globalOpts = program.opts<CliGlobalOpts>()
      const config = resolveConfig(globalOpts)
      const adapter = resolveAdapter(globalOpts, config)
      const ksef = createKsefnik({ config, adapter })

      const xml = readFileSync(filePath, 'utf-8')
      const result = await ksef.invoices.send({ xml, nip: config.nip })

      if (opts.format === 'text') {
        console.log(`KSeF reference: ${result.ksefReference}`)
        console.log(`Timestamp: ${result.timestamp}`)
      } else {
        output(result)
      }

      if (opts.upo) {
        const upo = await fetchUpoWithRetry(ksef, result.ksefReference)
        if (upo && upo.upoXml) {
          const upoPath = opts.saveUpo ?? filePath.replace(/\.[^/.]+$/, '') + '.upo.xml'
          writeFileSync(upoPath, upo.upoXml, 'utf-8')
          if (opts.format === 'text') {
            console.log(`UPO status: ${upo.status}`)
            console.log(`UPO saved: ${upoPath}`)
          } else {
            output({ ...upo, upoPath })
          }
        } else if (opts.format === 'text') {
          console.log('UPO: unavailable (session may have expired)')
        }
      }
    })
}
