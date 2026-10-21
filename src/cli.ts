import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { evaluateCall } from './options/evaluate.ts';
import { applyLiveContext, type LiveContextResult, liveContextHeader, renderLiveContext } from './options/live-context.ts';
import { PASTE_TEMPLATE, parseContractText } from './options/parse.ts';
import { renderEvaluation } from './options/render.ts';
import { runScanCommand } from './scanner/command.ts';

const HELP = `market-scanner - research tool (no brokerage connection, no orders)

Commands:
  option   Evaluate a call option from pasted contract details (works offline)
  scan     Morning scan: "scan crypto" (CoinGecko) or "scan stocks" (US stocks, Massive
           end-of-day bars). Synthetic fixture by default; --live for real data.

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
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function runOption(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: 'string', short: 'f' },
      text: { type: 'string' },
      now: { type: 'string' },
      json: { type: 'boolean', default: false },
      template: { type: 'boolean', default: false },
      'live-context': { type: 'boolean', default: false },
    },
  });
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
    text = readFileSync(values.file, 'utf8');
    inputDescription = `text file "${values.file}"`;
  } else if (values.text !== undefined) {
    text = values.text;
    inputDescription = 'text passed with --text';
  } else {
    text = await readStdin();
    inputDescription = 'pasted text';
  }
  if (text.trim() === '') {
    console.error('No contract details received.\n');
    console.error(HELP);
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
    default:
      console.log(HELP);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
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
