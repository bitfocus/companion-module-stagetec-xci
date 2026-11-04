import { describe, expect, it, vi } from 'vitest'
import snmp, { type TrapPdu } from 'net-snmp'
import { MATRIX5, SCALAR_OIDS, SIGNAL_VALUE, SNMP_TRAP_OID, type Scalars } from '../mib.js'
import {
	NexusErrors,
	NexusState,
	parseBaseDevTable,
	parseErrorTable,
	parseErrorTrap,
	parseScalars,
	parseTrapTable,
	pollStatus,
	trapName,
	type BaseDevice,
	type ErrorEvent,
	type NexusStatus,
} from '../nexus.js'
import { GET_BATCH_SIZE, type GetFunction } from '../client.js'
import { BASE_DEV_ENTRY, ERROR_ENTRY, TRAP_ADDRESS } from '../mib.js'
import { agentVarbinds, errorVarbinds, fakeAgent } from './fixtures.js'

const SCALARS: Scalars = {
	projectName: 'Studio 1',
	projectRevision: '5.12',
	baseDevNum: 2,
	baseDevOnline: 1,
	syncSources: 3,
	syncIndex: 2,
	hostName: 'xci-a',
	deviceType: 'XCI03',
	moduleName: 'MATRIX5-MIB',
	moduleVersion: '1.03',
	firstSignal: 1,
	configSignals: 64,
	trapSignals: 32,
	trapDestinations: 2,
	trapDestAuto: false,
	trapTimeout: 5,
}

const DEVICES = new Map<number, BaseDevice>([
	[
		3,
		{
			online: true,
			configBoards: 10,
			availBoards: 10,
			powerUnits: 2,
			pwrGoodUnits: 2,
			cpuTemperature: 41,
			cpuMaxTemp: 55,
		},
	],
	[
		1,
		{
			online: false,
			configBoards: 8,
			availBoards: 7,
			powerUnits: 2,
			pwrGoodUnits: 1,
			cpuTemperature: 48,
			cpuMaxTemp: 60,
		},
	],
])

const error = (node: number, code: number, occured = true, param = ''): ErrorEvent => ({
	occured,
	node,
	code,
	name: `E${code}`,
	param,
})

describe('MATRIX5-MIB', () => {
	it('puts the logic cells where the JavaScript module read them from traps', () => {
		expect(SIGNAL_VALUE).toBe('1.3.6.1.4.1.40085.1.1.1.3.2.3.1.2.')
	})

	it('has its scalars in one get', () => {
		expect(Object.keys(SCALAR_OIDS).length).toBeLessThanOrEqual(GET_BATCH_SIZE)
	})
})

describe('parseScalars', () => {
	it('decodes every scalar, strings from their octets and OnOff to a boolean', () => {
		expect(parseScalars(agentVarbinds({ scalars: SCALARS }))).toEqual({ scalars: SCALARS, missing: [] })
	})

	it('lists the scalars the agent lacks, or gives with the wrong type', () => {
		const varbinds = agentVarbinds({ scalars: { projectName: 'Studio 1' } })
		varbinds.push(
			{ oid: SCALAR_OIDS.baseDevNum, type: snmp.ObjectType.NoSuchObject, value: null },
			{ oid: SCALAR_OIDS.syncIndex, type: snmp.ObjectType.OctetString, value: Buffer.from('2') },
		)
		const { scalars, missing } = parseScalars(varbinds)
		expect(scalars).toEqual({ projectName: 'Studio 1' })
		expect(missing).toContain('baseDevNum')
		expect(missing).toContain('syncIndex')
		expect(missing).toHaveLength(Object.keys(SCALAR_OIDS).length - 1)
	})
})

