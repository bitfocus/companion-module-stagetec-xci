import { describe, expect, it, vi } from 'vitest'
import snmp from 'net-snmp'
import {
	CELL_COUNT,
	LogicCells,
	XCI_LOGIC_OID,
	checkCellValue,
	logicCellOid,
	parseLogicVarbinds,
	pollLogicCells,
} from '../xci.js'
import { GET_BATCH_SIZE, type GetFunction } from '../client.js'
import { cellVarbind } from './fixtures.js'

describe('parseLogicVarbinds', () => {
	it('reads each logic cell varbind, 2 as true and anything else as false', () => {
		const { reports, problems } = parseLogicVarbinds([cellVarbind(4, true), cellVarbind(200, false)])
		expect(reports).toEqual([
			{ cell: 4, value: true },
			{ cell: 200, value: false },
		])
		expect(problems).toEqual([])
	})

	it('skips the sysUpTime and snmpTrapOID a v2c trap opens with, and deeper OIDs in the table', () => {
		const { reports, problems } = parseLogicVarbinds([
			{ oid: '1.3.6.1.2.1.1.3.0', type: snmp.ObjectType.TimeTicks, value: 1234 },
			{ oid: '1.3.6.1.6.3.1.1.4.1.0', type: snmp.ObjectType.OID, value: '1.3.6.1.4.1.40085' },
			{ oid: `${XCI_LOGIC_OID}4.1`, type: snmp.ObjectType.Integer, value: 2 },
			cellVarbind(5, true),
		])
		expect(reports).toEqual([{ cell: 5, value: true }])
		expect(problems).toEqual([])
	})

	it('reports a cell number out of range, and a varbind with no value', () => {
		const outOfRange = cellVarbind(CELL_COUNT + 1, true)
		const zero = cellVarbind(0, true)
		const noValue: snmp.Varbind = { oid: `${XCI_LOGIC_OID}3` }
		const { reports, problems } = parseLogicVarbinds([outOfRange, zero, noValue])
		expect(reports).toEqual([])
		expect(problems).toEqual([
			{ kind: 'out-of-range', varbind: outOfRange },
			{ kind: 'out-of-range', varbind: zero },
			{ kind: 'no-value', varbind: noValue },
		])
	})

	it('reports a varbind error, such as the noSuchInstance a v2c agent answers for an OID it lacks', () => {
		const missing: snmp.Varbind = { oid: logicCellOid(256), type: snmp.ObjectType.NoSuchInstance, value: null }
		const { reports, problems } = parseLogicVarbinds([missing])
		expect(reports).toEqual([])
		expect(problems).toEqual([{ kind: 'varbind-error', varbind: missing }])
	})

	it('reads the first and last cells', () => {
		const { reports } = parseLogicVarbinds([cellVarbind(1, true), cellVarbind(CELL_COUNT, true)])
		expect(reports.map(({ cell }) => cell)).toEqual([1, CELL_COUNT])
	})
})

describe('checkCellValue', () => {
	it.each([0, CELL_COUNT + 1, 1.5, NaN])('rejects %s', (cell) => {
		expect(() => checkCellValue(cell)).toThrow(/Invalid Cell/)
	})

	it.each([1, CELL_COUNT])('accepts %s', (cell) => {
		expect(() => checkCellValue(cell)).not.toThrow()
	})
})

describe('LogicCells', () => {
	it('latches, counts and records the most recent cell on every true report, even when already true', () => {
		const cells = new LogicCells()
		expect(cells.report({ cell: 7, value: true })).toEqual({ valueChanged: true, latchChanged: true })
		expect(cells.report({ cell: 7, value: true })).toEqual({ valueChanged: false, latchChanged: false })
		expect(cells.get(7)).toEqual({ value: true, latch: true, count: 2 })
		expect(cells.mostRecent).toBe(7)
	})

	it('keeps the latch and count when a cell goes false', () => {
		const cells = new LogicCells()
		cells.report({ cell: 7, value: true })
		cells.report({ cell: 8, value: true })
		expect(cells.report({ cell: 7, value: false })).toEqual({ valueChanged: true, latchChanged: false })
		expect(cells.get(7)).toEqual({ value: false, latch: true, count: 1 })
		expect(cells.mostRecent).toBe(8)
	})

	it('resets a latch, saying whether it was set, and a count', () => {
		const cells = new LogicCells()
		cells.report({ cell: 7, value: true })
		expect(cells.resetLatch(7)).toBe(true)
		expect(cells.resetLatch(7)).toBe(false)
		cells.resetCount(7)
		expect(cells.get(7)).toEqual({ value: true, latch: false, count: 0 })
	})

	it('clears everything on reset', () => {
		const cells = new LogicCells()
		cells.report({ cell: 7, value: true })
		cells.reset()
		expect(cells.get(7)).toEqual({ value: false, latch: false, count: 0 })
		expect(cells.mostRecent).toBe(0)
	})

	it('rejects a cell out of range', () => {
		const cells = new LogicCells()
		expect(() => cells.get(0)).toThrow(/Invalid Cell/)
		expect(() => cells.resetLatch(CELL_COUNT + 1)).toThrow(/Invalid Cell/)
		expect(() => cells.resetCount(-1)).toThrow(/Invalid Cell/)
	})
})

