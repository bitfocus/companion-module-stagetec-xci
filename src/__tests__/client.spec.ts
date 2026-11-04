import { createSocket } from 'node:dgram'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import snmp from 'net-snmp'
import { XciClient, isTimeout, type SnmpVersion } from '../client.js'
import { CELL_COUNT, XCI_LOGIC_OID, logicCellOid, pollLogicCells } from '../xci.js'

/** The parts of net-snmp's agent used here. @types/net-snmp declares createAgent as returning any */
type Agent = {
	getMib(): { registerProvider(provider: unknown): void; addTableRow(name: string, row: unknown[]): void }
	close(callback?: () => void): void
}

/** A cell the agent reports true. Every third one, so batches mix true and false */
const isTrue = (cell: number): boolean => cell % 3 === 0

async function freePort(): Promise<number> {
	const socket = createSocket('udp4')
	await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
	const { port } = socket.address()
	await new Promise<void>((resolve) => socket.close(resolve))
	return port
}

/**
 * net-snmp's own agent, serving the XCI's logic cell table: the entry is the logic OID less its column, and the cell
 * number is the index. Cell 256 is left out, as HELP.md says the test system's 256th cell doesn't report correctly.
 * This is how the table is laid out if the trap OIDs are readable, which the XCI's MIB has still to confirm.
 */
function startAgent(port: number): Agent {
	const agent = snmp.createAgent(
		{
			port,
			address: '127.0.0.1',
			disableAuthorization: true,
			accessControlModelType: snmp.AccessControlModelType.None,
		},
		() => {},
	) as Agent
	const mib = agent.getMib()
	mib.registerProvider({
		name: 'xciLogicTable',
		type: snmp.MibProviderType.Table,
		oid: XCI_LOGIC_OID.replace(/\.2\.$/, ''),
		maxAccess: snmp.MaxAccess['not-accessible'],
		tableColumns: [
			{ number: 1, name: 'cell', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
			{ number: 2, name: 'state', type: snmp.ObjectType.Integer, maxAccess: snmp.MaxAccess['read-only'] },
		],
		tableIndex: [{ columnName: 'cell' }],
	})
	for (let cell = 1; cell < CELL_COUNT; cell++) mib.addTableRow('xciLogicTable', [cell, isTrue(cell) ? 2 : 1])
	return agent
}

let port: number
let agent: Agent

beforeAll(async () => {
	port = await freePort()
	agent = startAgent(port)
})
afterAll(async () => {
	await new Promise<void>((resolve) => agent.close(resolve))
})

describe.each(['v1', 'v2c'] as const satisfies SnmpVersion[])('XciClient in %s', (version) => {
	it('gets the logic cells', async () => {
		const client = new XciClient('127.0.0.1', 'public', { version, port })
		try {
			const varbinds = await client.get([logicCellOid(1), logicCellOid(3)])
			expect(varbinds.map(({ oid, value }) => [oid, value])).toEqual([
				[logicCellOid(1), 1],
				[logicCellOid(3), 2],
			])
		} finally {
			client.close()
		}
	})

	it('walks a table column, in order, to its end', async () => {
		const client = new XciClient('127.0.0.1', 'public', { version, port })
		try {
			const varbinds = await client.walk(XCI_LOGIC_OID.slice(0, -1))
			expect(varbinds.map(({ oid }) => oid)).toEqual(
				Array.from({ length: CELL_COUNT - 1 }, (_, i) => logicCellOid(i + 1)),
			)
			expect(await client.walk(`${XCI_LOGIC_OID}9999`)).toEqual([])
		} finally {
			client.close()
		}
	})

	it('reads every cell the agent has, losing only the one it lacks', async () => {
		const client = new XciClient('127.0.0.1', 'public', { version, port })
		try {
			const { reports, problems, failures } = await pollLogicCells(async (oids, signal) => client.get(oids, signal))
			expect(reports).toHaveLength(CELL_COUNT - 1)
			expect(reports.every(({ cell, value }) => value === isTrue(cell))).toBe(true)
			// net-snmp's agent answers for the missing cell with a noSuchInstance varbind even in v1, where a v1 agent should
			// fail the request with noSuchName. So the v1 fallback in pollLogicCells is tested in xci.spec.ts instead
			expect(problems.map(({ kind, varbind }) => [kind, varbind.oid])).toEqual([
				['varbind-error', logicCellOid(CELL_COUNT)],
			])
			expect(failures).toEqual([])
		} finally {
			client.close()
		}
	})
})

describe('XciClient', () => {
	it('times out against a port nothing answers on', async () => {
		const client = new XciClient('127.0.0.1', 'public', {
			version: 'v2c',
			port: await freePort(),
			timeout: 50,
			retries: 0,
		})
		try {
			const error = await client.get([logicCellOid(1)]).catch((e: unknown) => e)
			expect(isTimeout(error)).toBe(true)
		} finally {
			client.close()
		}
	})

	it('rejects a request in flight when aborted, and one queued behind it', async () => {
		const client = new XciClient('127.0.0.1', 'public', { version: 'v2c', port: await freePort(), timeout: 5000 })
		try {
			const controller = new AbortController()
			const inFlight = client.get([logicCellOid(1)], controller.signal)
			const queued = client.get([logicCellOid(2)], controller.signal)
			controller.abort()
			await expect(inFlight).rejects.toThrow()
			await expect(queued).rejects.toThrow()
		} finally {
			client.close()
		}
	})

	it('stops a walk when aborted', async () => {
		const client = new XciClient('127.0.0.1', 'public', { version: 'v2c', port })
		try {
			const controller = new AbortController()
			const walking = client.walk(XCI_LOGIC_OID.slice(0, -1), controller.signal)
			controller.abort()
			await expect(walking).rejects.toThrow(/abort/)
		} finally {
			client.close()
		}
	})

	it('fails requests once closed', async () => {
		const client = new XciClient('127.0.0.1', 'public', { version: 'v2c', port })
		client.close()
		await expect(client.get([logicCellOid(1)])).rejects.toThrow(/closed/)
	})
})
