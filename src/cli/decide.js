import readline from 'node:readline';
import { choicesFor, describeDecision } from '../pipeline/decisions.js';

const GROUPS = [
	{ title: 'Keeps the data out of Domo (zero copy):', test: (c) => c.copies === false },
	{ title: 'Uses data already in Domo:', test: (c) => c.choice === 'dataset' },
	{ title: 'Copies the data into Domo:', test: (c) => c.copies === true },
	{ title: 'Other:', test: (c) => c.copies === null && c.choice !== 'dataset' }
];

/**
 * The interactive decide callback for extract and migrate, or undefined when the session cannot ask
 * (--unmapped export|fail, --yes, --dry-run, --json, no terminal).
 * @param {import('./main.js').CommandContext} ctx
 */
export function deciderFor(ctx) {
	const { args, reporter, io } = ctx;
	const v = args.values;
	if ((v.unmapped ?? 'ask') !== 'ask' || v.yes || v['dry-run'] || reporter.json) return undefined;
	const stdin = io.stdin ?? process.stdin;
	if (!stdin.isTTY) return undefined;
	return (decisions) => promptDecisions(decisions, { stdin, stderr: io.stderr ?? process.stderr });
}

function lineReader(stdin) {
	const rl = readline.createInterface({ input: stdin, terminal: false });
	const queue = [];
	const waiting = [];
	let closed = false;
	rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : queue.push(line)));
	rl.on('close', () => {
		closed = true;
		while (waiting.length) waiting.shift()(null);
	});
	return {
		next: () => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(null) : new Promise((resolve) => waiting.push(resolve))),
		close: () => rl.close()
	};
}

function prefillFor(decision, choice) {
	if (decision.suggested?.choice === choice) return decision.suggested.id;
	if (choice === 'cloud-amplifier') return decision.cloudAmplifier?.[0]?.integrationId;
	if (choice === 'account') return decision.accounts?.matches?.[0]?.id;
	if (choice === 'federated') return decision.federated?.matches?.[0]?.id;
	return undefined;
}

/**
 * Ask about every decision on stderr, one after the other. Returns the answers given; input ending early
 * leaves the rest unanswered.
 * @param {import('../pipeline/decisions.js').DataDecision[]} decisions
 * @param {{ stdin: any, stderr: { write(s: string): any } }} io
 * @returns {Promise<{ key: string, choice: import('../pipeline/decisions.js').DecisionChoice, id?: string }[]>}
 */
export async function promptDecisions(decisions, { stdin, stderr }) {
	const reader = lineReader(stdin);
	const say = (text = '') => stderr.write(`${text}\n`);
	const ask = async (question) => {
		stderr.write(question);
		const line = await reader.next();
		return line === null ? null : line.trim();
	};
	const answers = [];
	try {
		say('');
		say(`${decisions.length} datasource(s) have no mapping in mappings.json. Choose where each one's data comes from before any data is downloaded.`);
		say('An export copies every row through Tableau and can take a long time. Your answers are saved to mappings.json, so they are not asked again.');
		for (const [i, decision] of decisions.entries()) {
			say('');
			const [head, ...rest] = describeDecision(decision);
			say(`${i + 1}/${decisions.length} ${head}`);
			for (const line of rest) say(line);
			const available = choicesFor(decision);
			for (const group of GROUPS) {
				const choices = available.filter(group.test);
				if (!choices.length) continue;
				say(`  ${group.title}`);
				for (const c of choices) say(`    [${c.letter}] ${c.label}`);
			}
			const fallback = decision.suggested ? available.find((c) => c.choice === decision.suggested.choice) : undefined;
			const suggestedId = decision.suggested?.id;
			const letters = available.map((c) => c.letter).join('/');
			let answer;
			while (!answer) {
				const typed = await ask(`  Choice [${letters}]${fallback ? ` (Enter: ${fallback.letter}${suggestedId !== undefined ? ` ${suggestedId}` : ''})` : ''}: `);
				if (typed === null) return answers;
				if (!typed && fallback) {
					answer = { key: decision.key, choice: fallback.choice, ...(suggestedId !== undefined ? { id: String(suggestedId) } : {}) };
					break;
				}
				const spec = available.find((c) => c.letter === typed.toLowerCase() || c.choice === typed.toLowerCase());
				if (!spec) {
					say(`  Type one of ${letters}.`);
					continue;
				}
				if (!spec.idLabel) {
					answer = { key: decision.key, choice: spec.choice };
					break;
				}
				const prefill = prefillFor(decision, spec.choice);
				const id = await ask(`  ${spec.idLabel}${prefill !== undefined ? ` [${prefill}]` : ''}: `);
				if (id === null) return answers;
				const value = id || (prefill !== undefined ? String(prefill) : '');
				if (!value) {
					say(`  No ${spec.idLabel} given; choose again.`);
					continue;
				}
				answer = { key: decision.key, choice: spec.choice, id: value };
			}
			answers.push(answer);
		}
		say('');
		return answers;
	} finally {
		reader.close();
	}
}
