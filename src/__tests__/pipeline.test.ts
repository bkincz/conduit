import { describe, expect, it, vi } from 'vitest'

import { compose } from '../pipeline'
import type { ConduitRequest, ConduitResponse, Middleware, Next } from '../types'

const request = { key: 'GET /x' } as ConduitRequest

const respond = (data: unknown): ConduitResponse =>
	({ data, from: 'network', status: 200 }) as ConduitResponse

describe('compose', () => {
	it('returns the terminal handler untouched when there is no middleware', () => {
		const terminal: Next = async () => respond('t')

		expect(compose([], terminal)).toBe(terminal)
	})

	it('runs middleware outermost first, then unwinds', async () => {
		const order: string[] = []

		const layer =
			(name: string): Middleware =>
			async (req, next) => {
				order.push(`${name}:in`)
				const response = await next(req)
				order.push(`${name}:out`)
				return response
			}

		const dispatch = compose([layer('a'), layer('b')], async () => {
			order.push('terminal')
			return respond('done')
		})

		await dispatch(request)

		expect(order).toEqual(['a:in', 'b:in', 'terminal', 'b:out', 'a:out'])
	})

	it('lets a layer short-circuit without reaching the terminal', async () => {
		const terminal = vi.fn<Next>(async () => respond('network'))
		const cacheish: Middleware = async () => respond('cached')

		const dispatch = compose([cacheish], terminal)
		const response = await dispatch(request)

		expect(response.data).toBe('cached')
		expect(terminal).not.toHaveBeenCalled()
	})

	it('propagates a rejection outward through the layers', async () => {
		const seen: string[] = []

		const observer: Middleware = async (req, next) => {
			try {
				return await next(req)
			} catch (error) {
				seen.push((error as Error).message)
				throw error
			}
		}

		const dispatch = compose([observer], async () => {
			throw new Error('boom')
		})

		await expect(dispatch(request)).rejects.toThrow('boom')
		expect(seen).toEqual(['boom'])
	})
})
