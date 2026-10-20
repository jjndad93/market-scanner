import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { evaluateCall } from './options/evaluate.ts';
import { PASTE_TEMPLATE, parseContractText } from './options/parse.ts';
import { renderEvaluation } from './options/render.ts';

const HELP = `market-scanner - research tool (no brokerage connection, no orders)

Commands:
  option   Evaluate a call option from pasted contract details (works offline)
  scan     Morning stock + crypto report (not built yet: Stages 2-5)

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
    },
  });

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
  const evaluation = evaluateCall(parsed.contract, parsed.context, { now });
  if (values.json) {
    console.log(JSON.stringify({ input: parsed, evaluation }, null, 2));
  } else {
    console.log(renderEvaluation(evaluation, {
      inputDescription,
      parseWarnings: parsed.warnings,
      unrecognized: parsed.unrecognized,
      markedAsTestData: parsed.markedAsTestData,
    }));
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'option':
      return runOption(rest);
    case 'scan':
      console.log('The morning scanner is not built yet (planned for Stages 2-5, pending review). No data was fetched.');
      return 2;
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
