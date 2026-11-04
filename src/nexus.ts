import { isDeepStrictEqual } from 'node:util'
import snmp, { type TrapPdu, type Varbind } from 'net-snmp'
import { getInBatches, type BatchResult, type GetFunction } from './client.js'
import {
	BASE_DEV_ENTRY,
	BaseDevColumn,
	ERROR_ENTRY,
	ErrorColumn,
	MATRIX5,
	SCALAR_DECODERS,
	SCALAR_OIDS,
	SNMP_TRAP_OID,
	TRAP_ADDRESS,
	TrapNumber,
	asInteger,
	asIpAddress,
	asOccured,
	asOnOff,
	asString,
	indexIn,
	type ScalarName,
	type Scalars,
	type TrapName,
} from './mib.js'

/** A row of baseDevTable. Any column the agent didn't give is left out */
export type BaseDevice = Partial<{
	online: boolean
	configBoards: number
	availBoards: number
	powerUnits: number
	pwrGoodUnits: number
	cpuTemperature: number
	cpuMaxTemp: number
}>

export type NexusError = { node: number; code: number; name: string; param: string }

/** A row of errorTable, or an error carried by a trap */
export type ErrorEvent = NexusError & { occured: boolean }

/** Everything read from the agent apart from the logic cells */
export type NexusStatus = {
	scalars: Partial<Scalars>
	devices: Map<number, BaseDevice>
	trapAddresses: string[]
	/** errorTable's rows, by index */
	errorEvents: ErrorEvent[]
	/** Scalars the agent doesn't have */
	missing: ScalarName[]
	failures: BatchResult['failures']
}

export type WalkFunction = (oid: string, signal?: AbortSignal) => Promise<Varbind[]>

export function parseScalars(varbinds: Varbind[]): { scalars: Partial<Scalars>; missing: ScalarName[] } {
	const byOid = new Map(varbinds.map((varbind) => [varbind.oid, varbind]))
	const scalars: Partial<Record<ScalarName, unknown>> = {}
	const missing: ScalarName[] = []
	for (const name of Object.keys(SCALAR_OIDS) as ScalarName[]) {
		const varbind = byOid.get(SCALAR_OIDS[name])
		const value = varbind ? SCALAR_DECODERS[name](varbind) : undefined
		if (value === undefined) missing.push(name)
		else scalars[name] = value
	}
	return { scalars: scalars as Partial<Scalars>, missing }
}

/** Groups a walked table's varbinds by row index, then by column number */
function rows(entry: string, varbinds: Varbind[]): Map<number, Map<number, Varbind>> {
	const result = new Map<number, Map<number, Varbind>>()
	for (const varbind of varbinds) {
		const match = varbind.oid.startsWith(`${entry}.`)
			? /^(\d+)\.(\d+)$/.exec(varbind.oid.slice(entry.length + 1))
			: null
		if (!match) continue
		const [column, index] = [Number(match[1]), Number(match[2])]
		let row = result.get(index)
		if (!row) {
			row = new Map()
			result.set(index, row)
		}
		row.set(column, varbind)
	}
	return result
}

function decode<T>(
	row: Map<number, Varbind>,
	column: number,
	decoder: (varbind: Varbind) => T | undefined,
): T | undefined {
	const varbind = row.get(column)
	return varbind ? decoder(varbind) : undefined
}

/** Drops the keys whose value is undefined, so a missing column is absent rather than present and undefined */
function defined<T extends object>(object: T): T {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T
}

/**
 * baseDevTable's rows, by base device node number. That comes from each row's deviceIndex, as the XCI numbers the
 * rows themselves from 1, see {@link BaseDevColumn.deviceIndex}. A row without one keeps its row number
 */
export function parseBaseDevTable(varbinds: Varbind[]): Map<number, BaseDevice> {
	const devices = new Map<number, BaseDevice>()
	for (const [index, row] of rows(BASE_DEV_ENTRY, varbinds)) {
		devices.set(
			decode(row, BaseDevColumn.deviceIndex, asInteger) ?? index,
			defined({
				online: decode(row, BaseDevColumn.deviceOnline, asOnOff),
				configBoards: decode(row, BaseDevColumn.configBoards, asInteger),
				availBoards: decode(row, BaseDevColumn.availBoards, asInteger),
				powerUnits: decode(row, BaseDevColumn.powerUnits, asInteger),
				pwrGoodUnits: decode(row, BaseDevColumn.pwrGoodUnits, asInteger),
				cpuTemperature: decode(row, BaseDevColumn.cpuTemperature, asInteger),
				cpuMaxTemp: decode(row, BaseDevColumn.cpuMaxTemp, asInteger),
			}),
		)
	}
	return new Map([...devices].sort(([a], [b]) => a - b))
}

