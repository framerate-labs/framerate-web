/**
 * Keyboard shortcut action for Svelte
 * Supports both simple and sequential (vim-style) keyboard shortcuts
 */

export type KeyboardShortcutParams = {
	code: string;
	control?: boolean;
	alt?: boolean;
	shift?: boolean;
	meta?: boolean;
	callback?: () => void;
	enabled?: boolean;
};

export type SequentialShortcutParams = {
	sequence: string[];
	callback: () => void;
	enabled?: boolean;
	timeout?: number; // ms to wait for next key in sequence
};

/**
 * Simple keyboard shortcut action
 * @example
 * <button use:shortcut={{ code: 'KeyS', control: true, callback: save }}>Save</button>
 */
export function shortcut(
	node: HTMLElement,
	params: KeyboardShortcutParams
) {
	let handler: (e: KeyboardEvent) => void;

	const removeHandler = () => {
		window.removeEventListener('keydown', handler);
	};

	const setHandler = () => {
		removeHandler();
		if (!params || params.enabled === false) return;

		handler = (e: KeyboardEvent) => {
			// Check all modifiers match
			if (
				(!!params.control !== (e.ctrlKey || e.metaKey)) ||
				(!!params.alt !== e.altKey) ||
				(!!params.shift !== e.shiftKey) ||
				(!!params.meta !== e.metaKey) ||
				params.code !== e.code
			) {
				return;
			}

			e.preventDefault();
			if (params.callback) {
				params.callback();
			} else {
				node.click();
			}
		};

		window.addEventListener('keydown', handler);
	};

	setHandler();

	return {
		update: setHandler,
		destroy: removeHandler
	};
}

/**
 * Sequential keyboard shortcut action (vim-style, e.g., "g" then "h")
 * @example
 * <div use:sequentialShortcut={{ sequence: ['g', 'h'], callback: goHome }}>
 */
export function sequentialShortcut(
	node: HTMLElement,
	params: SequentialShortcutParams
) {
	let handler: (e: KeyboardEvent) => void;
	let currentIndex = 0;
	let timeoutId: number | undefined;
	const DEFAULT_TIMEOUT = 1000;

	const removeHandler = () => {
		window.removeEventListener('keydown', handler);
		if (timeoutId) clearTimeout(timeoutId);
	};

	const resetSequence = () => {
		currentIndex = 0;
		if (timeoutId) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}
	};

	const setHandler = () => {
		removeHandler();
		if (!params || params.enabled === false) return;

		handler = (e: KeyboardEvent) => {
			// Ignore if modifier keys are pressed (except shift for capital letters)
			if (e.ctrlKey || e.altKey || e.metaKey) {
				resetSequence();
				return;
			}

			const expectedKey = params.sequence[currentIndex];
			if (e.key.toLowerCase() === expectedKey.toLowerCase()) {
				e.preventDefault();
				currentIndex++;

				// Clear previous timeout
				if (timeoutId) clearTimeout(timeoutId);

				// Check if sequence is complete
				if (currentIndex === params.sequence.length) {
					params.callback();
					resetSequence();
				} else {
					// Set timeout for next key
					timeoutId = window.setTimeout(
						resetSequence,
						params.timeout ?? DEFAULT_TIMEOUT
					);
				}
			} else {
				// Wrong key, reset sequence
				resetSequence();
			}
		};

		window.addEventListener('keydown', handler);
	};

	setHandler();

	return {
		update: (newParams: SequentialShortcutParams) => {
			params = newParams;
			resetSequence();
			setHandler();
		},
		destroy: removeHandler
	};
}

/**
 * Global keyboard shortcuts manager
 * Useful for managing multiple shortcuts that need to be enabled/disabled together
 */
export class KeyboardShortcutManager {
	private shortcuts: Map<string, () => void> = new Map();
	private handler: ((e: KeyboardEvent) => void) | null = null;
	private enabled = true;

	/**
	 * Register a simple shortcut
	 */
	register(
		id: string,
		params: Omit<KeyboardShortcutParams, 'enabled'> & { callback: () => void }
	) {
		this.shortcuts.set(id, () => {
			const handler = (e: KeyboardEvent) => {
				if (!this.enabled) return;

				if (
					(!!params.control !== (e.ctrlKey || e.metaKey)) ||
					(!!params.alt !== e.altKey) ||
					(!!params.shift !== e.shiftKey) ||
					(!!params.meta !== e.metaKey) ||
					params.code !== e.code
				) {
					return;
				}

				e.preventDefault();
				params.callback();
			};
			window.addEventListener('keydown', handler);
		});
	}

	/**
	 * Enable all shortcuts
	 */
	enable() {
		this.enabled = true;
	}

	/**
	 * Disable all shortcuts
	 */
	disable() {
		this.enabled = false;
	}

	/**
	 * Unregister a shortcut
	 */
	unregister(id: string) {
		this.shortcuts.delete(id);
	}

	/**
	 * Clean up all shortcuts
	 */
	destroy() {
		this.shortcuts.clear();
		if (this.handler) {
			window.removeEventListener('keydown', this.handler);
		}
	}
}
