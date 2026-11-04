import snmp from 'net-snmp'
import PQueue from 'p-queue'

export const SnmpVersion = ['v1', 'v2c'] as const
export type SnmpVersion = (typeof SnmpVersion)[number]

export type XciClientOptions = {
	version: SnmpVersion
	/** The XCI's SNMP agent port, normally 161 */
	port: number
	/** Per attempt, in ms */
	timeout?: number
	retries?: number
}

/** The XCI is on the local network, so a reply that hasn't come in 2 s isn't coming. With one retry, ~4 s per request */
const DEFAULT_TIMEOUT = 2000
const DEFAULT_RETRIES = 1
/**
 * Varbinds per getBulk in a v2c walk. The longest the MIB has, an errorParam of 32 characters, makes a varbind of about
 * 50 bytes, so 8 keep a response inside 484 bytes, see GET_BATCH_SIZE
 */
const WALK_MAX_REPETITIONS = 8

/**
 * An SNMP v1/v2c session with the XCI's agent. Requests go one at a time through a queue, so later polling can share
 * the session without flooding the card.
 */
export class XciClient {
	readonly #session: snmp.Session
	readonly #queue = new PQueue({ concurrency: 1 })
	#closed = false

	constructor(host: string, community: string, options: XciClientOptions) {
		this.#session = snmp.createSession(host, community, {
			version: options.version === 'v1' ? snmp.Version1 : snmp.Version2c,
			port: options.port,
			timeout: options.timeout ?? DEFAULT_TIMEOUT,
			retries: options.retries ?? DEFAULT_RETRIES,
		})
	}

	/**
	 * Gets the OIDs in one request.
	 *
	 * In v2c an OID the agent doesn't have comes back as a varbind error (see `snmp.isVarbindError`). In v1 the whole
	 * request fails instead, with a `RequestFailedError`.
	 * @param signal drops the request if it is still queued, and rejects at once if it is in flight
	 * @throws net-snmp's errors: `RequestTimedOutError` when the agent doesn't answer, `RequestFailedError` when it
	 * answers with an error status
	 */
	async get(oids: string[], signal?: AbortSignal): Promise<snmp.Varbind[]> {
		return this.#queue.add(
			async ({ signal }) =>
				new Promise<snmp.Varbind[]>((resolve, reject) => {
					if (this.#closed) {
						reject(new Error('SNMP session closed'))
						return
					}
					const onAbort = (): void => reject(new Error('SNMP get aborted'))
					signal?.addEventListener('abort', onAbort, { once: true })
					this.#session.get(oids, (error, varbinds) => {
						signal?.removeEventListener('abort', onAbort)
						if (error) reject(error)
						else resolve(varbinds ?? [])
					})
				}),
			{ signal },
		)
	}

	/**
	 * Reads every object under `oid`, with getNext in v1 and getBulk in v2c. An empty table gives no varbinds
	 * @param signal drops the walk if it is still queued, and stops it between requests if it is in flight
	 * @throws as {@link get}
	 */
	async walk(oid: string, signal?: AbortSignal): Promise<snmp.Varbind[]> {
		return this.#queue.add(
			async ({ signal }) =>
				new Promise<snmp.Varbind[]>((resolve, reject) => {
					if (this.#closed) {
						reject(new Error('SNMP session closed'))
						return
					}
					const varbinds: snmp.Varbind[] = []
					this.#session.subtree(
						oid,
						WALK_MAX_REPETITIONS,
						(batch) => {
							for (const varbind of batch) {
								// An agent that answers a getNext past its last object with the OID it was asked for, as
								// net-snmp's own does, would otherwise be walked forever: every request gets an answer
								const previous = varbinds.at(-1)?.oid
								if (
									snmp.isVarbindError(varbind) ||
									(previous !== undefined && compareOids(varbind.oid, previous) <= 0)
								) {
									return true
								}
								varbinds.push(varbind)
							}
							// Returning true stops the walk
							return signal?.aborted === true
						},
						(error) => {
							if (signal?.aborted) reject(new Error('SNMP walk aborted'))
							else if (error) reject(error)
							else resolve(varbinds)
						},
					)
				}),
			{ signal },
		)
	}

	/** Drops queued requests, fails any in flight, and closes the socket */
	close(): void {
		if (this.#closed) return
		this.#closed = true
		this.#queue.clear()
		this.#session.close()
	}
}

/** Orders OIDs as an agent does: by each number in turn, a prefix first */
export function compareOids(a: string, b: string): number {
	const x = a.split('.').map(Number)
	const y = b.split('.').map(Number)
	for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
	return x.length - y.length
}

export function isTimeout(error: unknown): boolean {
	return error instanceof Error && error.name === 'RequestTimedOutError'
}

export function isRequestFailed(error: unknown): boolean {
	return error instanceof Error && error.name === 'RequestFailedError'
}

/**
 * OIDs per get request. 16 Integer varbinds make a response of roughly 430 bytes, inside the 484 byte message every SNMP
 * agent must accept (RFC 3417), so no agent should answer tooBig
 */
export const GET_BATCH_SIZE = 16

export type GetFunction = (oids: string[], signal?: AbortSignal) => Promise<snmp.Varbind[]>

export type BatchResult = {
	varbinds: snmp.Varbind[]
	/** OIDs a v1 agent answered with an error status, each asked for on its own */
	failures: { oid: string; error: Error }[]
}

/**
 * Gets the OIDs {@link GET_BATCH_SIZE} at a time.
 *
 * A v1 agent fails a whole request over one OID it doesn't have, so a batch that fails is asked again one OID at a
 * time, and only the OIDs that still fail are lost.
 * @throws whatever else `get` throws, such as a timeout or an abort, stopping there: an agent that doesn't answer one
 * request won't answer the next
 */
export async function getInBatches(
	get: GetFunction,
	oids: readonly string[],
	signal?: AbortSignal,
): Promise<BatchResult> {
	const result: BatchResult = { varbinds: [], failures: [] }
	for (let first = 0; first < oids.length; first += GET_BATCH_SIZE) {
		const batch = oids.slice(first, first + GET_BATCH_SIZE)
		try {
			result.varbinds.push(...(await get(batch, signal)))
		} catch (error) {
			if (!isRequestFailed(error) || batch.length === 1) throw error
			for (const oid of batch) {
				try {
					result.varbinds.push(...(await get([oid], signal)))
				} catch (error) {
					if (!isRequestFailed(error)) throw error
					result.failures.push({ oid, error: error as Error })
				}
			}
		}
	}
	return result
}
