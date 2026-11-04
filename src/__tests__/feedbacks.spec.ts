import { describe, expect, it } from 'vitest'
import { DeviceProperty, FeedbackId, MAX_INTEGER, SystemProperty } from '../feedbacks.js'
import { ANY_ERROR_CODE, ERROR_CODE_CHOICES, NexusErrorCode } from '../errors.js'
import type { BaseDevice, ErrorEvent, NexusStatus } from '../nexus.js'
import { checkFeedback, fakeInstance, feedbackDefinitions, unsubscribeFeedback } from './fixtures.js'

describe('feedbacks', () => {
	it('follow the cell state: the trap feedback its value, the latched one its latch', () => {
		const fake = fakeInstance()
		const definitions = feedbackDefinitions(fake)
		fake.cells.report({ cell: 3, value: true })
		fake.cells.report({ cell: 3, value: false })
		expect(checkFeedback(definitions, FeedbackId.Trap, { cell: 3 })).toBe(false)
		expect(checkFeedback(definitions, FeedbackId.TrapLatch, { cell: 3 })).toBe(true)
		fake.cells.report({ cell: 3, value: true })
		expect(checkFeedback(definitions, FeedbackId.Trap, { cell: 3 })).toBe(true)
	})

	it('take a whole cell number from an expression that gives a fraction, as the JavaScript module did', () => {
		const fake = fakeInstance()
		const definitions = feedbackDefinitions(fake)
		fake.cells.report({ cell: 3, value: true })
		expect(checkFeedback(definitions, FeedbackId.Trap, { cell: 3.7 })).toBe(true)
		expect(fake.self.trapFeedbacks.feedbacksFor(3)).toEqual([`feedback-${FeedbackId.Trap}`])
	})

	describe.each([
		[FeedbackId.Trap, 'trapFeedbacks'],
		[FeedbackId.TrapLatch, 'latchFeedbacks'],
	] as const)('%s', (feedbackId, registry) => {
		it('registers by its instance id, against its cell', () => {
			const fake = fakeInstance()
			const definitions = feedbackDefinitions(fake)
			checkFeedback(definitions, feedbackId, { cell: 3 }, 'fb-a')
			checkFeedback(definitions, feedbackId, { cell: 3 }, 'fb-b')
			expect(fake.self[registry].feedbacksFor(3)).toEqual(['fb-a', 'fb-b'])
		})

		// Companion reruns the callback with the new options when they are edited, and calls no unsubscribe
		it('moves to the new cell when edited', () => {
			const fake = fakeInstance()
			const definitions = feedbackDefinitions(fake)
			checkFeedback(definitions, feedbackId, { cell: 3 }, 'fb-a')
			checkFeedback(definitions, feedbackId, { cell: 4 }, 'fb-a')
			expect(fake.self[registry].feedbacksFor(3)).toEqual([])
			expect(fake.self[registry].feedbacksFor(4)).toEqual(['fb-a'])
		})

		it('leaves its cell when edited to one out of range, and throws', () => {
			const fake = fakeInstance()
			const definitions = feedbackDefinitions(fake)
			checkFeedback(definitions, feedbackId, { cell: 3 }, 'fb-a')
			expect(() => checkFeedback(definitions, feedbackId, { cell: 300 }, 'fb-a')).toThrow(/Invalid Cell/)
			expect(fake.self[registry].feedbacksFor(3)).toEqual([])
		})

		it('leaves its cell on unsubscribe', async () => {
			const fake = fakeInstance()
			const definitions = feedbackDefinitions(fake)
			checkFeedback(definitions, feedbackId, { cell: 3 }, 'fb-a')
			await unsubscribeFeedback(definitions, feedbackId, { cell: 3 }, 'fb-a')
			expect(fake.self[registry].feedbacksFor(3)).toEqual([])
		})
	})
})

const HEALTHY: BaseDevice = {
	online: true,
	configBoards: 10,
	availBoards: 10,
	powerUnits: 2,
	pwrGoodUnits: 2,
	cpuTemperature: 41,
	cpuMaxTemp: 55,
}
const FAILING: BaseDevice = {
	online: false,
	configBoards: 8,
	availBoards: 7,
	powerUnits: 2,
	pwrGoodUnits: 1,
	cpuTemperature: 48,
	cpuMaxTemp: 60,
}

