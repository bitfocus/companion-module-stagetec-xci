import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import snmp from 'net-snmp'
import type {
	CompanionActionCallbackContext,
	CompanionActionDefinitions,
	CompanionFeedbackBooleanEvent,
	CompanionFeedbackCallbackContext,
	CompanionFeedbackContext,
	CompanionFeedbackDefinitions,
	CompanionFeedbackInfo,
	CompanionOptionValues,
} from '@companion-module/base'
import type ModuleInstance from '../main.js'
import { UpdateActions, type ActionId, type ActionSchema } from '../actions.js'
import { UpdateFeedbacks, type FeedbackId, type FeedbackSchema } from '../feedbacks.js'
import { FeedbackSubscriptions } from '../subscriptions.js'
import { CELL_COUNT, LogicCells, logicCellOid } from '../xci.js'
import { compareOids, type GetFunction } from '../client.js'
import {
	BASE_DEV_ENTRY,
	BaseDevColumn,
	ERROR_ENTRY,
	ErrorColumn,
	MATRIX5,
	SCALAR_OIDS,
	TRAP_ADDRESS,
	TrapNumber,
	type Scalars,
	type TrapName,
} from '../mib.js'
import { NexusState, type BaseDevice, type ErrorEvent, type WalkFunction } from '../nexus.js'

function createMocks() {
	return {
		resetLatch: vi.fn<ModuleInstance['resetLatch']>(),
		resetAllLatches: vi.fn<ModuleInstance['resetAllLatches']>(),
		resetCount: vi.fn<ModuleInstance['resetCount']>(),
		resetAllCounts: vi.fn<ModuleInstance['resetAllCounts']>(),
		refresh: vi.fn<ModuleInstance['refresh']>(),
		setActionDefinitions: vi.fn<(defs: CompanionActionDefinitions<ActionSchema>) => void>(),
		setFeedbackDefinitions: vi.fn<(defs: CompanionFeedbackDefinitions<FeedbackSchema>) => void>(),
	}
}

export type FakeInstance = { self: ModuleInstance; cells: LogicCells; nexus: NexusState } & ReturnType<
	typeof createMocks
>

/**
 * A plain object standing in for the instance, for the definitions to be built from. The cell state and the feedback
 * subscriptions are real; everything that would reach Companion is a mock.
 */
export function fakeInstance(): FakeInstance {
	const mocks = createMocks()
	const cells = new LogicCells()
	const nexus = new NexusState()
	const self = {
		cells,
		nexus,
		trapFeedbacks: new FeedbackSubscriptions(),
		latchFeedbacks: new FeedbackSubscriptions(),
		...mocks,
	} as unknown as ModuleInstance
	return { self, cells, nexus, ...mocks }
}

export function actionDefinitions(fake: FakeInstance): CompanionActionDefinitions<ActionSchema> {
	UpdateActions(fake.self)
	return fake.setActionDefinitions.mock.calls[0][0]
}

export function feedbackDefinitions(fake: FakeInstance): CompanionFeedbackDefinitions<FeedbackSchema> {
	UpdateFeedbacks(fake.self)
	return fake.setFeedbackDefinitions.mock.calls[0][0]
}

// The definitions' hooks are typed per definition. These take any options, as the values Companion passes are not
// checked
type AnyActionCallback = (
	event: { id: string; controlId: string; actionId: string; surfaceId: undefined; options: CompanionOptionValues },
	context: CompanionActionCallbackContext,
) => Promise<void> | void
type AnyFeedbackCallback = (event: CompanionFeedbackBooleanEvent, context: CompanionFeedbackCallbackContext) => unknown
type AnyFeedbackHook = (info: CompanionFeedbackInfo, context: CompanionFeedbackContext) => Promise<void> | void

export async function runAction(
	definitions: CompanionActionDefinitions<ActionSchema>,
	actionId: ActionId,
	options: CompanionOptionValues,
): Promise<void> {
	const definition = definitions[actionId]
	if (!definition) throw new Error(`No definition for ${actionId}`)
	const callback = definition.callback as AnyActionCallback
	await callback(
		{ id: `action-${actionId}`, controlId: 'bank-1', actionId, surfaceId: undefined, options },
		{} as CompanionActionCallbackContext,
	)
}

