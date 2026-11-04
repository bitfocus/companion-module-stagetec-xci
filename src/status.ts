import { InstanceStatus } from '@companion-module/base'

/** What reports a status: the trap listener, received traps, and the two polls */
export type StatusSource = 'config' | 'listener' | 'traps' | 'cells' | 'status'

type Status = { status: InstanceStatus; message?: string }

/** Worse statuses win. Anything not listed counts as an error */
const SEVERITY: Partial<Record<InstanceStatus, number>> = {
	[InstanceStatus.Ok]: 0,
	[InstanceStatus.Connecting]: 1,
	[InstanceStatus.UnknownWarning]: 2,
	[InstanceStatus.BadConfig]: 3,
	[InstanceStatus.ConnectionFailure]: 4,
	[InstanceStatus.UnknownError]: 5,
}
const severity = ({ status }: Status): number => SEVERITY[status] ?? 5

/**
 * Keeps each source's last status, and shows the worst. So a poll that recovers clears only its own warning, and a
 * listener that failed to bind isn't hidden by a poll that works
 */
export class StatusTracker {
	readonly #update: (status: InstanceStatus, message?: string) => void
	readonly #sources = new Map<StatusSource, Status>()
	#shown: Status | undefined

	constructor(update: (status: InstanceStatus, message?: string) => void) {
		this.#update = update
	}

	set(source: StatusSource, status: InstanceStatus, message?: string): void {
		this.#sources.set(source, { status, message })
		this.#publish()
	}

	/** Forgets every source, as for a new config */
	reset(): void {
		this.#sources.clear()
	}

	#publish(): void {
		let worst: Status = { status: InstanceStatus.Ok }
		for (const status of this.#sources.values()) if (severity(status) > severity(worst)) worst = status
		// An Ok status carries no message: whichever source's message it was is no longer the point
		const shown: Status = worst.status === InstanceStatus.Ok ? { status: InstanceStatus.Ok } : worst
		if (this.#shown?.status === shown.status && this.#shown.message === shown.message) return
		this.#shown = shown
		this.#update(shown.status, shown.message)
	}
}
