import { describe, expect, it } from 'vitest'
import type {
	CompanionMigrationAction,
	CompanionMigrationFeedback,
	CompanionStaticUpgradeProps,
	CompanionUpgradeContext,
} from '@companion-module/base'
import { UpgradeScripts, cellVarActionsApi2, cellVarFeedbacksApi2 } from '../upgrades.js'
import { ActionId } from '../actions.js'
import { FeedbackId } from '../feedbacks.js'
import type { ModuleConfig } from '../config.js'
import { actionDefinitions, fakeInstance, feedbackDefinitions } from './fixtures.js'

/**
 * Upgrade scripts are order-sensitive: a stored upgrade index records how far a configuration has been migrated, so
 * scripts may only ever be appended. Pin the indexes rather than taking the last entry, so appending a script can't
 * silently retarget this suite.
 */
const V110_SCRIPT_INDEX = 0
const API2_SCRIPT_INDEX = 1
const SNMP_CLIENT_CONFIG_SCRIPT_INDEX = 2
const EXPECTED_SCRIPT_COUNT = 3

// Options reach upgrade scripts already wrapped as ExpressionOrValue — Companion does that before running them
const v = (value: unknown) => ({ isExpression: false, value })

function action(actionId: string, options: Record<string, unknown>): CompanionMigrationAction {
	return {
		id: `action-${actionId}`,
		controlId: 'bank-1',
		actionId,
		options: options as CompanionMigrationAction['options'],
	}
}

function feedback(feedbackId: string, options: Record<string, unknown>): CompanionMigrationFeedback {
	return {
		id: `feedback-${feedbackId}`,
		controlId: 'bank-1',
		feedbackId,
		options: options as CompanionMigrationFeedback['options'],
	}
}

function run(
	index: number,
	actions: CompanionMigrationAction[],
	feedbacks: CompanionMigrationFeedback[] = [],
	config: ModuleConfig | null = null,
) {
	return UpgradeScripts[index]({} as CompanionUpgradeContext<ModuleConfig>, {
		config,
		secrets: null,
		actions,
		feedbacks,
	} satisfies CompanionStaticUpgradeProps<ModuleConfig, undefined>)
}

it('has the scripts this suite targets', () => {
	// Appending a script is fine — bump EXPECTED_SCRIPT_COUNT. Never insert, reorder or remove one.
	expect(UpgradeScripts).toHaveLength(EXPECTED_SCRIPT_COUNT)
})

describe('v1.1.0 upgrade script', () => {
	it('adds useVar and cellVar to a trap feedback without them, wrapped as Companion stores them', () => {
		const old = feedback(FeedbackId.Trap, { cell: v(3) })
		const result = run(V110_SCRIPT_INDEX, [], [old])
		expect(result.updatedFeedbacks).toEqual([old])
		expect(old.options).toEqual({ cell: v(3), useVar: v(false), cellVar: v('') })
	})

	it('leaves a trap feedback that has useVar, and other feedbacks', () => {
		const current = feedback(FeedbackId.Trap, { cell: v(3), useVar: v(true), cellVar: v('4') })
		const latch = feedback(FeedbackId.TrapLatch, { cell: v(3) })
		expect(run(V110_SCRIPT_INDEX, [], [current, latch]).updatedFeedbacks).toEqual([])
	})
})

describe('API 2.x upgrade script', () => {
	it('keeps the number, and drops useVar and cellVar, when useVar is off', () => {
		const old = action(ActionId.ResetLatch, { cell: v(7), cellVar: v('$(local:x)'), useVar: v(false), all: v(false) })
		const result = run(API2_SCRIPT_INDEX, [old])
		expect(result.updatedActions).toEqual([old])
		expect(old.options).toEqual({ cell: v(7), all: v(false) })
	})

	it('takes a plain number from cellVar when useVar is on', () => {
		const old = feedback(FeedbackId.Trap, { cell: v(1), cellVar: v('12'), useVar: v(true) })
		run(API2_SCRIPT_INDEX, [], [old])
		expect(old.options).toEqual({ cell: { isExpression: false, value: 12 } })
	})

	it('turns a variable in cellVar into an expression', () => {
		const old = action(ActionId.ResetCount, {
			cell: v(1),
			cellVar: v('$(internal:cell)'),
			useVar: v(true),
			all: v(false),
		})
		run(API2_SCRIPT_INDEX, [old])
		expect(old.options.cell).toEqual({ isExpression: true, value: '$(internal:cell)' })
	})

	it('wraps anything else in cellVar in parseVariables', () => {
		const old = feedback(FeedbackId.TrapLatch, { cell: v(1), cellVar: v('$(local:a)$(local:b)'), useVar: v(true) })
		run(API2_SCRIPT_INDEX, [], [old])
		expect(old.options.cell).toEqual({ isExpression: true, value: 'parseVariables("$(local:a)$(local:b)")' })
	})

	it('keeps the number when useVar is on but cellVar is empty', () => {
		const old = feedback(FeedbackId.Trap, { cell: v(9), cellVar: v(' '), useVar: v(true) })
		run(API2_SCRIPT_INDEX, [], [old])
		expect(old.options).toEqual({ cell: v(9) })
	})

	it('reports only what it changed', () => {
		const upgraded = action(ActionId.ResetLatch, { cell: v(2), all: v(true) })
		const other = action('someOtherAction', { cellVar: v('3'), useVar: v(true) })
		const result = run(API2_SCRIPT_INDEX, [upgraded, other])
		expect(result.updatedActions).toEqual([])
		expect(other.options).toEqual({ cellVar: v('3'), useVar: v(true) })
	})

	it('only lists definitions whose cell is still a number field', () => {
		const fake = fakeInstance()
		const actions = actionDefinitions(fake)
		const feedbacks = feedbackDefinitions(fake)
		const definitions = [
			...cellVarActionsApi2.map((id) => [id, actions[id as ActionId]] as const),
			...cellVarFeedbacksApi2.map((id) => [id, feedbacks[id as FeedbackId]] as const),
		]
		for (const [id, definition] of definitions) {
			if (!definition) throw new Error(`No definition for ${id}`)
			const cell = definition.options.find((option) => option.id === 'cell')
			expect(cell?.type, id).toBe('number')
		}
	})
})

describe('v2.0.0 SNMP client config script', () => {
	it('gives a connection from before the client the default version, port and poll interval', () => {
		const old = { host: '192.0.2.10', community: 'nexus' } as ModuleConfig
		expect(run(SNMP_CLIENT_CONFIG_SCRIPT_INDEX, [], [], old).updatedConfig).toEqual({
			host: '192.0.2.10',
			community: 'nexus',
			version: 'v2c',
			port: 161,
			pollInterval: 10,
		})
	})

	it('leaves a config that has them', () => {
		const current: ModuleConfig = {
			host: '192.0.2.10',
			community: 'nexus',
			version: 'v1',
			port: 1161,
			pollInterval: 30,
		}
		expect(run(SNMP_CLIENT_CONFIG_SCRIPT_INDEX, [], [], current).updatedConfig).toBeNull()
		expect(run(SNMP_CLIENT_CONFIG_SCRIPT_INDEX, [], [], null).updatedConfig).toBeNull()
	})
})