export function parseTrapTable(varbinds: Varbind[]): string[] {
	return varbinds
		.map((varbind) => ({ index: indexIn(TRAP_ADDRESS, varbind.oid), address: asIpAddress(varbind) }))
		.filter((row): row is { index: number; address: string } => row.index !== undefined && row.address !== undefined)
		.sort((a, b) => a.index - b.index)
		.map(({ address }) => address)
}

/** errorTable's rows in index order. A row without a state, node or code is skipped */
export function parseErrorTable(varbinds: Varbind[]): ErrorEvent[] {
	const events: { index: number; event: ErrorEvent }[] = []
	for (const [index, row] of rows(ERROR_ENTRY, varbinds)) {
		const occured = decode(row, ErrorColumn.errorState, asOccured)
		const node = decode(row, ErrorColumn.errorNode, asInteger)
		const code = decode(row, ErrorColumn.errorCode, asInteger)
		if (occured === undefined || node === undefined || code === undefined) continue
		const name = decode(row, ErrorColumn.errorName, asString) ?? ''
		const param = decode(row, ErrorColumn.errorParam, asString) ?? ''
		events.push({ index, event: { occured, node, code, name, param } })
	}
	return events.sort((a, b) => a.index - b.index).map(({ event }) => event)
}

/**
 * Which of the MIB's traps this is, if any. In v2c the snmpTrapOID varbind says, in v1 the enterprise and specific trap
 */
export function trapName(pdu: TrapPdu): TrapName | undefined {
	let number: number | undefined
	if (pdu.type === snmp.PduType.Trap) {
		if (pdu.enterprise === MATRIX5 && pdu.generic === snmp.TrapType.EnterpriseSpecific) number = pdu.specific
	} else {
		const trapOid = pdu.varbinds.find((varbind) => varbind.oid === SNMP_TRAP_OID)?.value
		if (typeof trapOid === 'string') number = indexIn(`${MATRIX5}.0`, trapOid)
	}
	return (Object.keys(TrapNumber) as TrapName[]).find((name) => TrapNumber[name] === number)
}

/**
 * The errors an error trap carries. errorList and removeList carry several, so the varbinds are read in order, an error
 * starting at each errorNode. The trap's own state, occured or removed, applies to all of them
 */
export function parseErrorTrap(varbinds: Varbind[], occured: boolean): ErrorEvent[] {
	const column = (number: number): string => `${ERROR_ENTRY}.${number}`
	const events: ErrorEvent[] = []
	let current: Partial<ErrorEvent> | undefined
	const finish = (): void => {
		if (current?.node !== undefined && current.code !== undefined) {
			events.push({
				occured,
				node: current.node,
				code: current.code,
				name: current.name ?? '',
				param: current.param ?? '',
			})
		}
	}
	for (const varbind of varbinds) {
		const inColumn = (number: number): boolean => varbind.oid.startsWith(`${column(number)}.`)
		if (inColumn(ErrorColumn.errorNode)) {
			finish()
			current = { node: asInteger(varbind) }
		} else if (!current) {
			continue
		} else if (inColumn(ErrorColumn.errorCode)) {
			current.code = asInteger(varbind)
		} else if (inColumn(ErrorColumn.errorName)) {
			current.name = asString(varbind)
		} else if (inColumn(ErrorColumn.errorParam)) {
			current.param = asString(varbind)
		}
	}
	finish()
	return events
}

/**
 * The errors active on the Nexus.
 *
 * The MIB calls errorTable a "List of occured/removed Errors" without saying whether a row is an error with its current
 * state, or an event in a log. Taking the rows in index order with the latest state winning gives the same answer
 * either way. An error is told apart by its node, code and parameter: the MIB doesn't say what pairs a removal with
 * its error, and those are what both traps carry.
 */
