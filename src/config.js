import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * @typedef {Object} TableauConfig
 * @property {string} server        e.g. https://prod-useast-a.online.tableau.com
 * @property {string} site          Site contentUrl ('' = Default site)
 * @property {string} patName
 * @property {string} patSecret
 * @property {string} [apiVersion]  Pin a REST version; otherwise detected from serverinfo
 *
 * @typedef {Object} DomoConfig
 * @property {string} instance      Subdomain, e.g. 'acme' for acme.domo.com
 * @property {string} accessToken   Developer token (X-DOMO-Developer-Token)
 *
 * @typedef {Object} T2DConfig
 * @property {string|null} env
 * @property {TableauConfig} tableau
 * @property {DomoConfig} domo
 * @property {string} workspace     Root directory for downloads, IR, plans, state
 * @property {string} python        Interpreter for the Hyper sidecar (a path with a separator is resolved against cwd)
 * @property {boolean} pythonExplicit  True when T2D_PYTHON or an override chose the interpreter; otherwise a project .venv may be auto-detected
 */

/**
 * Build config from `.env`, process.env, an optional `.env.<env>`, and explicit overrides, in increasing
 * precedence. Never exits; callers decide what is required.
 *
 * @param {{ env?: string|null, cwd?: string, overrides?: Partial<{tableau: Partial<TableauConfig>, domo: Partial<DomoConfig>, workspace: string, python: string}> }} [opts]
 * @returns {T2DConfig}
 */
export function loadConfig({ env = null, cwd = process.cwd(), overrides = {} } = {}) {
	const sources = [];
	const base = path.join(cwd, '.env');
	const baseValues = fs.existsSync(base) ? dotenv.parse(fs.readFileSync(base)) : {};
	if (env) {
		const envFile = path.join(cwd, `.env.${env}`);
		if (!fs.existsSync(envFile)) throw new ConfigError(`--env "${env}" was given but ${envFile} does not exist`);
		// An explicitly requested environment wins over the shell, so --env prod cannot silently target another instance.
		sources.push({ label: `.env.${env}`, values: dotenv.parse(fs.readFileSync(envFile)) });
	}
	sources.push({ label: 'the shell environment', values: process.env }, { label: '.env', values: baseValues });
	const sourceOf = (key) => sources.find((src) => src.values[key] !== undefined);
	const get = (key) => sourceOf(key)?.values[key] ?? '';
	for (const [identity, secret] of [
		['DOMO_INSTANCE', 'DOMO_ACCESS_TOKEN'],
		['TABLEAU_SERVER', 'TABLEAU_PAT_SECRET']
	]) {
		const idSource = sourceOf(identity);
		const secretSource = sourceOf(secret);
		if (!idSource || !secretSource || idSource === secretSource) continue;
		const other = secretSource.values[identity];
		if (other !== undefined && other !== idSource.values[identity]) {
			throw new ConfigError(`${identity} comes from ${idSource.label} but ${secret} comes from ${secretSource.label}, which is for ${identity}=${other}; set both in one place`);
		}
	}

	const config = {
		env,
		tableau: {
			server: stripTrailingSlash(get('TABLEAU_SERVER')),
			site: get('TABLEAU_SITE'),
			patName: get('TABLEAU_PAT_NAME'),
			patSecret: get('TABLEAU_PAT_SECRET'),
			apiVersion: get('TABLEAU_API_VERSION') || undefined,
			...overrides.tableau
		},
		domo: {
			instance: get('DOMO_INSTANCE'),
			accessToken: get('DOMO_ACCESS_TOKEN'),
			...overrides.domo
		},
		workspace: path.resolve(cwd, overrides.workspace || get('T2D_WORKSPACE') || 't2d-work'),
		python: resolveInterpreter(overrides.python || get('T2D_PYTHON') || 'python3', cwd),
		pythonExplicit: Boolean(overrides.python || get('T2D_PYTHON'))
	};
	return config;
}

export class ConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ConfigError';
	}
}

/** @param {T2DConfig} config */
export function requireTableau(config) {
	const missing = ['server', 'patName', 'patSecret'].filter((k) => !config.tableau[k]);
	if (missing.length) {
		const names = { server: 'TABLEAU_SERVER', patName: 'TABLEAU_PAT_NAME', patSecret: 'TABLEAU_PAT_SECRET' };
		throw new ConfigError(`Missing Tableau settings: ${missing.map((k) => names[k]).join(', ')}`);
	}
	return config.tableau;
}

/** @param {T2DConfig} config */
export function requireDomo(config) {
	const missing = [];
	if (!config.domo.instance) missing.push('DOMO_INSTANCE');
	if (!config.domo.accessToken) missing.push('DOMO_ACCESS_TOKEN');
	if (missing.length) throw new ConfigError(`Missing Domo settings: ${missing.join(', ')}`);
	return config.domo;
}

function resolveInterpreter(value, cwd) {
	if (path.isAbsolute(value) || !/[\\/]/.test(value)) return value;
	return path.resolve(cwd, value);
}

function stripTrailingSlash(value) {
	return value.replace(/\/+$/, '');
}
