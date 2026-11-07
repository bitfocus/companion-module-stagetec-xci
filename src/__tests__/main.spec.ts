import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { InstanceStatus, type CompanionFeedbackDefinitions } from '@companion-module/base'
import type snmp from 'net-snmp'
import ModuleInstance from '../main.js'
import type { ModuleConfig } from '../config.js'
import { FeedbackId, MAX_INTEGER, type FeedbackSchema } from '../feedbacks.js'
import { GET_BATCH_SIZE, type GetFunction, type XciClientOptions } from '../client.js'
import type { WalkFunction } from '../nexus.js'
import { CELL_COUNT, XCI_LOGIC_OID, logicCellOid } from '../xci.js'
import { ERROR_ENTRY, SCALAR_OIDS } from '../mib.js'
import {
	cellVarbind,
	checkFeedback,
	encodeTrap,
	errorVarbinds,
	fakeAgent,
	type AgentData,
	type TrapOptions,
} from './fixtures.js'

type FakeSharedSocket = EventEmitter & {
	state: 'pending' | 'binding' | 'bound' | 'closed'
	/** Completes a bind held by `shared.holdBind` */
	completeBind(): void
	/** Fails a bind held by `shared.holdBind` */
	failBind(err: Error): void
}

const shared = vi.hoisted(() => ({ sockets: [] as FakeSharedSocket[], holdBind: false }))

type FakeClient = {
	host: string
	community: string
	options: XciClientOptions
	get: Mock<GetFunction>
	walk: Mock<WalkFunction>
	closed: boolean
}

type Agent = { get: GetFunction; walk: WalkFunction }

/** Every XciClient made, and the agent they ask. client.spec.ts tests the real one against an agent */
const clients = vi.hoisted(() => {
	const agent: Agent = { get: async () => [], walk: async () => [] }
	return { made: [] as FakeClient[], agent }
})

vi.mock('../client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../client.js')>()
	class XciClient {
		readonly host: string
		readonly community: string
		readonly options: XciClientOptions
		closed = false
		get = vi.fn<GetFunction>(async (oids, signal) => clients.agent.get(oids, signal))
		walk = vi.fn<WalkFunction>(async (oid, signal) => clients.agent.walk(oid, signal))
		constructor(host: string, community: string, options: XciClientOptions) {
			this.host = host
			this.community = community
			this.options = options
			clients.made.push(this)
		}
		close(): void {
			this.closed = true
		}
	}
	return { ...actual, XciClient }
})

// Enough of InstanceBase to construct the module without a Companion host
vi.mock('@companion-module/base', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@companion-module/base')>()
	const { EventEmitter } = await import('node:events')
	/**
	 * Follows SharedUdpSocketImpl in base's shared-udp-socket.js: bind's callback is a `listening` listener, and close
	 * throws unless the socket is bound. Binds at once unless `shared.holdBind` is set
	 */
	class FakeSharedSocketImpl extends EventEmitter {
		state: 'pending' | 'binding' | 'bound' | 'closed' = 'pending'
		bind(_port: number, _address?: string, callback?: () => void): void {
			if (this.state !== 'pending') throw new Error('Socket is already bound')
			this.state = 'binding'
			if (callback) this.on('listening', callback)
			if (!shared.holdBind) process.nextTick(() => this.completeBind())
		}
		completeBind(): void {
			this.state = 'bound'
			this.emit('listening')
		}
		failBind(err: Error): void {
			this.state = 'closed'
			this.emit('error', err)
		}
		close(): void {
			if (this.state !== 'bound') throw new Error('Socket is not open')
			this.state = 'closed'
		}
		send(): void {}
	}
	class InstanceBase {
		constructor(_internal: unknown) {}
		log(): void {}
		updateStatus(): void {}
		checkFeedbacks(): void {}
		checkFeedbacksById(): void {}
		setVariableValues(): void {}
		setActionDefinitions(): void {}
		setFeedbackDefinitions(): void {}
		setVariableDefinitions(): void {}
		setPresetDefinitions(): void {}
		createSharedUdpSocket(): FakeSharedSocketImpl {
			const socket = new FakeSharedSocketImpl()
			shared.sockets.push(socket)
			return socket
		}
	}
	return { ...actual, InstanceBase }
})

