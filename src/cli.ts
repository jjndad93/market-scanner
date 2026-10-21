import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { evaluateCall } from './options/evaluate.ts';
import { applyLiveContext, type LiveContextResult, liveContextHeader, renderLiveContext } from './options/live-context.ts';
import { PASTE_TEMPLATE, parseContractText } from './options/parse.ts';
import { renderEvaluation } from './options/render.ts';
import { runScanCommand } from './scanner/command.ts';

const HELP = `market-scanner - research tool (no brokerage connection, no orders, not financial advice)

Commands (all offline by default; live data only with an explicit flag):
  scan crypto    Crypto movers and watchlist. Offline: synthetic fixture.
                 Live (--live): CoinGecko, key in COINGECKO_DEMO_API_KEY (free Demo key).
  scan stocks    US stock movers and watchlist (fixed list of 20 large stocks). Offline: fixture.
                 Live (--live): Massive end-of-day bars, key in POLYGON_API_KEY (free plan works).
  scan options   US options discovery and ranking. Offline: fixture.
                 Live (--live): Massive option-chain Snapshot, key in POLYGON_API_KEY on a paid
                 options plan (Options Starter or higher; the free Options Basic plan does NOT).
  option         Evaluate one call option from contract details you supply (always offline,
                 unless --live-context: one Massive request, key in POLYGON_API_KEY).

Common flags: --json (structured output), --max-requests <n> (live scans; retries count),
--symbols A,B (scan options --live), --help (per command; never makes a request).
Keys are read only from environment variables; never put a key in a file in this folder.

More help:
  node src/cli.ts scan --help
  node src/cli.ts scan crypto --help      (also: scan stocks --help, scan options --help)
  node src/cli.ts option --help
`;

const OPTION_HELP = `Evaluate one call option from contract details you supply.

Option usage:
  node src/cli.ts option --file contract.txt
  Get-Content contract.txt | node src/cli.ts option      (PowerShell)
  node src/cli.ts option --template                       (show the fields you can paste)

Option flags:
  --file, -f <path>   read contract details from a text file
  --text <text>       contract details passed inline
  --now <ISO time>    evaluate as of this time instead of now (e.g. 2026-10-20T14:30:00Z)
  --json              print the structured result as JSON
  --template          print an input template and exit
  --live-context      opt-in: one Massive request (needs POLYGON_API_KEY) for the underlying's
                      end-of-day bars, to calculate 20-session historical volatility and trend.
                      Pasted values stay active; fetched values only fill empty fields and are
                      otherwise shown as a cross-check. Not combinable with --now.
  --help, -h          show this help

Without --live-context the option command never uses the network.
Example (offline, runs unchanged): node src/cli.ts option --file examples/hypothetical-contract.txt
`;

/** Plain-language reason a contract file could not be read, with the next step. */
function fileReadError(path: string, e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  const why = code === 'ENOENT' ? 'the file does not exist'
    : code === 'EISDIR' ? 'that path is a folder, not a file'
      : code === 'EACCES' || code === 'EPERM' ? 'permission was denied'
        : `it could not be read (${code ?? (e instanceof Error ? e.message : String(e))})`;
  return `Could not read the contract file "${path}": ${why}. Check the path (relative paths start from the current folder, ${process.cwd()}), `
    + 'or run "node src/cli.ts option --template" to see the fields to put in a text file.';
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function runOption(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        file: { type: 'string', short: 'f' },
        text: { type: 'string' },
        now: { type: 'string' },
        json: { type: 'boolean', default: false },
        template: { type: 'boolean', default: false },
        'live-context': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}. Run "node src/cli.ts option --help" for the supported flags. No request was made.`);
    return 1;
  }
  if (values.help) {
    console.log(OPTION_HELP);
    return 0;
  }
  if (values['live-context'] && values.now) {
    console.error('--now cannot be combined with --live-context: live context uses the latest completed session, so the evaluation must use the current time. No request was made.');
    return 1;
  }

  if (values.template) {
    console.log(PASTE_TEMPLATE);
    return 0;
  }

  let text: string;
  let inputDescription: string;
  if (values.file) {
    try {
      text = readFileSync(values.file, 'utf8');
    } catch (e) {
      console.error(fileReadError(values.file, e));
      return 1;
    }
    inputDescription = `text file "${values.file}"`;
  } else if (values.text !== undefined) {
    text = values.text;
    inputDescription = 'text passed with --text';
  } else {
    text = await readStdin();
    inputDescription = 'pasted text';
  }
  if (text.trim() === '') {
    console.error('No contract details received: the input was empty. Put the contract details in a text file (fields below) and pass it with --file.\n');
    console.error(OPTION_HELP);
    console.error('Template:\n');
    console.error(PASTE_TEMPLATE);
    return 1;
  }

  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now "${values.now}" is not a valid date/time.`);
    return 1;
  }

  const parsed = parseContractText(text.replace(/^﻿/, ''));
  // Stage 4 opt-in only; without --live-context nothing below touches the network or the output.
  let context = parsed.context;
  let live: LiveContextResult | null = null;
  if (values['live-context']) {
    ({ context, result: live } = await applyLiveContext(parsed.contract, parsed.context, {
      env: process.env, fetch: (url, init) => globalThis.fetch(url, init), clock: () => new Date(),
    }));
  }
  const evaluation = evaluateCall(parsed.contract, context, { now });
  if (values.json) {
    console.log(JSON.stringify(live ? { input: parsed, evaluation, liveContext: live } : { input: parsed, evaluation }, null, 2));
  } else {
    console.log(renderEvaluation(evaluation, {
      inputDescription,
      parseWarnings: parsed.warnings,
      unrecognized: parsed.unrecognized,
      markedAsTestData: parsed.markedAsTestData,
      ...(live ? { liveContext: liveContextHeader(live) } : {}),
    }));
    if (live) console.log(`\n${renderLiveContext(live)}`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'option':
      return runOption(rest);
    case 'scan':
      return runScanCommand(rest, {
        env: process.env,
        fetch: (url, init) => globalThis.fetch(url, init),
        clock: () => new Date(),
        out: (text) => console.log(text),
        err: (text) => console.error(text),
      });
    case 'help':
      // `help option`, `help scan [market]`, or plain `help`.
      if (rest[0] === 'option') return runOption(['--help']);
      if (rest[0] === 'scan') return main(['scan', ...(rest[1] ? [rest[1]] : []), '--help']);
      console.log(HELP);
      return 0;
    case undefined:
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command "${command}". Use "scan" or "option".\n`);
      console.error(HELP);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