export class NexusErrors {
	#active = new Map<string, NexusError>()
	/** The error that most recently occured, even if it has been removed since */
	last: NexusError | undefined

	static #key({ node, code, param }: NexusError): string {
		return JSON.stringify([node, code, param])
	}

	get active(): NexusError[] {
		return [...this.#active.values()]
	}

	/** Errors matching a node and code. 0 for either matches any */
	count({ node, code }: { node: number; code: number }): number {
		return this.active.filter((error) => (node === 0 || error.node === node) && (code === 0 || error.code === code))
			.length
	}

	/** @returns whether anything changed */
	apply(events: ErrorEvent[]): boolean {
		const before = this.#snapshot()
		for (const { occured, ...error } of events) {
			const key = NexusErrors.#key(error)
			if (occured) {
				this.#active.delete(key) // so it moves to the end, as the most recent
				this.#active.set(key, error)
				this.last = error
			} else {
				this.#active.delete(key)
			}
		}
		return !isDeepStrictEqual(before, this.#snapshot())
	}

	/** Replaces everything with errorTable's rows. @returns whether anything changed */
	replace(events: ErrorEvent[]): boolean {
		const before = this.#snapshot()
		this.#active.clear()
		this.last = undefined
		this.apply(events)
		return !isDeepStrictEqual(before, this.#snapshot())
	}

	clear(): void {
		this.#active.clear()
		this.last = undefined
	}

	#snapshot(): unknown {
		return [[...this.#active], this.last]
	}
}

/** The state of the Nexus as the agent reports it, apart from the logic cells */
export class NexusState {
	scalars: Partial<Scalars> = {}
	devices = new Map<number, BaseDevice>()
	trapAddresses: string[] = []
	readonly errors = new NexusErrors()

	/**
	 * The highest base device node number there can be, or undefined until read. A node number isn't a count, so a
	 * project with nodes 1, 3 and 7 has 3 base devices and a highest node of 7. This takes the larger of the highest
	 * node in baseDevTable and baseDevNum, which is the count where the nodes are numbered from 1, and also covers a
	 * configured device missing from the table
	 */
	get deviceLimit(): number | undefined {
		const limit = Math.max(0, ...this.devices.keys(), this.scalars.baseDevNum ?? 0)
		return limit > 0 ? limit : undefined
	}

	reset(): void {
		this.scalars = {}
		this.devices = new Map()
		this.trapAddresses = []
		this.errors.clear()
	}

	/**
	 * Applies a poll. The errors are left alone when `keepErrors` is set, for a poll during which an error trap arrived:
	 * the table it read is older than the trap
	 * @returns which parts changed
	 */
	update(
		status: NexusStatus,
		keepErrors: boolean,
	): { scalars: boolean; devices: boolean; deviceIds: boolean; trapAddresses: boolean; errors: boolean } {
		const changed = {
			scalars: !isDeepStrictEqual(this.scalars, status.scalars),
			devices: !isDeepStrictEqual(this.devices, status.devices),
			deviceIds: !isDeepStrictEqual([...this.devices.keys()], [...status.devices.keys()]),
			trapAddresses: !isDeepStrictEqual(this.trapAddresses, status.trapAddresses),
			errors: keepErrors ? false : this.errors.replace(status.errorEvents),
		}
		this.scalars = status.scalars
		this.devices = status.devices
		this.trapAddresses = status.trapAddresses
		return changed
	}
}

/**
 * Reads everything but the logic cells: the scalars in one batch, then a walk of each table
 * @throws as {@link getInBatches}, or whatever `walk` throws
 */
export async function pollStatus(get: GetFunction, walk: WalkFunction, signal?: AbortSignal): Promise<NexusStatus> {
	const { varbinds, failures } = await getInBatches(get, Object.values(SCALAR_OIDS), signal)
	const { scalars, missing } = parseScalars(varbinds)
	const devices = parseBaseDevTable(await walk(BASE_DEV_ENTRY, signal))
	const trapAddresses = parseTrapTable(await walk(TRAP_ADDRESS, signal))
	const errorEvents = parseErrorTable(await walk(ERROR_ENTRY, signal))
	return { scalars, devices, trapAddresses, errorEvents, missing, failures }
}