const XCI = '192.0.2.10'
const CONFIG: ModuleConfig = { host: XCI, community: 'nexus', version: 'v2c', port: 161, pollInterval: 0 }

/**
 * As {@link fakeAgent}, but the first get waits until released, holding the poll that made it there. The cell poll
 * starts first, so it is the one held
 */
function holdFirstAnswer(data: AgentData): { release(): void; signal(): AbortSignal | undefined } {
	let release = (): void => {}
	let firstSignal: AbortSignal | undefined
	let held = false
	const agent = fakeAgent(data)
	clients.agent = {
		...agent,
		get: async (oids, signal) => {
			if (held) return agent.get(oids, signal)
			held = true
			firstSignal = signal
			await new Promise<void>((resolve) => (release = resolve))
			return agent.get(oids, signal)
		},
	}
	return { release: () => release(), signal: () => firstSignal }
}

/** An agent that never answers */
const timingOut: Agent = {
	get: async () => {
		throw Object.assign(new Error('Request timed out'), { name: 'RequestTimedOutError' })
	},
	walk: async () => {
		throw Object.assign(new Error('Request timed out'), { name: 'RequestTimedOutError' })
	},
}

/** Lets a poll whose requests all answer at once run to its end */
const settle = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Sends a trap to the module's shared socket, as Companion would pass it on */
function deliver(
	socket: FakeSharedSocket,
	varbinds: snmp.Varbind[],
	{ from = XCI, ...options }: TrapOptions & { from?: string } = {},
): void {
	const msg = encodeTrap(varbinds, options)
	socket.emit('message', msg, { address: from, family: 'IPv4', port: 50162, size: msg.length })
}

function spyOnHost(instance: ModuleInstance) {
	return {
		checkFeedbacks: vi.spyOn(instance, 'checkFeedbacks'),
		checkFeedbacksById: vi.spyOn(instance, 'checkFeedbacksById'),
		setVariableValues: vi.spyOn(instance, 'setVariableValues'),
		updateStatus: vi.spyOn(instance, 'updateStatus'),
		setFeedbackDefinitions: vi.spyOn(instance, 'setFeedbackDefinitions'),
		setVariableDefinitions: vi.spyOn(instance, 'setVariableDefinitions'),
		setPresetDefinitions: vi.spyOn(instance, 'setPresetDefinitions'),
	}
}

beforeEach(() => {
	shared.sockets.length = 0
	shared.holdBind = false
	clients.made.length = 0
	clients.agent = fakeAgent()
})

