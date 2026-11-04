import snmp, { type Varbind } from 'net-snmp'
import { getInBatches, type BatchResult, type GetFunction } from './client.js'
import { SIGNAL_VALUE } from './mib.js'

/** Each XCI card has 256 logic cells, numbered from 1, that can each send a trap */
export const CELL_COUNT = 256

/** The XCI's logic cell table, signalTable's signalValue column. A cell's OID is this followed by its number */
export const XCI_LOGIC_OID = SIGNAL_VALUE
/** The varbind value the XCI sends for a cell going true. Anything else is false */
const XCI_LOGIC_TRUE = 2

export type LogicCell = {
	/** The state the last trap for the cell reported */
	value: boolean
	/** Set by a trap reporting true, and left set until reset */
	latch: boolean
	/** How many traps have reported true since the last reset */
	count: number
}

/** A trap's report for one logic cell */
export type CellReport = { cell: number; value: boolean }

/**
 * @throws if `cell` is not a whole number from 1 to {@link CELL_COUNT}. Thrown from an action or feedback callback, the
 * error aborts it and is logged by Companion
 */
export function checkCellValue(cell: number): void {
	if (!Number.isInteger(cell) || cell < 1 || cell > CELL_COUNT) {
		throw new Error(`Invalid Cell! ${cell} should be a number between 1 and ${CELL_COUNT}`)
	}
}

/**
 * - `no-value`: the varbind has no value field
 * - `out-of-range`: a cell number outside 1 to {@link CELL_COUNT}
 * - `varbind-error`: a v2c agent's answer for an OID it doesn't have, such as noSuchInstance
 */
export type VarbindProblem = { kind: 'no-value' | 'out-of-range' | 'varbind-error'; varbind: Varbind }

/**
 * Reads the logic cell reports out of a trap's varbinds. Varbinds for any other OID, such as the sysUpTime and
 * snmpTrapOID a v2c trap opens with, are skipped without comment.
 */
export function parseLogicVarbinds(varbinds: Varbind[]): { reports: CellReport[]; problems: VarbindProblem[] } {
	const reports: CellReport[] = []
	const problems: VarbindProblem[] = []
	for (const varbind of varbinds) {
		if (snmp.isVarbindError(varbind)) {
			problems.push({ kind: 'varbind-error', varbind })
			continue
		}
		if (varbind.value === undefined) {
			problems.push({ kind: 'no-value', varbind })
			continue
		}
		if (!varbind.oid.startsWith(XCI_LOGIC_OID)) continue
		const suffix = varbind.oid.slice(XCI_LOGIC_OID.length)
		// Only the cell number follows the table's OID. A deeper OID is something else
		if (!/^\d+$/.test(suffix)) continue
		const cell = Number(suffix)
		if (cell < 1 || cell > CELL_COUNT) {
			problems.push({ kind: 'out-of-range', varbind })
			continue
		}
		// The value is an Integer, but the JavaScript module compared it loosely, so a string or bigint 2 counts too
		reports.push({ cell, value: Number(varbind.value) === XCI_LOGIC_TRUE })
	}
	return { reports, problems }
}

export const logicCellOid = (cell: number): string => `${XCI_LOGIC_OID}${cell}`

export type PollResult = {
	reports: CellReport[]
	problems: VarbindProblem[]
	failures: BatchResult['failures']
}

/**
 * Reads every logic cell from the XCI's agent, as {@link getInBatches}
 * @throws as {@link getInBatches}
 */
export async function pollLogicCells(get: GetFunction, signal?: AbortSignal): Promise<PollResult> {
	const oids = Array.from({ length: CELL_COUNT }, (_, i) => logicCellOid(i + 1))
	const { varbinds, failures } = await getInBatches(get, oids, signal)
	return { ...parseLogicVarbinds(varbinds), failures }
}

/** The state of every logic cell on the card */
export class LogicCells {
	#cells: LogicCell[] = []
	/** The cell most recently reported true, or 0 if none has been since the last reset */
	mostRecent = 0

	constructor() {
		this.reset()
	}

	reset(): void {
		this.#cells = Array.from({ length: CELL_COUNT }, () => ({ value: false, latch: false, count: 0 }))
		this.mostRecent = 0
	}

	/** @throws as {@link checkCellValue} */
	get(cell: number): Readonly<LogicCell> {
		checkCellValue(cell)
		return this.#cells[cell - 1]
	}

	/**
	 * Applies a trap's report. A true report sets the latch, counts, and becomes the most recent, even if the cell was
	 * true already.
	 * @returns which of the cell's value and latch changed
	 */
	report({ cell, value }: CellReport): { valueChanged: boolean; latchChanged: boolean } {
		const state = this.#cells[cell - 1]
		const valueChanged = state.value !== value
		let latchChanged = false
		state.value = value
		if (value) {
			latchChanged = !state.latch
			state.latch = true
			state.count += 1
			this.mostRecent = cell
		}
		return { valueChanged, latchChanged }
	}

	/**
	 * Applies a polled state. A cell found true sets its latch, as it has been true since the last reset, but it isn't
	 * counted and doesn't become the most recent: those follow traps only
	 * @returns which of the cell's value and latch changed
	 */
	setValue({ cell, value }: CellReport): { valueChanged: boolean; latchChanged: boolean } {
		const state = this.#cells[cell - 1]
		const valueChanged = state.value !== value
		const latchChanged = value && !state.latch
		state.value = value
		if (value) state.latch = true
		return { valueChanged, latchChanged }
	}

	/**
	 * @returns whether the latch was set
	 * @throws as {@link checkCellValue}
	 */
	resetLatch(cell: number): boolean {
		checkCellValue(cell)
		const state = this.#cells[cell - 1]
		const wasSet = state.latch
		state.latch = false
		return wasSet
	}

	/** @throws as {@link checkCellValue} */
	resetCount(cell: number): void {
		checkCellValue(cell)
		this.#cells[cell - 1].count = 0
	}
}