describe('tables', () => {
	it('reads every base device, in index order, leaving out the columns the agent lacks', () => {
		const varbinds = agentVarbinds({ devices: new Map([...DEVICES, [2, { online: true }]]) })
		const devices = parseBaseDevTable(varbinds.filter(({ oid }) => oid.startsWith(BASE_DEV_ENTRY)))
		expect([...devices.keys()]).toEqual([1, 2, 3])
		expect(devices.get(1)).toEqual(DEVICES.get(1))
		expect(devices.get(2)).toEqual({ online: true })
	})

	// Seen on a real XCI: the third base device, node 10, read as device 3
	it('numbers each base device by its node, not its row', () => {
		const nodes = [1, 2, 10, 11, 12]
		const varbinds = agentVarbinds({
			devices: new Map(nodes.map((node) => [node, { online: true, cpuTemperature: node }])),
		})
		const devices = parseBaseDevTable(varbinds.filter(({ oid }) => oid.startsWith(BASE_DEV_ENTRY)))
		expect([...devices.keys()]).toEqual(nodes)
		expect(devices.get(10)).toEqual({ online: true, cpuTemperature: 10 })
		expect(devices.has(3)).toBe(false)
	})

	it('falls back to the row for a base device without a node number', () => {
		const varbinds = agentVarbinds({ devices: new Map([[10, { online: true }]]) }).filter(
			({ oid }) => oid.startsWith(BASE_DEV_ENTRY) && !oid.startsWith(`${BASE_DEV_ENTRY}.1.`),
		)
		expect([...parseBaseDevTable(varbinds).keys()]).toEqual([1])
	})

	it('reads the trap destinations in index order', () => {
		const varbinds = agentVarbinds({ trapAddresses: ['192.0.2.1', '192.0.2.2'] }).reverse()
		expect(parseTrapTable(varbinds.filter(({ oid }) => oid.startsWith(TRAP_ADDRESS)))).toEqual([
			'192.0.2.1',
			'192.0.2.2',
		])
	})

	it('reads the error table in index order, skipping a row without a state, node or code', () => {
		const varbinds = agentVarbinds({ errors: [error(1, 10), error(2, 20, false, 'slot 4')] })
		const incomplete = { oid: `${ERROR_ENTRY}.3.9`, type: snmp.ObjectType.Integer, value: 4 }
		expect(
			parseErrorTable([...varbinds.filter(({ oid }) => oid.startsWith(ERROR_ENTRY)).reverse(), incomplete]),
		).toEqual([error(1, 10), error(2, 20, false, 'slot 4')])
	})
})

describe('error traps', () => {
	it('reads the one error errorOccured carries', () => {
		const varbinds: snmp.Varbind[] = [
			{ oid: '1.3.6.1.2.1.1.5.0', type: snmp.ObjectType.OctetString, value: Buffer.from('xci') },
		]
		varbinds.push(...errorVarbinds(12, { node: 3, code: 40, name: 'Board', param: 'slot 2' }))
		expect(parseErrorTrap(varbinds, true)).toEqual([
			{ occured: true, node: 3, code: 40, name: 'Board', param: 'slot 2' },
		])
	})

	it('reads the several errors a v1 errorList or removeList carries', () => {
		const varbinds = [
			...errorVarbinds(1, { node: 3, code: 40, name: 'A', param: '' }),
			...errorVarbinds(2, { node: 4, code: 41, name: 'B', param: 'x' }),
		]
		expect(parseErrorTrap(varbinds, false)).toEqual([
			{ occured: false, node: 3, code: 40, name: 'A', param: '' },
			{ occured: false, node: 4, code: 41, name: 'B', param: 'x' },
		])
	})
})

describe('trapName', () => {
	const pdu = (fields: Partial<TrapPdu>): TrapPdu => ({ id: 1, type: snmp.PduType.TrapV2, varbinds: [], ...fields })

	it('reads a v2c trap from its snmpTrapOID', () => {
		const trap = (oid: string) => pdu({ varbinds: [{ oid: SNMP_TRAP_OID, type: snmp.ObjectType.OID, value: oid }] })
		expect(trapName(trap(`${MATRIX5}.0.1`))).toBe('signalChange')
		expect(trapName(trap(`${MATRIX5}.0.5`))).toBe('errorRemoved')
		expect(trapName(trap(`${MATRIX5}.0.9`))).toBeUndefined()
		expect(trapName(trap('1.3.6.1.6.3.1.1.5.1'))).toBeUndefined()
	})

	it('reads a v1 trap from its enterprise and specific trap', () => {
		const trap = (fields: Partial<TrapPdu>) =>
			pdu({ type: snmp.PduType.Trap, enterprise: MATRIX5, generic: snmp.TrapType.EnterpriseSpecific, ...fields })
		expect(trapName(trap({ specific: 4 }))).toBe('errorList')
		expect(trapName(trap({ specific: 6 }))).toBe('removeList')
		expect(trapName(trap({ specific: 4, enterprise: '1.3.6.1.4.1.9' }))).toBeUndefined()
		expect(trapName(trap({ specific: 4, generic: snmp.TrapType.ColdStart }))).toBeUndefined()
	})
})

describe('NexusErrors', () => {
	it('keeps the errors occured and not removed since, telling them apart by node, code and parameter', () => {
		const errors = new NexusErrors()
		errors.replace([error(1, 10), error(1, 10, true, 'a'), error(2, 20), error(1, 10, false)])
		expect(errors.active.map(({ node, code, param }) => [node, code, param])).toEqual([
			[1, 10, 'a'],
			[2, 20, ''],
		])
		expect(errors.last).toMatchObject({ node: 2, code: 20 })
	})

	it('keeps the last error once it has been removed', () => {
		const errors = new NexusErrors()
		errors.apply([error(1, 10)])
		errors.apply([error(1, 10, false)])
		expect(errors.active).toEqual([])
		expect(errors.last).toMatchObject({ node: 1, code: 10 })
	})

	it('counts the errors matching a node and code, 0 matching any', () => {
		const errors = new NexusErrors()
		errors.apply([error(1, 10), error(1, 11), error(2, 10)])
		expect(errors.count({ node: 0, code: 0 })).toBe(3)
		expect(errors.count({ node: 1, code: 0 })).toBe(2)
		expect(errors.count({ node: 0, code: 10 })).toBe(2)
		expect(errors.count({ node: 2, code: 11 })).toBe(0)
	})

	it('says whether anything changed', () => {
		const errors = new NexusErrors()
		expect(errors.apply([error(1, 10)])).toBe(true)
		expect(errors.apply([error(2, 20, false)])).toBe(false)
		expect(errors.replace([error(1, 10)])).toBe(false)
		expect(errors.replace([])).toBe(true)
	})
})