describe('with feedbacks on cells 4 and 5', () => {
	let instance: ModuleInstance
	let host: ReturnType<typeof spyOnHost>
	let definitions: CompanionFeedbackDefinitions<FeedbackSchema>
	let socket: FakeSharedSocket

	beforeEach(async () => {
		instance = new ModuleInstance({})
		host = spyOnHost(instance)
		await instance.init(CONFIG)
		await settle()
		socket = shared.sockets[0]
		definitions = host.setFeedbackDefinitions.mock.calls.at(-1)![0]
		// As Companion does on module start, for each feedback on a button
		checkFeedback(definitions, FeedbackId.Trap, { cell: 4 }, 'trap-4')
		checkFeedback(definitions, FeedbackId.TrapLatch, { cell: 4 }, 'latch-4')
		checkFeedback(definitions, FeedbackId.Trap, { cell: 5 }, 'trap-5')
		checkFeedback(definitions, FeedbackId.TrapLatch, { cell: 5 }, 'latch-5')
		vi.clearAllMocks()
	})
	afterEach(async () => {
		await instance.destroy()
	})

	it('a true trap rechecks only the feedbacks on its cell, and sets its variables', () => {
		deliver(socket, [cellVarbind(4, true)])

		expect(host.checkFeedbacksById).toHaveBeenCalledExactlyOnceWith('trap-4', 'latch-4')
		expect(host.checkFeedbacks).not.toHaveBeenCalled()
		expect(host.setVariableValues).toHaveBeenCalledExactlyOnceWith({
			mostRecent: 4,
			cellLatch_4: true,
			cellCount_4: 1,
		})
		expect(checkFeedback(definitions, FeedbackId.Trap, { cell: 4 }, 'trap-4')).toBe(true)
		// Ok already, from the listener and the polls
		expect(host.updateStatus).not.toHaveBeenCalled()
	})

	it('a repeated true trap counts again, and rechecks nothing', () => {
		deliver(socket, [cellVarbind(4, true)])
		vi.clearAllMocks()
		deliver(socket, [cellVarbind(4, true)])

		expect(host.checkFeedbacksById).not.toHaveBeenCalled()
		expect(host.setVariableValues).toHaveBeenCalledExactlyOnceWith({
			mostRecent: 4,
			cellLatch_4: true,
			cellCount_4: 2,
		})
	})

	it('a false trap rechecks only the trap feedbacks on its cell, as the latch stays set', () => {
		deliver(socket, [cellVarbind(4, true)])
		vi.clearAllMocks()
		deliver(socket, [cellVarbind(4, false)])

		expect(host.checkFeedbacksById).toHaveBeenCalledExactlyOnceWith('trap-4')
		expect(host.setVariableValues).not.toHaveBeenCalled()
	})

	it('several cells in one trap are rechecked in one call', () => {
		deliver(socket, [cellVarbind(4, true), cellVarbind(5, true), cellVarbind(6, true)])

		expect(host.checkFeedbacksById).toHaveBeenCalledExactlyOnceWith('trap-4', 'latch-4', 'trap-5', 'latch-5')
		expect(host.setVariableValues.mock.calls[0][0]).toMatchObject({ mostRecent: 6, cellCount_6: 1 })
	})

	it('a trap for a cell nothing watches rechecks nothing', () => {
		deliver(socket, [cellVarbind(9, true)])

		expect(host.checkFeedbacksById).not.toHaveBeenCalled()
		expect(host.setVariableValues).toHaveBeenCalledOnce()
	})

	it('ignores a trap with the wrong community', () => {
		deliver(socket, [cellVarbind(4, true)], { community: 'public' })

		expect(host.updateStatus).toHaveBeenCalledExactlyOnceWith(InstanceStatus.BadConfig, 'Incorrect community')
		expect(host.checkFeedbacksById).not.toHaveBeenCalled()
		expect(instance.cells.get(4).value).toBe(false)
	})

	it('ignores a trap from another address', () => {
		deliver(socket, [cellVarbind(4, true)], { from: '192.0.2.99' })

		expect(host.updateStatus).not.toHaveBeenCalled()
		expect(instance.cells.get(4).value).toBe(false)
	})

	it('resetting a count sets the count variable, not the latch one', () => {
		deliver(socket, [cellVarbind(4, true)])
		vi.clearAllMocks()
		instance.resetCount(4)

		expect(host.setVariableValues).toHaveBeenCalledExactlyOnceWith({ cellCount_4: 0 })
		expect(instance.cells.get(4)).toMatchObject({ latch: true, count: 0 })
	})

	it('resetting a set latch rechecks only the latched feedbacks on its cell', () => {
		deliver(socket, [cellVarbind(4, true)])
		vi.clearAllMocks()
		instance.resetLatch(4)

		expect(host.setVariableValues).toHaveBeenCalledExactlyOnceWith({ cellLatch_4: false })
		expect(host.checkFeedbacksById).toHaveBeenCalledExactlyOnceWith('latch-4')

		vi.clearAllMocks()
		instance.resetLatch(4)
		expect(host.checkFeedbacksById).not.toHaveBeenCalled()
	})

	it('resetting every latch or count sets every variable, and rechecks every latched feedback', () => {
		instance.resetAllLatches()
		expect(Object.keys(host.setVariableValues.mock.calls[0][0])).toHaveLength(CELL_COUNT)
		expect(host.checkFeedbacks).toHaveBeenCalledExactlyOnceWith(FeedbackId.TrapLatch)

		vi.clearAllMocks()
		instance.resetAllCounts()
		expect(host.setVariableValues.mock.calls[0][0]).toMatchObject({ cellCount_1: 0, [`cellCount_${CELL_COUNT}`]: 0 })
		expect(host.checkFeedbacks).not.toHaveBeenCalled()
	})

	// The JavaScript module rechecked only the trap feedbacks here, so a latched feedback stayed lit after its latch was
	// cleared by a config change
	it('a config change clears every cell, and rechecks every kind of feedback', async () => {
		deliver(socket, [cellVarbind(4, true)])
		vi.clearAllMocks()
		await instance.configUpdated({ ...CONFIG, community: 'other' })

		expect(host.checkFeedbacks).toHaveBeenCalledExactlyOnceWith(...Object.values(FeedbackId))
		expect(checkFeedback(definitions, FeedbackId.TrapLatch, { cell: 4 }, 'latch-4')).toBe(false)
		expect(host.setVariableValues.mock.calls[0][0]).toMatchObject({ mostRecent: 0, cellLatch_4: false, cellCount_4: 0 })
	})

	it('a config change closes the old socket and listens on a new one with the new settings', async () => {
		await instance.configUpdated({ ...CONFIG, community: 'other' })
		expect(socket.state).toBe('closed')
		expect(shared.sockets).toHaveLength(2)

		deliver(shared.sockets[1], [cellVarbind(4, true)], { community: 'other' })
		expect(instance.cells.get(4).value).toBe(true)
	})

	it('reports a socket error after binding', () => {
		socket.emit('error', new Error('socket gone'))
		expect(host.updateStatus).toHaveBeenCalledExactlyOnceWith(InstanceStatus.UnknownError, 'socket gone')
	})
})

