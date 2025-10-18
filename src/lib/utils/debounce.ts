/**
 * Debounces a function call
 * @param fn The function to debounce
 * @param delay Delay in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: any[]) => void>(fn: T, delay: number) {
	let timer: ReturnType<typeof setTimeout>;

	return (...args: Parameters<T>) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), delay);
	};
}