/**
 * Runs a feedback's callback, as Companion does on every check and whenever the feedback's options are edited
 * @param id the feedback instance's id. Each feedback placed on a button has its own, which stays the same when its
 * options are changed
 */
export function checkFeedback(
	definitions: CompanionFeedbackDefinitions<FeedbackSchema>,
	feedbackId: FeedbackId,
	options: CompanionOptionValues,
	id = `feedback-${feedbackId}`,
): unknown {
	const definition = definitions[feedbackId]
	if (!definition) throw new Error(`No definition for ${feedbackId}`)
	const callback = definition.callback as AnyFeedbackCallback
	return callback(
		{ type: 'boolean', id, controlId: 'bank-1', feedbackId, options, previousOptions: null },
		{} as CompanionFeedbackCallbackContext,
	)
}

/** Runs a feedback's unsubscribe hook, as Companion does when the feedback is removed or disabled */
export async function unsubscribeFeedback(
	definitions: CompanionFeedbackDefinitions<FeedbackSchema>,
	feedbackId: FeedbackId,
	options: CompanionOptionValues,
	id = `feedback-${feedbackId}`,
): Promise<void> {
	const definition = definitions[feedbackId]
	if (!definition || !definition.unsubscribe) throw new Error(`No unsubscribe hook for ${feedbackId}`)
	const unsubscribe = definition.unsubscribe as AnyFeedbackHook
	await unsubscribe(
		{ type: 'boolean', id, controlId: 'bank-1', feedbackId, options, previousOptions: null },
		{} as CompanionFeedbackContext,
	)
}

/** The varbind an XCI sends for a logic cell: an Integer, 2 for true and 1 for false */
export function cellVarbind(cell: number, value: boolean): snmp.Varbind {
	return { oid: logicCellOid(cell), type: snmp.ObjectType.Integer, value: value ? 2 : 1 }
}

export type TrapOptions = {
	community?: string
	version?: 'v1' | 'v2c'
	/** The MIB's trap to send. signalChange by default */
	trap?: TrapName
}

/**
 * Encodes a trap as it goes on the wire, using net-snmp's own session with a socket that only records what is sent.
 * Not a capture from an XCI: there is none to hand. The OIDs and values follow MATRIX5-MIB. In v2c the trap is
 * `matrix5.0.<n>`; in v1 net-snmp makes the enterprise matrix5 and the specific trap n from `matrix5.<n>`
 */
export function encodeTrap(
	varbinds: snmp.Varbind[],
	{ community = 'nexus', version = 'v2c', trap = 'signalChange' }: TrapOptions = {},
): Buffer {
	const sent: Buffer[] = []
	const socket = Object.assign(new EventEmitter(), {
		unref: () => socket,
		close: () => {},
		send: (buffer: Buffer) => sent.push(Buffer.from(buffer)),
	})
	const session = snmp.createSession('192.0.2.10', community, {
		version: version === 'v1' ? snmp.Version1 : snmp.Version2c,
		dgramModule: { createSocket: () => socket },
	})
	const trapOid = version === 'v1' ? `${MATRIX5}.${TrapNumber[trap]}` : `${MATRIX5}.0.${TrapNumber[trap]}`
	session.trap(trapOid, varbinds, () => {})
	session.close()
	if (sent.length !== 1) throw new Error(`Expected one packet, got ${sent.length}`)
	return sent[0]
}

/** The varbinds an error trap carries for each error, as errorOccured's OBJECTS list them, at error table row `index` */
export function errorVarbinds(index: number, { node, code, name, param }: Omit<ErrorEvent, 'occured'>): snmp.Varbind[] {
	const column = (number: number): string => `${ERROR_ENTRY}.${number}.${index}`
	return [
		{ oid: column(ErrorColumn.errorNode), type: snmp.ObjectType.Integer, value: node },
		{ oid: column(ErrorColumn.errorCode), type: snmp.ObjectType.Integer, value: code },
		{ oid: column(ErrorColumn.errorName), type: snmp.ObjectType.OctetString, value: Buffer.from(name, 'latin1') },
		{ oid: column(ErrorColumn.errorParam), type: snmp.ObjectType.OctetString, value: Buffer.from(param, 'latin1') },
	]
}

