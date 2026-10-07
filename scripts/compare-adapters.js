#!/usr/bin/env node
/*
 * Compares axios' http adapter against the fetch adapter when talking to
 * MarineTraffic. Run it from the plugin directory so `require('axios')`
 * resolves the same copy the plugin uses:
 *
 *   node scripts/compare-adapters.js
 *
 * Options (env vars):
 *   REPEATS=3   number of requests per URL per adapter
 *   URLS=...    comma separated URLs to test (defaults to a few MT endpoints)
 */

const axios = require('axios')

const HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'close',
  'Cache-Control': 'no-cache',
  Host: 'www.marinetraffic.com',
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  Referer: 'https://www.marinetraffic.com/',
  'Sec-Ch-Ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  'X-Requested-With': 'XMLHttpRequest'
}

const DEFAULT_URLS = [
  'https://www.marinetraffic.com/getData/get_data_json_4/z:10/X:248/Y:201/station:0',
  'https://www.marinetraffic.com/en/vessels/125133/general',
  'https://www.marinetraffic.com/en/vessels/125133/position?cb=_1'
]

const REPEATS = Number(process.env.REPEATS || 3)
const URLS = process.env.URLS ? process.env.URLS.split(',') : DEFAULT_URLS

const BLOCK_RE = /unable to access|Attention Required|Just a moment|cf-error|cf-wrapper|Cloudflare/i

function describe(data) {
  if (typeof data === 'string') return data
  return JSON.stringify(data)
}

async function probe(adapter, url) {
  try {
    const res = await axios.get(url, {
      headers: HEADERS,
      adapter,
      timeout: 20000,
      // Resolve on any status so we can compare 403s instead of catching them.
      validateStatus: () => true
    })
    const body = describe(res.data)
    return {
      adapter,
      status: res.status,
      server: res.headers['server'],
      cfCache: res.headers['cf-cache-status'],
      blocked: BLOCK_RE.test(body),
      preview: body.slice(0, 70).replace(/\s+/g, ' ')
    }
  } catch (err) {
    return { adapter, error: err.message, code: err.code }
  }
}

async function main() {
  const summary = { http: { ok: 0, blocked: 0, error: 0 }, fetch: { ok: 0, blocked: 0, error: 0 } }

  for (const url of URLS) {
    console.log('\n' + url)
    for (const adapter of ['http', 'fetch']) {
      for (let i = 0; i < REPEATS; i++) {
        const r = await probe(adapter, url)
        let verdict
        if (r.error) {
          verdict = 'error'
          summary[adapter].error++
        } else if (r.status === 403 || r.blocked) {
          verdict = 'BLOCKED'
          summary[adapter].blocked++
        } else {
          verdict = 'ok'
          summary[adapter].ok++
        }
        console.log(
          `  ${adapter.padEnd(5)} ${verdict.padEnd(8)} ` +
            (r.error
              ? `${r.code || ''} ${r.error}`
              : `status=${r.status} server=${r.server || '-'} cf=${r.cfCache || '-'} ${r.preview}`)
        )
      }
    }
  }

  console.log('\n===== summary =====')
  for (const adapter of ['http', 'fetch']) {
    const s = summary[adapter]
    console.log(`${adapter.padEnd(5)}  ok=${s.ok}  blocked=${s.blocked}  error=${s.error}`)
  }
  console.log(
    '\nIf http is mostly ok and fetch is mostly blocked, the fetch adapter ' +
      '(undici) is being fingerprinted by Cloudflare.'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