function withStatus(fields: Partial<NexusStatus>, errors: ErrorEvent[] = []) {
	const fake = fakeInstance()
	fake.nexus.update(
		{ scalars: {}, devices: new Map(), trapAddresses: [], errorEvents: errors, missing: [], failures: [], ...fields },
		false,
	)
	return { fake, definitions: feedbackDefinitions(fake) }
}

describe('device health device option', () => {
	const deviceOption = (fields: Partial<NexusStatus>) =>
		withStatus(fields).definitions[FeedbackId.DeviceHealth] || undefined

	it('is limited to the highest base device there can be, once read', () => {
		const definition = deviceOption({
			scalars: { baseDevNum: 2 },
			devices: new Map([
				[1, {}],
				[3, {}],
			]),
		})
		expect(definition?.options.find(({ id }) => id === 'device')).toMatchObject({ min: 1, max: 3, asInteger: true })
	})

	it('is wide until read, so no saved feedback is put in error before then', () => {
		const definition = deviceOption({})
		expect(definition?.options.find(({ id }) => id === 'device')).toMatchObject({ max: MAX_INTEGER })
	})
})

describe('device health', () => {
	const { definitions } = withStatus({
		devices: new Map([
			[1, HEALTHY],
			[2, FAILING],
			[3, { online: true }],
		]),
	})
	const health = (device: number, property: DeviceProperty) =>
		checkFeedback(definitions, FeedbackId.DeviceHealth, { device, property })

	it.each([
		['online', true, false],
		['configBoards', 10, 8],
		['availBoards', 10, 7],
		['boardsOk', true, false],
		['powerUnits', 2, 2],
		['pwrGoodUnits', 2, 1],
		['powerOk', true, false],
		['cpuTemperature', 41, 48],
		['cpuMaxTemp', 55, 60],
	] as const)('gives %s', (property, healthy, failing) => {
		expect(health(1, property)).toBe(healthy)
		expect(health(2, property)).toBe(failing)
	})

	it('gives null for a device it hasn’t read, a value the agent didn’t give, or an option it no longer offers', () => {
		expect(health(9, 'online')).toBeNull()
		expect(health(3, 'cpuTemperature')).toBeNull()
		expect(health(3, 'boardsOk')).toBeNull()
		expect(health(1, 'gone' as DeviceProperty)).toBeNull()
	})
})

describe('system health', () => {
	const errors = [
		{ occured: true, node: 1, code: 10, name: 'A', param: '' },
		{ occured: true, node: 2, code: 10, name: 'B', param: '' },
	]
	const system = (fake: ReturnType<typeof withStatus>, property: SystemProperty) =>
		checkFeedback(fake.definitions, FeedbackId.SystemHealth, { property })

	it('reads across every device, and counts the active errors', () => {
		const failing = withStatus(
			{
				scalars: { baseDevNum: 2, baseDevOnline: 1 },
				devices: new Map([
					[1, HEALTHY],
					[2, FAILING],
				]),
			},
			errors,
		)
		expect(system(failing, 'allDevicesOnline')).toBe(false)
		expect(system(failing, 'allBoardsOk')).toBe(false)
		expect(system(failing, 'allPowerOk')).toBe(false)
		expect(system(failing, 'maxCpuTemperature')).toBe(48)
		expect(system(failing, 'activeErrors')).toBe(2)

		const healthy = withStatus({
			scalars: { baseDevNum: 2, baseDevOnline: 2 },
			devices: new Map([
				[1, HEALTHY],
				[2, HEALTHY],
			]),
		})
		expect(system(healthy, 'allDevicesOnline')).toBe(true)
		expect(system(healthy, 'allBoardsOk')).toBe(true)
		expect(system(healthy, 'allPowerOk')).toBe(true)
		expect(system(healthy, 'activeErrors')).toBe(0)
	})

	it('gives null until read', () => {
		const unread = withStatus({})
		expect(system(unread, 'allDevicesOnline')).toBeNull()
		expect(system(unread, 'allBoardsOk')).toBeNull()
		expect(system(unread, 'maxCpuTemperature')).toBeNull()
		expect(system(unread, 'gone' as SystemProperty)).toBeNull()
	})

	it('counts the active errors from a node or with a code', () => {
		const { definitions } = withStatus({}, errors)
		expect(checkFeedback(definitions, FeedbackId.ErrorCount, { node: 0, code: 0 })).toBe(2)
		expect(checkFeedback(definitions, FeedbackId.ErrorCount, { node: 2, code: 0 })).toBe(1)
		expect(checkFeedback(definitions, FeedbackId.ErrorCount, { node: 0, code: 11 })).toBe(0)
	})
})

