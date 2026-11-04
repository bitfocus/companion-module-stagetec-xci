import type { DropdownChoice } from '@companion-module/base'

/**
 * The Nexus system error numbers, from COMM_ERROR_OCCURRED in Stage Tec's "Description Nexus messages", as copied into
 * companion-module-stagetec-nexus-udp's src/api/consts.ts. 0 to 63 are reserved.
 *
 * MATRIX5-MIB doesn't list errorCode's values. The XCI's errorOccured and errorRemoved traps carry a node, a code, a name
 * and a parameter, as COMM_ERROR_OCCURRED does a source base device, an error number and a parameter field, so these are
 * taken to be the same numbers. Not yet checked against an XCI: compare errorName with these on a real error.
 */
export enum NexusErrorCode {
	NodeFail = 64,
	UnusedEdge = 65,
	HotEdge = 66,
	ColdEdge = 67,
	SyncFail = 68,
	PowerFail = 69,
	BoardFail = 70,
	AccuVoltage = 71,
	TempWarning = 72,
	GpioMsg = 73,
	AmplifierFail = 74,
	AmplifierWarning = 75,
	EthernetConnect = 76,
	ConnectPoint = 96,
	NoLwlSlot = 97,
	NoXbpSlot = 98,
	ReconnectPoint = 99,
	InputAddress = 100,
	OutputAddress = 101,
	XdeModFail = 110,
	SystemTime = 125,
	MsgUnderrun = 126,
	CommNumber = 127,
}

/** The spec's description of each code, worded as companion-module-stagetec-nexus-udp words them */
export const ERROR_DESCRIPTIONS = {
	[NexusErrorCode.NodeFail]: 'Base device down',
	[NexusErrorCode.UnusedEdge]: 'Optical link down, no audio',
	[NexusErrorCode.HotEdge]: 'Active optical link down',
	[NexusErrorCode.ColdEdge]: 'Redundant optical link down',
	[NexusErrorCode.SyncFail]: 'Sync source down',
	[NexusErrorCode.PowerFail]: 'Power supply down',
	[NexusErrorCode.BoardFail]: 'Card down',
	[NexusErrorCode.AccuVoltage]: 'XCPU/XCI backup battery',
	[NexusErrorCode.TempWarning]: 'Card temperature',
	[NexusErrorCode.GpioMsg]: 'XRI contact',
	[NexusErrorCode.AmplifierFail]: 'Amplifier controller error',
	[NexusErrorCode.AmplifierWarning]: 'Amplifier controller temperature warning',
	[NexusErrorCode.EthernetConnect]: 'Ethernet connection down',
	[NexusErrorCode.ConnectPoint]: 'Failed to activate a prepared patch connection',
	[NexusErrorCode.NoLwlSlot]: 'No free timeslot on optical card',
	[NexusErrorCode.NoXbpSlot]: 'No free timeslot in base device',
	[NexusErrorCode.ReconnectPoint]: 'Patch connection has been re-routed',
	[NexusErrorCode.InputAddress]: 'Erroneous input address',
	[NexusErrorCode.OutputAddress]: 'Erroneous output address',
	[NexusErrorCode.XdeModFail]: 'XDED/XDEE error on Dolby module',
	[NexusErrorCode.SystemTime]: 'Internal system time',
	[NexusErrorCode.MsgUnderrun]: 'Message buffer underrun in base device',
	[NexusErrorCode.CommNumber]: 'Invalid command received',
} as const satisfies Record<NexusErrorCode, string>

/** 0 matches any code */
export const ANY_ERROR_CODE = 0

/** Any, then each code as eg "69: Power supply down", in code order */
export const ERROR_CODE_CHOICES: DropdownChoice<number>[] = [
	{ id: ANY_ERROR_CODE, label: 'Any' },
	...Object.values(NexusErrorCode)
		.filter((code): code is NexusErrorCode => typeof code === 'number')
		.sort((a, b) => a - b)
		.map((code) => ({ id: code, label: `${code}: ${ERROR_DESCRIPTIONS[code]}` })),
]
