import pkg from './../package.json';
import { Command } from 'commander';
import { check, convert, format } from './lib/parser';
import { configparser } from './lib/configparser';
import { kulalaCore } from './lib/kulala-core';
const program = new Command();

program
  .name('kulala-fmt')
  .description('An opinionated 🦄 .http and .rest 🐼 files linter 💄 and formatter ⚡.')
  .version(pkg.version);

program
  .command('fix')
  .alias('format')
  .description('Format files')
  .argument('[files...]', 'files or directories to include')
  .option('--no-body', 'skip formatting the body')
  .option('--stdin', 'read input from stdin, print output to stdout', false)
  .action(async (files: string[], options) => {
    await format(files, options);
  });

program
  .command('check')
  .description('Check if files are well formatted')
  .argument('[files...]', 'files or directories to include')
  .option('-q, --quiet', 'suppress diff output', false)
  .option('--no-body', 'skip formatting the body when checking')
  .option('--stdin', 'read input from stdin', false)
  .action(async (files: string[], options) => {
    await check(files, options);
  });

program
  .command('convert')
  .description('Convert between HTTP and other API formats')
  .argument('<files...>', 'files to include')
  .option('--from <value>', 'source format (openapi, postman, bruno, http)', 'openapi')
  .option('--to <value>', 'destination format (http, postman)', 'http')
  .option('--env <path>', 'environment file for variable injection (.env or http-client.env.json)')
  .option('-o, --output <path>', 'output file path')
  .action(async (files, options) => {
    await convert(options, files);
  });

program
  .command('init')
  .description('initialize a new kulala-fmt.yaml file')
  .action(() => {
    configparser.init();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync();
  } finally {
    kulalaCore.release();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
