/**
 * Thrown by the lexer and parser for a formula Tableau syntax that cannot be read.
 * `position` is the 0-based character offset; `line` and `column` are 1-based.
 */
export class CalcSyntaxError extends Error {
	/**
	 * @param {string} message
	 * @param {number} position
	 * @param {string} [text] The formula, used to compute line and column
	 */
	constructor(message, position, text) {
		const { line, column } = lineColumn(text ?? '', position);
		super(`${message} (line ${line}, column ${column})`);
		this.name = 'CalcSyntaxError';
		this.reason = message;
		this.position = position;
		this.line = line;
		this.column = column;
	}
}

function lineColumn(text, offset) {
	let line = 1;
	let column = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\n') {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return { line, column };
}
