import type { CompanionActionDefinitions } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { allCellsOption, cellOption } from './options.js'

/**
 * Action ids. The values are the ids saved against every button using the action, so they must never change. They
 * predate this enum and are camelCase for that reason.
 */
export enum ActionId {
	ResetLatch = 'resetLatch',
	ResetCount = 'resetCount',
	Refresh = 'refresh',
}

type CellOrAllOptions = { cell: number; all: boolean }

export type ActionSchema = {
	[ActionId.ResetLatch]: { options: CellOrAllOptions }
	[ActionId.ResetCount]: { options: CellOrAllOptions }
	[ActionId.Refresh]: { options: Record<string, never> }
}

export function UpdateActions(self: ModuleInstance): void {
	const actions: CompanionActionDefinitions<ActionSchema> = {
		[ActionId.ResetLatch]: {
			name: 'Reset Latch',
			options: [cellOption('!$(options:all)'), allCellsOption],
			callback: ({ options }) => {
				if (options.all) self.resetAllLatches()
				else self.resetLatch(Math.floor(options.cell))
			},
		},
		[ActionId.ResetCount]: {
			name: 'Reset Count',
			options: [cellOption('!$(options:all)'), allCellsOption],
			callback: ({ options }) => {
				if (options.all) self.resetAllCounts()
				else self.resetCount(Math.floor(options.cell))
			},
		},
		[ActionId.Refresh]: {
			name: 'Refresh',
			description: 'Reads the logic cells and the Nexus status from the XCI now',
			options: [],
			callback: () => self.refresh(),
		},
	}
	self.setActionDefinitions(actions)
}