describe('starting', () => {
	it('reports a missing IP, and opens no socket', async () => {
		const instance = new ModuleInstance({})
		const host = spyOnHost(instance)
		await instance.init({ ...CONFIG, host: '' })

		expect(host.updateStatus).toHaveBeenLastCalledWith(InstanceStatus.BadConfig, 'Missing IP')
		expect(shared.sockets).toHaveLength(0)
		expect(clients.made).toHaveLength(0)
	})

	// The JavaScript module closed the old socket unguarded, so the config change after a failed bind threw
	it('reports a socket that fails to bind, and recovers on the next config change', async () => {
		shared.holdBind = true
		const instance = new ModuleInstance({})
		const host = spyOnHost(instance)
		const starting = instance.init(CONFIG)
		shared.sockets[0].failBind(new Error('EACCES'))
		await starting
		expect(host.updateStatus).toHaveBeenLastCalledWith(InstanceStatus.UnknownError, 'EACCES')

		shared.holdBind = false
		await instance.configUpdated(CONFIG)
		expect(host.updateStatus).toHaveBeenLastCalledWith(InstanceStatus.Ok, undefined)
		await instance.destroy()
	})

	describe('a socket a config change replaced while it was binding', () => {
		let instance: ModuleInstance
		let host: ReturnType<typeof spyOnHost>
		let starting: Promise<void>
		let first: FakeSharedSocket

		beforeEach(async () => {
			shared.holdBind = true
			instance = new ModuleInstance({})
			host = spyOnHost(instance)
			starting = instance.init({ ...CONFIG, host: '192.0.2.20' })
			first = shared.sockets[0]
			shared.holdBind = false
			await instance.configUpdated(CONFIG)
			vi.clearAllMocks()
		})
		afterEach(async () => {
			await instance.destroy()
		})

		it('is closed once bound, without a receiver, and leaves the status alone', async () => {
			first.completeBind()
			await starting

			expect(first.state).toBe('closed')
			expect(first.listenerCount('message')).toBe(0)
			expect(host.updateStatus).not.toHaveBeenCalled()

			deliver(shared.sockets[1], [cellVarbind(4, true)])
			expect(instance.cells.get(4).value).toBe(true)
		})

		// Its configUpdated carried on once the bind resolved, and started polls that replaced the new config's
		it('starts no polls once bound', async () => {
			first.completeBind()
			await starting
			await settle()

			expect(clients.made).toHaveLength(1)
			expect(clients.made[0].closed).toBe(false)
		})

		it('is forgotten if its bind fails', async () => {
			first.failBind(new Error('EACCES'))
			await starting

			expect(host.updateStatus).not.toHaveBeenCalled()
		})
	})
})

