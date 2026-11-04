import type { CompanionInputFieldCheckbox, CompanionInputFieldNumber } from '@companion-module/base'
import { CELL_COUNT } from './xci.js'

/**
 * The logic cell an action or feedback acts on. Before API 2.x a `useVar` checkbox swapped it for a `cellVar`
 * textinput taking a variable; expression mode does that now, and UpgradeScripts[1] folds the two into this field.
 * @param isVisibleExpression for the actions, which hide it when acting on every cell
 */
export function cellOption(isVisibleExpression?: string): CompanionInputFieldNumber<'cell'> {
	return {
		id: 'cell',
		type: 'number',
		label: 'Logic Cell',
		default: 1,
		min: 1,
		max: CELL_COUNT,
		range: true,
		step: 1,
		asInteger: true,
		tooltip: 'Refer to Nexus Service for Logic Cell number',
		...(isVisibleExpression === undefined ? {} : { isVisibleExpression }),
	}
}

export const allCellsOption: CompanionInputFieldCheckbox<'all'> = {
	id: 'all',
	type: 'checkbox',
	label: 'Reset All',
	default: false,
}
