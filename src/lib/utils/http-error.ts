export class HttpError extends Error {
	constructor(
		message: string,
		public status?: number,
		public details?: unknown
	) {
		super(message);
		this.name = 'HttpError';
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getNumberProp(obj: unknown, key: string): number | undefined {
	if (!isObject(obj)) return undefined;
	const val = obj[key];
	return typeof val === 'number' ? val : undefined;
}

function getStringProp(obj: unknown, key: string): string | undefined {
	if (!isObject(obj)) return undefined;
	const val = obj[key];
	return typeof val === 'string' ? val : undefined;
}

function getNestedString(obj: unknown, path: string[]): string | undefined {
	let cur: unknown = obj;
	for (const key of path) {
		if (!isObject(cur)) return undefined;
		cur = cur[key];
	}
	return typeof cur === 'string' ? cur : undefined;
}

export function toHttpError(err: unknown, fallback: string): HttpError {
	const status = getNumberProp(err, 'status');
	const message =
		getNestedString(err, ['value', 'message']) || getStringProp(err, 'message') || fallback;
	return new HttpError(String(message), status, err);
}

export function unwrapData<T>(value: unknown): T {
	if (isObject(value) && 'data' in value) {
		return (value as { data: T }).data;
	}
	return value as T;
}