describe('reading the logic cells', () => {
	let instance: ModuleInstance
	let host: ReturnType<typeof spyOnHost>

	beforeEach(() => {
		instance = new ModuleInstance({})
		host = spyOnHost(instance)
	})
	afterEach(async () => {
		await instance.destroy()
		vi.useRealTimers()
	})
	/** The cell polls a client has started, each asking first for cell 1 */
	const cellPolls = (client: FakeClient) => client.get.mock.calls.filter(([oids]) => oids[0] === logicCellOid(1))

	it('reads every cell on start, with the configured settings, and latches those found true', async () => {
		clients.agent = fakeAgent({ trueCells: [4] })
		await instance.init({ ...CONFIG, version: 'v1', port: 1161 })
		await settle()

		const [client] = clients.made
		expect(client).toMatchObject({ host: XCI, community: 'nexus', options: { version: 'v1', port: 1161 } })
		// The status poll's gets are for its scalars
		const cellGets = client.get.mock.calls.map(([oids]) => oids).filter((oids) => oids[0].startsWith(XCI_LOGIC_OID))
		expect(cellGets).toHaveLength(CELL_COUNT / GET_BATCH_SIZE)
		expect(cellGets.flat()).toEqual(Array.from({ length: CELL_COUNT }, (_, i) => logicCellOid(i + 1)))
		expect(instance.cells.get(4)).toEqual({ value: true, latch: true, count: 0 })
		expect(instance.cells.mostRecent).toBe(0)
		expect(host.setVariableValues).toHaveBeenCalledWith({ cellLatch_4: true })
	})

	it('rechecks only the feedbacks on the cells it finds changed', async () => {
		const poll = holdFirstAnswer({ trueCells: [4] })
		await instance.init(CONFIG)
		const definitions = host.setFeedbackDefinitions.mock.calls.at(-1)![0]
		checkFeedback(definitions, FeedbackId.Trap, { cell: 4 }, 'trap-4')
		checkFeedback(definitions, FeedbackId.TrapLatch, { cell: 4 }, 'latch-4')
		checkFeedback(definitions, FeedbackId.Trap, { cell: 5 }, 'trap-5')
		vi.clearAllMocks()

		poll.release()
		await settle()
		expect(host.checkFeedbacksById).toHaveBeenCalledExactlyOnceWith('trap-4', 'latch-4')
		expect(host.checkFeedbacks).not.toHaveBeenCalled()
	})

	it('keeps what a trap reported during the poll over the poll’s older reading', async () => {
		const poll = holdFirstAnswer({ trueCells: [4] })
		await instance.init(CONFIG)
		deliver(shared.sockets[0], [cellVarbind(4, false)])

		poll.release()
		await settle()
		expect(instance.cells.get(4)).toEqual({ value: false, latch: false, count: 0 })
	})

	it('reads again on a config change, abandoning the poll in flight and closing its client', async () => {
		const poll = holdFirstAnswer({ trueCells: [4] })
		await instance.init(CONFIG)
		clients.agent = fakeAgent({ trueCells: [5] })
		await instance.configUpdated({ ...CONFIG, community: 'other' })
		expect(poll.signal()?.aborted).toBe(true)

		poll.release()
		await settle()
		const [first, second] = clients.made
		expect(first.closed).toBe(true)
		expect(second).toMatchObject({ community: 'other', closed: false })
		expect(instance.cells.get(4).value).toBe(false)
		expect(instance.cells.get(5).value).toBe(true)
	})

	// The superseded poll ending must not end the new poll's record of the cells traps have reported
	it('keeps a trap over a poll that replaced one, whichever ends first', async () => {
		const releases: (() => void)[] = []
		const agent = fakeAgent({ trueCells: [4] })
		const seen = new Set<AbortSignal | undefined>()
		// Holds the first get of each config's polls, which is its cell poll's
		clients.agent = {
			...agent,
			get: async (oids, signal) => {
				if (!seen.has(signal)) {
					seen.add(signal)
					await new Promise<void>((resolve) => releases.push(resolve))
				}
				return agent.get(oids, signal)
			},
		}
		await instance.init(CONFIG)
		await instance.configUpdated(CONFIG)
		expect(releases).toHaveLength(2)

		releases[0]()
		await settle()
		deliver(shared.sockets[1], [cellVarbind(4, false)])
		releases[1]()
		await settle()
		expect(instance.cells.get(4)).toEqual({ value: false, latch: false, count: 0 })
	})

	it('leaves the status of a listener that failed to bind when the polls fail too', async () => {
		clients.agent = timingOut
		shared.holdBind = true
		const starting = instance.init(CONFIG)
		shared.sockets[0].failBind(new Error('EACCES'))
		await starting
		await settle()

		// Once for each poll
		expect(clients.made[0].get).toHaveBeenCalledTimes(2)
		expect(host.updateStatus).toHaveBeenLastCalledWith(InstanceStatus.UnknownError, 'EACCES')
	})

	it('warns of an XCI that does not answer, and stops asking', async () => {
		clients.agent = timingOut
		await instance.init(CONFIG)
		await settle()

		// Once for each poll, and the status poll walks nothing after its gets fail
		expect(clients.made[0].get).toHaveBeenCalledTimes(2)
		expect(clients.made[0].walk).not.toHaveBeenCalled()
		expect(host.updateStatus).toHaveBeenLastCalledWith(
			InstanceStatus.UnknownWarning,
			'Reading the logic cells failed: Request timed out',
		)
	})

	// As when Companion starts before a booting XCI card answers
	it('reads the cells again once the XCI answers a status read, until a read succeeds', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		clients.agent = timingOut
		await instance.init({ ...CONFIG, pollInterval: 10 })
		await settle()
		const [client] = clients.made
		expect(cellPolls(client)).toHaveLength(1)

		// The status read fails too, so the cells aren't asked again
		await vi.advanceTimersByTimeAsync(10_000)
		await settle()
		expect(cellPolls(client)).toHaveLength(1)

		clients.agent = fakeAgent({ trueCells: [4] })
		await vi.advanceTimersByTimeAsync(10_000)
		await settle()
		expect(cellPolls(client)).toHaveLength(2)
		expect(instance.cells.get(4)).toEqual({ value: true, latch: true, count: 0 })
		expect(host.updateStatus).toHaveBeenLastCalledWith(InstanceStatus.Ok, undefined)

		await vi.advanceTimersByTimeAsync(10_000)
		await settle()
		expect(cellPolls(client)).toHaveLength(2)
	})

	it('starts no second cell poll when Refresh’s status read succeeds while its cell poll is running', async () => {
		clients.agent = timingOut
		await instance.init(CONFIG)
		await settle()
		const [client] = clients.made
		const poll = holdFirstAnswer({ trueCells: [4] })

		instance.refresh()
		await settle()
		poll.release()
		await settle()
		// The one that failed on start, and Refresh's
		expect(cellPolls(client)).toHaveLength(2)
		expect(instance.cells.get(4).value).toBe(true)
		expect(host.updateStatus).toHaveBeenLastCalledWith(InstanceStatus.Ok, undefined)
	})

	it('closes the client on destroy', async () => {
		await instance.init(CONFIG)
		await instance.destroy()
		expect(clients.made[0].closed).toBe(true)
	})
})

