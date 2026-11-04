import { describe, expect, it } from 'vitest'
import { ActionId } from '../actions.js'
import { actionDefinitions, fakeInstance, runAction } from './fixtures.js'

describe('actions', () => {
	it.each([
		[ActionId.ResetLatch, 'resetLatch', 'resetAllLatches'],
		[ActionId.ResetCount, 'resetCount', 'resetAllCounts'],
	] as const)('%s resets one cell, or every cell with Reset All', async (actionId, one, all) => {
		const fake = fakeInstance()
		const definitions = actionDefinitions(fake)

		await runAction(definitions, actionId, { cell: 5.2, all: false })
		expect(fake[one]).toHaveBeenCalledExactlyOnceWith(5)
		expect(fake[all]).not.toHaveBeenCalled()

		await runAction(definitions, actionId, { cell: 5, all: true })
		expect(fake[one]).toHaveBeenCalledTimes(1)
		expect(fake[all]).toHaveBeenCalledOnce()
	})

	it('refresh reads everything again', async () => {
		const fake = fakeInstance()
		await runAction(actionDefinitions(fake), ActionId.Refresh, {})
		expect(fake.refresh).toHaveBeenCalledOnce()
	})
})
