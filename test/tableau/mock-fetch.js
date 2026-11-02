/**
 * Route-based fetch stub. Each route is [method, urlRegex, handler(call) => Response|object].
 * A plain object is returned as a JSON 200 response.
 */
export function installFetch(routes) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const method = init.method || 'GET';
		const call = { url: String(url), method, headers: init.headers || {}, body: init.body, init };
		calls.push(call);
		for (const [m, re, handler] of routes) {
			if (m === method && re.test(call.url)) {
				const out = await handler(call, calls);
				return out instanceof Response ? out : jsonResponse(out);
			}
		}
		return new Response(`no route for ${method} ${url}`, { status: 599 });
	};
	return { calls, restore: () => { globalThis.fetch = original; } };
}

export function jsonResponse(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const signinBody = (token = 'tok-1') => ({
	credentials: { token, site: { id: 'site-1', contentUrl: 'mysite' }, user: { id: 'user-1' } }
});

export const baseConfig = { server: 'https://tab.example.com', site: 'mysite', patName: 'pat', patSecret: 'secret' };