describe('NexusState.update', () => {
	const status = (fields: Partial<NexusStatus> = {}): NexusStatus => ({
		scalars: {},
		devices: new Map(),
		trapAddresses: [],
		errorEvents: [],
		missing: [],
		failures: [],
		...fields,
	})

	it('says which parts changed', () => {
		const nexus = new NexusState()
		expect(nexus.update(status({ scalars: { syncIndex: 1 }, devices: DEVICES }), false)).toEqual({
			scalars: true,
			devices: true,
			deviceIds: true,
			trapAddresses: false,
			errors: false,
		})
		const changedDevice = new Map(DEVICES)
		changedDevice.set(3, { ...DEVICES.get(3), cpuTemperature: 42 })
		expect(nexus.update(status({ scalars: { syncIndex: 1 }, devices: changedDevice }), false)).toEqual({
			scalars: false,
			devices: true,
			deviceIds: false,
			trapAddresses: false,
			errors: false,
		})
	})

	it('leaves the errors alone when asked to', () => {
		const nexus = new NexusState()
		nexus.errors.apply([error(1, 10)])
		expect(nexus.update(status(), true).errors).toBe(false)
		expect(nexus.errors.active).toHaveLength(1)
		expect(nexus.update(status(), false).errors).toBe(true)
		expect(nexus.errors.active).toHaveLength(0)
	})
})

describe('NexusState.deviceLimit', () => {
	const limit = (devices: number[], baseDevNum?: number): number | undefined => {
		const nexus = new NexusState()
		nexus.devices = new Map(devices.map((device) => [device, {}]))
		if (baseDevNum !== undefined) nexus.scalars = { baseDevNum }
		return nexus.deviceLimit
	}

	it('is undefined until read', () => {
		expect(limit([])).toBeUndefined()
		expect(limit([], 0)).toBeUndefined()
	})

	it('is the count where the nodes are numbered from 1', () => {
		expect(limit([1, 2, 3], 3)).toBe(3)
	})

	// A node number isn't a count: limiting to baseDevNum would rule out node 7
	it('is the highest node where the nodes are not numbered from 1', () => {
		expect(limit([1, 3, 7], 3)).toBe(7)
	})

	it('covers a configured device missing from the table', () => {
		expect(limit([1, 2], 4)).toBe(4)
		expect(limit([], 2)).toBe(2)
	})
})

describe('pollStatus', () => {
	it('reads the scalars in one get, then walks each table', async () => {
		const agent = fakeAgent({
			scalars: SCALARS,
			devices: DEVICES,
			trapAddresses: ['192.0.2.1'],
			errors: [error(1, 10)],
		})
		const get = vi.fn(agent.get)
		const walk = vi.fn(agent.walk)
		const signal = new AbortController().signal
		const status = await pollStatus(get, walk, signal)

		expect(get).toHaveBeenCalledOnce()
		expect(walk.mock.calls).toEqual([
			[BASE_DEV_ENTRY, signal],
			[TRAP_ADDRESS, signal],
			[ERROR_ENTRY, signal],
		])
		expect(status).toEqual({
			scalars: SCALARS,
			devices: new Map([...DEVICES].sort(([a], [b]) => a - b)),
			trapAddresses: ['192.0.2.1'],
			errorEvents: [error(1, 10)],
			missing: [],
			failures: [],
		})
	})

	it('reads the rest of the scalars when a v1 agent fails the batch over one', async () => {
		const agent = fakeAgent({ scalars: { ...SCALARS } })
		const get = vi.fn<GetFunction>(async (oids, signal) => {
			if (oids.includes(SCALAR_OIDS.trapTimeout)) {
				throw Object.assign(new Error(`NoSuchName: ${SCALAR_OIDS.trapTimeout}`), { name: 'RequestFailedError' })
			}
			return agent.get(oids, signal)
		})
		const status = await pollStatus(get, agent.walk)
		expect(status.failures.map(({ oid }) => oid)).toEqual([SCALAR_OIDS.trapTimeout])
		expect(status.missing).toEqual(['trapTimeout'])
		expect(status.scalars.projectName).toBe('Studio 1')
	})
})
