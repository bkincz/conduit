import type { EventBus } from '../primitives/events'
import type { Middleware, Plugin } from '../primitives/types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface ContractMismatch {
	/** What this bundle was built against. */
	readonly expected: string
	/** What the server reported. */
	readonly actual: string
	readonly url: string
}

export interface ContractConfig {
	/** The API version this bundle was compiled against. */
	expected: string | number
	/** Response header carrying the server's version. Defaults to `x-api-version`. */
	header?: string
	/** Routes the report somewhere other than the console. */
	onMismatch?: (report: ContractMismatch) => void
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * Notices when a bundle is talking to an API it was not built against, and says
 * so once per server version rather than once per request.
 */
export function contract(config: ContractConfig): Plugin {
	const header = config.header ?? 'x-api-version'
	const expected = String(config.expected)
	const reported = new Set<string>()
	let events: EventBus | undefined

	const middleware: Middleware = async (request, next) => {
		const response = await next(request)
		const actual = response.headers.get(header)

		if (actual === null || actual === expected || reported.has(actual)) {
			return response
		}

		reported.add(actual)

		const report: ContractMismatch = { expected, actual, url: request.url }

		if (events?.active === true) {
			events.emit('contract:mismatch', {
				type: 'contract:mismatch',
				expected,
				actual,
				at: Date.now(),
			})
		}

		if (config.onMismatch !== undefined) {
			config.onMismatch(report)
		} else {
			console.warn(
				`[conduit] This bundle was built against API ${expected}, but ${request.url} answered as ${actual}. One of them has been deployed without the other.`
			)
		}

		return response
	}

	return {
		name: 'contract',
		middleware,
		onInit: ctx => {
			events = ctx.events
			return undefined
		},
	}
}