describe('sync source', () => {
	it('is true for the source the Nexus is synced to', () => {
		const { definitions } = withStatus({ scalars: { syncIndex: 0 } })
		expect(checkFeedback(definitions, FeedbackId.SyncSource, { source: 0 })).toBe(true)
		expect(checkFeedback(definitions, FeedbackId.SyncSource, { source: 1 })).toBe(false)
	})

	it('is false until read', () => {
		const { definitions } = withStatus({})
		expect(checkFeedback(definitions, FeedbackId.SyncSource, { source: 0 })).toBe(false)
	})
})

describe('active errors error code option', () => {
	const option = () => {
		const definition = withStatus({}).definitions[FeedbackId.ErrorCount]
		if (!definition) throw new Error('No Active Errors feedback')
		const code = definition.options.find(({ id }) => id === 'code')
		if (code?.type !== 'dropdown') throw new Error('Error Code is not a dropdown')
		return code
	}

	it('lists Any, then every code in the spec with its description, in code order', () => {
		const { choices, default: defaultValue } = option()
		expect(choices[0]).toEqual({ id: ANY_ERROR_CODE, label: 'Any' })
		expect(defaultValue).toBe(ANY_ERROR_CODE)
		const codes = choices.slice(1).map(({ id }) => id)
		expect(codes).toHaveLength(23)
		expect(codes).toEqual(codes.toSorted((a, b) => Number(a) - Number(b)))
		expect(choices).toContainEqual({ id: 64, label: '64: Base device down' })
		expect(choices).toContainEqual({ id: 69, label: '69: Power supply down' })
		expect(choices).toContainEqual({ id: 127, label: '127: Invalid command received' })
	})

	// It was a number field: a value saved then is a number, and still has to be one of the choices
	it('keeps every code a number, as the number field it replaced stored', () => {
		expect(ERROR_CODE_CHOICES.every(({ id }) => typeof id === 'number')).toBe(true)
		expect(ERROR_CODE_CHOICES.map(({ id }) => id)).toContain(NexusErrorCode.BoardFail)
	})

	it('takes a code the list doesn’t have, digits only', () => {
		const { allowCustom, regex } = option()
		expect(allowCustom).toBe(true)
		const pattern = new RegExp(regex!.slice(1, -1))
		expect(pattern.test('42')).toBe(true)
		expect(pattern.test('4x')).toBe(false)
		expect(pattern.test('')).toBe(false)
	})

	it('counts by a listed code, which Companion passes as its number, or a typed one, which it passes as text', () => {
		const errors = [
			{ occured: true, node: 1, code: 69, name: 'PWR', param: '' },
			{ occured: true, node: 2, code: 42, name: '?', param: '' },
		]
		const { definitions } = withStatus({}, errors)
		expect(checkFeedback(definitions, FeedbackId.ErrorCount, { node: 0, code: 69 })).toBe(1)
		expect(checkFeedback(definitions, FeedbackId.ErrorCount, { node: 0, code: '42' })).toBe(1)
		expect(checkFeedback(definitions, FeedbackId.ErrorCount, { node: 0, code: ANY_ERROR_CODE })).toBe(2)
		expect(checkFeedback(definitions, FeedbackId.ErrorCount, { node: 2, code: 69 })).toBe(0)
	})
})
