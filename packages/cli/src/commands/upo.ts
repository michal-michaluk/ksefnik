import type { Command } from 'commander'
import { writeFileSync } from 'node:fs'
import { createKsefnik } from '@ksefnik/core'
import { KsefAuthError } from '@ksefnik/http'
import { resolveAdapter, resolveConfig, type CliGlobalOpts } from '../utils/config.js'
import { output } from '../utils/output.js'

export function registerUpoCommand(program: Command): void {
  program
    .command('upo <ksefReference>')
    .description('Fetch UPO (Urzędowe Poświadczenie Odbioru) for an invoice')
    .option('--save <path>', 'Save UPO XML to file')
    .option('--format <format>', 'Output format: json|text', 'json')
    .action(async (ksefReference: string, opts: { save?: string; format: string }) => {
      const globalOpts = program.opts<CliGlobalOpts>()
      const config = resolveConfig(globalOpts)
      const adapter = resolveAdapter(globalOpts, config)
      const ksef = createKsefnik({ config, adapter })

      try {
        const result = await ksef.invoices.getUpo(ksefReference)

        if (opts.save) {
          writeFileSync(opts.save, result.upoXml, 'utf-8')
        }

        if (opts.format === 'text') {
          console.log(`KSeF reference: ${result.ksefReference}`)
          console.log(`Status: ${result.status}`)
          if (opts.save) console.log(`UPO XML saved: ${opts.save}`)
        } else {
          output(result)
        }
      } catch (error) {
        if (error instanceof KsefAuthError) {
          const status = error.statusCode ?? '?'
          throw new Error(
            `KSeF authentication failed (status ${status}): ${error.message}. ` +
              'Verify --token / KSEFNIK_TOKEN and that the token is valid for this environment.',
          )
        }
        throw error
      } finally {
        if (adapter.closeSession) {
          await adapter.closeSession()
        }
      }
    })
}
