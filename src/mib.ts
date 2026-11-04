import snmp, { type Varbind } from 'net-snmp'

/**
 * OIDs and value types from Stage Tec's MATRIX5-MIB (mibs/matrix5.mib for SMIv1, mibs/matrix5_v2.mib for SMIv2, both
 * describing the same objects). Every object in it is read-only.
 */
export const MATRIX5 = '1.3.6.1.4.1.40085.1.1'
const STATE = `${MATRIX5}.1`

/** The scalars, each with the `.0` instance suffix a get needs */
export const SCALAR_OIDS = {
	// project
	projectName: `${STATE}.1.1.0`,
	projectRevision: `${STATE}.1.2.0`,
	baseDevNum: `${STATE}.1.3.0`,
	baseDevOnline: `${STATE}.1.4.0`,
	syncSources: `${STATE}.1.5.0`,
	syncIndex: `${STATE}.1.6.0`,
	// snmpAgent.sysInfo
	hostName: `${STATE}.3.1.1.0`,
	deviceType: `${STATE}.3.1.2.0`,
	moduleName: `${STATE}.3.1.3.0`,
	moduleVersion: `${STATE}.3.1.4.0`,
	// snmpAgent.signal
	firstSignal: `${STATE}.3.2.1.0`,
	configSignals: `${STATE}.3.2.2.0`,
	trapSignals: `${STATE}.3.2.4.0`,
	// snmpAgent.trap
	trapDestinations: `${STATE}.3.3.1.0`,
	trapDestAuto: `${STATE}.3.3.2.0`,
	trapTimeout: `${STATE}.3.3.4.0`,
} as const

export type ScalarName = keyof typeof SCALAR_OIDS

/** The type each scalar decodes to */
export type Scalars = {
	projectName: string
	projectRevision: string
	baseDevNum: number
	baseDevOnline: number
	syncSources: number
	/** 0 for the internal clock */
	syncIndex: number
	hostName: string
	deviceType: string
	moduleName: string
	moduleVersion: string
	firstSignal: number
	configSignals: number
	trapSignals: number
	trapDestinations: number
	trapDestAuto: boolean
	trapTimeout: number
}

/** baseDevTable's entry. A cell's OID is this, the column, then the device index */
export const BASE_DEV_ENTRY = `${STATE}.2.1`
export const BaseDevColumn = {
	deviceOnline: 2,
	configBoards: 3,
	availBoards: 4,
	powerUnits: 5,
	pwrGoodUnits: 6,
	cpuTemperature: 7,
	cpuMaxTemp: 8,
} as const

/** signalTable's signalValue column, followed by the signal index. Each is a logic cell */
export const SIGNAL_VALUE = `${STATE}.3.2.3.1.2.`

/** trapTable's trapAddress column, followed by the destination index */
export const TRAP_ADDRESS = `${STATE}.3.3.3.1.2`

/** errorTable's entry. A cell's OID is this, the column, then the error index */
export const ERROR_ENTRY = `${STATE}.10.1`
export const ErrorColumn = {
	errorState: 2,
	errorNode: 3,
	errorCode: 4,
	errorName: 5,
	errorParam: 6,
	timeTicks: 7,
} as const

/**
 * The traps: in v2c `matrix5.0.<n>` is the snmpTrapOID, in v1 the enterprise is matrix5 and n the specific trap.
 * The list traps are only in the SMIv1 MIB.
 */
export const TrapNumber = {
	signalChange: 1,
	signalList: 2,
	errorOccured: 3,
	errorList: 4,
	errorRemoved: 5,
	removeList: 6,
} as const
export type TrapName = keyof typeof TrapNumber

/** snmpTrapOID.0, the second varbind of every v2c trap */
export const SNMP_TRAP_OID = '1.3.6.1.6.3.1.1.4.1.0'

/** The row index after a column's OID, eg 4 for `<column>.4`, or undefined if `oid` isn't a row of the column */
export function indexIn(column: string, oid: string): number | undefined {
	if (!oid.startsWith(`${column}.`)) return undefined
	const suffix = oid.slice(column.length + 1)
	return /^\d+$/.test(suffix) ? Number(suffix) : undefined
}

/** An Integer, or undefined for any other type or a varbind error */
export function asInteger(varbind: Varbind): number | undefined {
	if (snmp.isVarbindError(varbind)) return undefined
	const { value } = varbind
	if (typeof value === 'number') return value
	if (typeof value === 'bigint') return Number(value)
	return undefined
}

/**
 * A DisplayString. net-snmp gives an OctetString as a Buffer. Decoded as latin1, as a DisplayString is meant to be
 * ASCII and latin1 maps every byte to a character
 */
export function asString(varbind: Varbind): string | undefined {
	if (snmp.isVarbindError(varbind)) return undefined
	const { value } = varbind
	if (Buffer.isBuffer(value)) return value.toString('latin1')
	if (typeof value === 'string') return value
	return undefined
}

/** OnOff: off(1), on(2) */
export function asOnOff(varbind: Varbind): boolean | undefined {
	const value = asInteger(varbind)
	if (value === 2) return true
	if (value === 1) return false
	return undefined
}

/** AlarmState: removed(1), occured(2). True for occured */
export function asOccured(varbind: Varbind): boolean | undefined {
	return asOnOff(varbind)
}

/** An IpAddress, which net-snmp gives as a dotted string */
export function asIpAddress(varbind: Varbind): string | undefined {
	if (snmp.isVarbindError(varbind)) return undefined
	return typeof varbind.value === 'string' ? varbind.value : undefined
}

/** How each scalar is decoded */
export const SCALAR_DECODERS: { [K in ScalarName]: (varbind: Varbind) => Scalars[K] | undefined } = {
	projectName: asString,
	projectRevision: asString,
	baseDevNum: asInteger,
	baseDevOnline: asInteger,
	syncSources: asInteger,
	syncIndex: asInteger,
	hostName: asString,
	deviceType: asString,
	moduleName: asString,
	moduleVersion: asString,
	firstSignal: asInteger,
	configSignals: asInteger,
	trapSignals: asInteger,
	trapDestinations: asInteger,
	trapDestAuto: asOnOff,
	trapTimeout: asInteger,
}
