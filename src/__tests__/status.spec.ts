import { describe, expect, it, vi } from 'vitest'
import { InstanceStatus } from '@companion-module/base'
import { StatusTracker } from '../status.js'

describe('StatusTracker', () => {
	it('shows the worst status of its sources', () => {
		const update = vi.fn()
		const tracker = new StatusTracker(update)
		tracker.set('listener', InstanceStatus.Ok)
		tracker.set('status', InstanceStatus.UnknownWarning, 'no answer')
		tracker.set('traps', InstanceStatus.BadConfig, 'Incorrect Community')
		tracker.set('status', InstanceStatus.Ok)
		expect(update.mock.calls).toEqual([
			[InstanceStatus.Ok, undefined],
			[InstanceStatus.UnknownWarning, 'no answer'],
			[InstanceStatus.BadConfig, 'Incorrect Community'],
		])
	})

	it('clears a source’s warning once it recovers', () => {
		const update = vi.fn()
		const tracker = new StatusTracker(update)
		tracker.set('listener', InstanceStatus.Ok)
		tracker.set('cells', InstanceStatus.UnknownWarning, 'no answer')
		tracker.set('cells', InstanceStatus.Ok)
		expect(update).toHaveBeenLastCalledWith(InstanceStatus.Ok, undefined)
	})

	it('only reports a change', () => {
		const update = vi.fn()
		const tracker = new StatusTracker(update)
		tracker.set('listener', InstanceStatus.Ok)
		tracker.set('traps', InstanceStatus.Ok)
		tracker.set('cells', InstanceStatus.Ok)
		expect(update).toHaveBeenCalledOnce()
	})

	it('forgets every source on reset', () => {
		const update = vi.fn()
		const tracker = new StatusTracker(update)
		tracker.set('listener', InstanceStatus.UnknownError, 'EACCES')
		tracker.reset()
		tracker.set('config', InstanceStatus.BadConfig, 'Missing IP')
		tracker.reset()
		tracker.set('listener', InstanceStatus.Ok)
		expect(update).toHaveBeenLastCalledWith(InstanceStatus.Ok, undefined)
	})
})
