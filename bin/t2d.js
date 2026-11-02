#!/usr/bin/env node
import { main } from '../src/cli/main.js';

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
		process.exitCode = 1;
	}
);