/** A RequestFailedError, as net-snmp makes one for a response with an error status */
function requestFailed(oid: string): Error {
	return Object.assign(new Error(`NoSuchName: ${oid}`), { name: 'RequestFailedError' })
}

/** An agent holding every cell, true where `isTrue` says, failing in v1 style for the cells in `missing` */
function v1Agent(isTrue: (cell: number) => boolean, missing: number[] = []) {
	return vi.fn<GetFunction>(async (oids) => {
		const bad = oids.find((oid) => missing.some((cell) => oid === logicCellOid(cell)))
		if (bad) throw requestFailed(bad)
		return oids.map((oid) => {
			const cell = Number(oid.slice(XCI_LOGIC_OID.length))
			return { oid, type: snmp.ObjectType.Integer, value: isTrue(cell) ? 2 : 1 }
		})
	})
}

describe('pollLogicCells', () => {
	it('reads every cell, in batches', async () => {
		const get = v1Agent((cell) => cell === 7)
		const { reports, problems, failures } = await pollLogicCells(get)

		expect(get).toHaveBeenCalledTimes(CELL_COUNT / GET_BATCH_SIZE)
		expect(get.mock.calls.every(([oids]) => oids.length === GET_BATCH_SIZE)).toBe(true)
		expect(get.mock.calls.flatMap(([oids]) => oids)).toEqual(
			Array.from({ length: CELL_COUNT }, (_, i) => logicCellOid(i + 1)),
		)
		expect(reports).toHaveLength(CELL_COUNT)
		expect(reports.filter(({ value }) => value)).toEqual([{ cell: 7, value: true }])
		expect(problems).toEqual([])
		expect(failures).toEqual([])
	})

	it('asks again one OID at a time when a v1 agent fails a batch, losing only the OIDs that fail alone', async () => {
		const get = v1Agent(() => true, [CELL_COUNT])
		const { reports, failures } = await pollLogicCells(get)

		expect(reports).toHaveLength(CELL_COUNT - 1)
		expect(failures.map(({ oid }) => oid)).toEqual([logicCellOid(CELL_COUNT)])
		// Every batch once, then each OID of the last batch on its own
		expect(get).toHaveBeenCalledTimes(CELL_COUNT / GET_BATCH_SIZE + GET_BATCH_SIZE)
	})

	it('stops at a timeout', async () => {
		const timeout = Object.assign(new Error('Request timed out'), { name: 'RequestTimedOutError' })
		const get = vi.fn<GetFunction>(async () => {
			throw timeout
		})
		await expect(pollLogicCells(get)).rejects.toBe(timeout)
		expect(get).toHaveBeenCalledOnce()
	})

	it('passes the signal to every request', async () => {
		const get = v1Agent(() => false)
		const signal = new AbortController().signal
		await pollLogicCells(get, signal)
		expect(get.mock.calls.every(([, s]) => s === signal)).toBe(true)
	})
})

describe('LogicCells.setValue', () => {
	it('sets the value, and the latch when true, but neither counts nor becomes the most recent', () => {
		const cells = new LogicCells()
		expect(cells.setValue({ cell: 7, value: true })).toEqual({ valueChanged: true, latchChanged: true })
		expect(cells.get(7)).toEqual({ value: true, latch: true, count: 0 })
		expect(cells.mostRecent).toBe(0)
	})

	it('leaves a latch a trap set when found false', () => {
		const cells = new LogicCells()
		cells.report({ cell: 7, value: true })
		expect(cells.setValue({ cell: 7, value: false })).toEqual({ valueChanged: true, latchChanged: false })
		expect(cells.get(7)).toEqual({ value: false, latch: true, count: 1 })
	})
})
