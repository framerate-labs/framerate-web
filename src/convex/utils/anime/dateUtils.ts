const MS_PER_DAY = 24 * 60 * 60_000;

export function parseDateMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

export function daysUntilDate(now: number, value: string | null | undefined): number | null {
	const ms = parseDateMs(value);
	if (ms == null) return null;
	return Math.ceil((ms - now) / MS_PER_DAY);
}

export function daysSinceDate(now: number, value: string | null | undefined): number | null {
	const ms = parseDateMs(value);
	if (ms == null) return null;
	return Math.floor((now - ms) / MS_PER_DAY);
}

export function daysToMs(days: number): number {
	return days * MS_PER_DAY;
}