const STATUS: AgentData = {
	scalars: { projectName: 'Studio 1', baseDevNum: 2, baseDevOnline: 2, syncIndex: 1 },
	devices: new Map([
		[
			1,
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
			2,
			{
				online: true,
				configBoards: 8,
				availBoards: 8,
				powerUnits: 2,
				pwrGoodUnits: 2,
				cpuTemperature: 44,
				cpuMaxTemp: 50,
			},
		],
	]),
	trapAddresses: ['192.0.2.50'],
}

const ERROR = { node: 3, code: 40, name: 'Board', param: 'slot 2' }

describe('reading the Nexus status', () => {
	let instance: ModuleInstance
	let host: ReturnType<typeof spyOnHost>
	/** Every variable value sent, the latest winning */
	const sent = () =>
		Object.assign({}, ...host.setVariableValues.mock.calls.map(([values]) => values)) as Record<string, unknown>
	const scalarGets = (client: FakeClient) =>
		client.get.mock.calls.filter(([oids]) => oids.includes(SCALAR_OIDS.projectName))

	beforeEach(() => {
		instance = new ModuleInstance({})
		host = spyOnHost(instance)
		clients.agent = fakeAgent(STATUS)
	})
	afterEach(async () => {
		await instance.destroy()
		vi.useRealTimers()
	})

	it('reads it on start, defines each base device’s variables, and sets them', async () => {
		await instance.init(CONFIG)
		await settle()

		const definitions = host.setVariableDefinitions.mock.calls.at(-1)![0]
		expect(definitions).toHaveProperty('deviceOnline_1')
		expect(definitions).toHaveProperty('cpuMaxTemp_2')
		expect(definitions).not.toHaveProperty('deviceOnline_3')
		expect(sent()).toMatchObject({
			projectName: 'Studio 1',
			syncIndex: 1,
			deviceOnline_1: true,
			cpuTemperature_2: 44,
			trapAddresses: '192.0.2.50',
			activeErrors: 0,
		})
		expect(host.checkFeedbacks.mock.calls.at(-1)!.toSorted()).toEqual(
			[FeedbackId.DeviceHealth, FeedbackId.SystemHealth, FeedbackId.SyncSource].toSorted(),
		)
	})

	it('sends only the variables that changed, and rechecks only the feedbacks reading them', async () => {
		await instance.init(CONFIG)
		await settle()
		vi.clearAllMocks()
		instance.refresh()
		await settle()
		expect(host.setVariableValues).not.toHaveBeenCalled()
		expect(host.checkFeedbacks).not.toHaveBeenCalled()

		clients.agent = fakeAgent({ ...STATUS, scalars: { ...STATUS.scalars, syncIndex: 2 } })
		instance.refresh()
		await settle()
		expect(host.setVariableValues).toHaveBeenCalledExactlyOnceWith({ syncIndex: 2 })
		expect(host.checkFeedbacks).toHaveBeenCalledExactlyOnceWith(FeedbackId.SystemHealth, FeedbackId.SyncSource)
	})

	it('reads it again every poll interval, until the config changes', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		await instance.init({ ...CONFIG, pollInterval: 10 })
		await settle()
		const [client] = clients.made
		expect(scalarGets(client)).toHaveLength(1)

		await vi.advanceTimersByTimeAsync(10_000)
		await settle()
		expect(scalarGets(client)).toHaveLength(2)

		await instance.configUpdated({ ...CONFIG, pollInterval: 10, community: 'other' })
		await vi.advanceTimersByTimeAsync(30_000)
		await settle()
		expect(scalarGets(client)).toHaveLength(2)
	})

	it('reads it only on start with a poll interval of 0', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		await instance.init(CONFIG)
		await settle()
		await vi.advanceTimersByTimeAsync(3_600_000)
		expect(scalarGets(clients.made[0])).toHaveLength(1)
	})

	it('clears a failed poll’s warning once the XCI answers', async () => {
		clients.agent = timingOut
		await instance.init(CONFIG)
		await settle()
		expect(host.updateStatus.mock.calls.at(-1)?.[0]).toBe(InstanceStatus.UnknownWarning)

		clients.agent = fakeAgent(STATUS)
		instance.refresh()
		await settle()
		expect(host.updateStatus).toHaveBeenLastCalledWith(InstanceStatus.Ok, undefined)
	})

	it('lists each base device read in the health presets, and drops them on a config change', async () => {
		const presetGroup = () => host.setPresetDefinitions.mock.calls.at(-1)![0][0].definitions[0]
		await instance.init(CONFIG)
		expect(presetGroup()).toMatchObject({ type: 'simple' })
		await settle()
		expect(presetGroup()).toMatchObject({ type: 'template', templateValues: [{ value: 1 }, { value: 2 }] })

		clients.agent = fakeAgent()
		await instance.configUpdated(CONFIG)
		await settle()
		expect(presetGroup()).toMatchObject({ type: 'simple' })
	})

	it('limits Base Device Health’s device option to the devices read, and widens it again on a config change', async () => {
		const deviceMax = () => {
			const definition = host.setFeedbackDefinitions.mock.calls.at(-1)![0][FeedbackId.DeviceHealth]
			if (!definition) throw new Error('No Base Device Health feedback')
			const device = definition.options.find(({ id }) => id === 'device')
			return device?.type === 'number' ? device.max : undefined
		}
		await instance.init(CONFIG)
		expect(deviceMax()).toBe(MAX_INTEGER)
		await settle()
		expect(deviceMax()).toBe(2)
		expect(host.checkFeedbacks.mock.calls.at(-1)).toContain(FeedbackId.DeviceHealth)

		clients.agent = fakeAgent()
		await instance.configUpdated(CONFIG)
		expect(deviceMax()).toBe(MAX_INTEGER)
	})

	it('sets the feedback definitions again only when the device limit changes', async () => {
		await instance.init(CONFIG)
		await settle()
		vi.clearAllMocks()
		instance.refresh()
		await settle()
		expect(host.setFeedbackDefinitions).not.toHaveBeenCalled()

		// baseDevNum alone raising the limit, with the table unchanged
		clients.agent = fakeAgent({ ...STATUS, scalars: { ...STATUS.scalars, baseDevNum: 4 } })
		instance.refresh()
		await settle()
		expect(host.setFeedbackDefinitions).toHaveBeenCalledOnce()
		expect(host.checkFeedbacks.mock.calls.at(-1)).toContain(FeedbackId.DeviceHealth)
	})

	it('drops the base device variables on a config change, until read again', async () => {
		await instance.init(CONFIG)
		await settle()
		clients.agent = fakeAgent()
		await instance.configUpdated(CONFIG)
		await settle()
		expect(host.setVariableDefinitions.mock.calls.at(-1)![0]).not.toHaveProperty('deviceOnline_1')
		expect(sent()).toMatchObject({ projectName: undefined })
	})

	describe('error traps', () => {
		beforeEach(async () => {
			await instance.init(CONFIG)
			await settle()
			vi.clearAllMocks()
		})

		it('an errorOccured trap adds its error, and rechecks the feedbacks counting errors', () => {
			deliver(shared.sockets[0], errorVarbinds(7, ERROR), { trap: 'errorOccured' })

			expect(host.setVariableValues).toHaveBeenCalledExactlyOnceWith({
				activeErrors: 1,
				activeErrorNames: 'Board',
				lastErrorNode: 3,
				lastErrorCode: 40,
				lastErrorName: 'Board',
				lastErrorParam: 'slot 2',
			})
			expect(host.checkFeedbacks).toHaveBeenCalledExactlyOnceWith(FeedbackId.ErrorCount, FeedbackId.SystemHealth)
			expect(host.checkFeedbacksById).not.toHaveBeenCalled()
		})

		it('an errorRemoved trap removes it, keeping it as the last error', () => {
			deliver(shared.sockets[0], errorVarbinds(7, ERROR), { trap: 'errorOccured' })
			vi.clearAllMocks()
			deliver(shared.sockets[0], errorVarbinds(8, ERROR), { trap: 'errorRemoved' })

			expect(host.setVariableValues).toHaveBeenCalledExactlyOnceWith({ activeErrors: 0, activeErrorNames: '' })
			expect(instance.nexus.errors.last).toEqual(ERROR)
		})

		it('reads the several errors in v1 errorList and removeList traps', () => {
			const other = { node: 4, code: 41, name: 'Power', param: '' }
			deliver(shared.sockets[0], [...errorVarbinds(1, ERROR), ...errorVarbinds(2, other)], {
				version: 'v1',
				trap: 'errorList',
			})
			expect(instance.nexus.errors.active).toEqual([ERROR, other])

			deliver(shared.sockets[0], [...errorVarbinds(3, ERROR), ...errorVarbinds(4, other)], {
				version: 'v1',
				trap: 'removeList',
			})
			expect(instance.nexus.errors.active).toEqual([])
		})

		it('a trap repeating an active error changes nothing', () => {
			deliver(shared.sockets[0], errorVarbinds(7, ERROR), { trap: 'errorOccured' })
			vi.clearAllMocks()
			deliver(shared.sockets[0], errorVarbinds(7, ERROR), { trap: 'errorOccured' })
			expect(host.setVariableValues).not.toHaveBeenCalled()
			expect(host.checkFeedbacks).not.toHaveBeenCalled()
		})
	})

	it('keeps an error trap that arrives during the poll over the older error table the poll read', async () => {
		let release = (): void => {}
		const agent = fakeAgent(STATUS)
		clients.agent = {
			...agent,
			walk: async (oid, signal) => {
				if (oid === ERROR_ENTRY) await new Promise<void>((resolve) => (release = resolve))
				return agent.walk(oid, signal)
			},
		}
		await instance.init(CONFIG)
		await settle()
		deliver(shared.sockets[0], errorVarbinds(7, ERROR), { trap: 'errorOccured' })
		release()
		await settle()
		expect(instance.nexus.errors.active).toEqual([ERROR])

		// The next poll's table is newer than the trap, and the XCI's table has no errors
		clients.agent = agent
		instance.refresh()
		await settle()
		expect(instance.nexus.errors.active).toEqual([])
	})

	it('reads logic cells from a v1 signalList trap', async () => {
		await instance.init(CONFIG)
		await settle()
		deliver(shared.sockets[0], [cellVarbind(4, true)], { version: 'v1', trap: 'signalList' })
		expect(instance.cells.get(4).value).toBe(true)
	})
})
