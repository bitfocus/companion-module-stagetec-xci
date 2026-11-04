import { Regex, type DropdownChoice, type SomeCompanionConfigField } from '@companion-module/base'
import * as os from 'os'
import type { SnmpVersion } from './client.js'

export type ModuleConfig = {
	/** The XCI's address. Traps from anywhere else are ignored */
	host: string
	/** Traps carrying any other community are ignored. Also the community the XCI's state is read with */
	community: string
	/** The version the XCI's agent answers gets in. Traps are taken in either */
	version: SnmpVersion
	/** The XCI's SNMP agent port */
	port: number
	/** Seconds between reads of the Nexus status. 0 reads it only on start, on a config change and on Refresh */
	pollInterval: number
}

export const VERSION_CHOICES = [
	{ id: 'v1', label: 'v1' },
	{ id: 'v2c', label: 'v2c' },
] as const satisfies DropdownChoice<SnmpVersion>[]

/**
 * For connections made before the module read the XCI's state. UpgradeScripts[2] fills these in, and the instance
 * merges them under its config too, for a connection that ran a development build after that script
 */
export const CONFIG_DEFAULTS = {
	version: VERSION_CHOICES[1].id,
	port: 161,
	pollInterval: 10,
} as const satisfies Partial<ModuleConfig>

export function GetConfigFields(): SomeCompanionConfigField[] {
	const isLinuxUser = os.platform() === 'linux' && os.userInfo().username !== 'root'
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'XCI IP',
			width: 8,
			regex: Regex.IP,
			tooltip: 'The IP of the Nexus XCI',
		},
		{
			type: 'textinput',
			id: 'community',
			label: 'Community String',
			width: 4,
			minLength: 1,
			default: 'public',
			tooltip: 'The configured community string',
		},
		{
			type: 'dropdown',
			id: 'version',
			label: 'SNMP Version',
			width: 4,
			choices: VERSION_CHOICES,
			default: CONFIG_DEFAULTS.version,
			tooltip: 'The version set on the XCI, used to read the state of the logic cells. Traps are received in either',
		},
		{
			type: 'number',
			id: 'port',
			label: 'SNMP Agent Port',
			width: 4,
			min: 1,
			max: 65535,
			default: CONFIG_DEFAULTS.port,
			tooltip: 'The port the XCI answers SNMP gets on, normally 161',
		},
		{
			type: 'number',
			id: 'pollInterval',
			label: 'Status Poll Interval (s)',
			width: 4,
			min: 0,
			max: 3600,
			default: CONFIG_DEFAULTS.pollInterval,
			tooltip:
				'How often the project, base device, trap and error status is read. 0 reads it only on start, on a config change and with the Refresh action. Logic cells are read on start and kept up to date by traps',
		},
		{
			type: 'static-text',
			id: 'linuxPrivilegedPortWarning',
			label: 'Privileged Port Warning',
			value: `This module will attempt to bind to a privileged port 162, which requires elevated permissions on Linux. Since you are not running as <code>root</code>, you may need to grant the Node.js binary the <code>CAP_NET_BIND_SERVICE</code> capability. You can do this with one of the following tools: <strong>setcap</strong>, <strong>authbind</strong>.`,
			width: 12,
			isVisibleExpression: `${isLinuxUser}`,
		},
	]
}