export type AgentData = {
	trueCells?: Iterable<number>
	scalars?: Partial<Scalars>
	devices?: Map<number, BaseDevice>
	trapAddresses?: string[]
	/** errorTable's rows, from index 1 */
	errors?: ErrorEvent[]
}

const integer = (oid: string, value: number): snmp.Varbind => ({ oid, type: snmp.ObjectType.Integer, value })
const onOff = (oid: string, value: boolean): snmp.Varbind => integer(oid, value ? 2 : 1)
const octets = (oid: string, value: string): snmp.Varbind => ({
	oid,
	type: snmp.ObjectType.OctetString,
	value: Buffer.from(value, 'latin1'),
})

/** Every varbind an XCI's agent would hold for `data`, encoded as net-snmp decodes them off the wire */
export function agentVarbinds({
	trueCells = [],
	scalars = {},
	devices = new Map(),
	trapAddresses = [],
	errors = [],
}: AgentData): snmp.Varbind[] {
	const on = new Set(trueCells)
	const varbinds: snmp.Varbind[] = []
	for (let cell = 1; cell <= CELL_COUNT; cell++) varbinds.push(cellVarbind(cell, on.has(cell)))
	for (const [name, value] of Object.entries(scalars)) {
		const oid = SCALAR_OIDS[name as keyof Scalars]
		if (typeof value === 'string') varbinds.push(octets(oid, value))
		else if (typeof value === 'boolean') varbinds.push(onOff(oid, value))
		else if (typeof value === 'number') varbinds.push(integer(oid, value))
	}
	// As the XCI does: rows numbered from 1, each with its node number in deviceIndex
	for (const [row, [node, device]] of [...devices].entries()) {
		const column = (number: number): string => `${BASE_DEV_ENTRY}.${number}.${row + 1}`
		varbinds.push(integer(column(BaseDevColumn.deviceIndex), node))
		if (device.online !== undefined) varbinds.push(onOff(column(BaseDevColumn.deviceOnline), device.online))
		for (const field of [
			'configBoards',
			'availBoards',
			'powerUnits',
			'pwrGoodUnits',
			'cpuTemperature',
			'cpuMaxTemp',
		] as const) {
			const value = device[field]
			if (value !== undefined) varbinds.push(integer(column(BaseDevColumn[field]), value))
		}
	}
	trapAddresses.forEach((address, i) => {
		varbinds.push({ oid: `${TRAP_ADDRESS}.${i + 1}`, type: snmp.ObjectType.IpAddress, value: address })
	})
	errors.forEach(({ occured, node, code, name, param }, i) => {
		const column = (number: number): string => `${ERROR_ENTRY}.${number}.${i + 1}`
		varbinds.push(
			integer(column(1), i + 1),
			onOff(column(ErrorColumn.errorState), occured),
			integer(column(ErrorColumn.errorNode), node),
			integer(column(ErrorColumn.errorCode), code),
			octets(column(ErrorColumn.errorName), name),
			octets(column(ErrorColumn.errorParam), param),
			{ oid: column(ErrorColumn.timeTicks), type: snmp.ObjectType.TimeTicks, value: 1000 * (i + 1) },
		)
	})
	return varbinds
}

/**
 * A v2c agent holding `data`: get answers noSuchObject for an OID it lacks, and walk gives a subtree in OID order, as
 * net-snmp's walk does
 */
export function fakeAgent(data: AgentData = {}): { get: GetFunction; walk: WalkFunction } {
	const varbinds = agentVarbinds(data).sort((a, b) => compareOids(a.oid, b.oid))
	const byOid = new Map(varbinds.map((varbind) => [varbind.oid, varbind]))
	return {
		get: async (oids) => oids.map((oid) => byOid.get(oid) ?? { oid, type: snmp.ObjectType.NoSuchObject, value: null }),
		walk: async (oid) => varbinds.filter((varbind) => varbind.oid.startsWith(`${oid}.`)),
	}
}
