import {
	FixupNumericOrVariablesValueToExpressions,
	type CompanionMigrationAction,
	type CompanionMigrationFeedback,
	type CompanionStaticUpgradeProps,
	type CompanionStaticUpgradeResult,
	type CompanionStaticUpgradeScript,
	type CompanionUpgradeContext,
} from '@companion-module/base'
import { CONFIG_DEFAULTS, type ModuleConfig } from './config.js'
import { ActionId } from './actions.js'
import { FeedbackId } from './feedbacks.js'

/**
 * The actions and feedbacks that had a `cell` number, a `cellVar` textinput and a `useVar` checkbox choosing between
 * them before API 2.x. Frozen history for UpgradeScripts[1]: do not edit to track later changes, add a new script.
 */
export const cellVarActionsApi2: readonly string[] = [ActionId.ResetLatch, ActionId.ResetCount]
/** As {@link cellVarActionsApi2}, for feedbacks */
export const cellVarFeedbacksApi2: readonly string[] = [FeedbackId.Trap, FeedbackId.TrapLatch]

/**
 * Folds `useVar` and `cellVar` into `cell`, in place. With `useVar` set, `cell` takes `cellVar` as a number or an
 * expression; otherwise it keeps its number. An empty `cellVar` keeps the number too: the button failed every time
 * before, and the number is the better guess at what was meant.
 * @returns whether anything changed
 */
function foldCellVar(item: CompanionMigrationAction | CompanionMigrationFeedback): boolean {
	const { useVar, cellVar } = item.options
	if (useVar === undefined && cellVar === undefined) return false
	const cellVarText = typeof cellVar?.value === 'string' ? cellVar.value.trim() : ''
	if (useVar?.value === true && cellVar && cellVarText !== '') {
		item.options.cell = FixupNumericOrVariablesValueToExpressions(cellVar)
	}
	delete item.options.useVar
	delete item.options.cellVar
	return true
}

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 */

	// 0: v1.1.0 — the trap feedback could take its cell from a variable
	function v100tov110(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		return {
			updatedConfig: null,
			updatedActions: [],
			updatedFeedbacks: props.feedbacks.filter((feedback) => {
				if (feedback.feedbackId !== String(FeedbackId.Trap) || feedback.options.useVar !== undefined) return false
				// Companion wraps every option as { isExpression, value } before the module's scripts run
				feedback.options.useVar = { isExpression: false, value: false }
				feedback.options.cellVar = { isExpression: false, value: '' }
				return true
			}),
		}
	},

	// 1: API 2.x — expression mode replaced the useVar checkbox and cellVar textinput. "3" becomes 3,
	// "$(local:cell)" becomes an expression, anything else is wrapped in parseVariables()
	function api2CellExpressions(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		return {
			updatedConfig: null,
			updatedActions: props.actions.filter(
				(action) => cellVarActionsApi2.includes(action.actionId) && foldCellVar(action),
			),
			updatedFeedbacks: props.feedbacks.filter(
				(feedback) => cellVarFeedbacksApi2.includes(feedback.feedbackId) && foldCellVar(feedback),
			),
		}
	},

	// 2: v2.0.0 — the XCI's state is read with an SNMP client, which needs a version, a port and a poll interval
	function v2SnmpClientConfig(
		_context: CompanionUpgradeContext<ModuleConfig>,
		props: CompanionStaticUpgradeProps<ModuleConfig, undefined>,
	): CompanionStaticUpgradeResult<ModuleConfig, undefined> {
		const config = props.config
		const missing =
			config !== null &&
			(Object.keys(CONFIG_DEFAULTS) as (keyof typeof CONFIG_DEFAULTS)[]).some((key) => config[key] === undefined)
		return {
			updatedConfig: missing ? { ...CONFIG_DEFAULTS, ...config } : null,
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},
]
