/**
 * Keyboard shortcut utilities for Svelte
 *
 * Provides two main approaches:
 * 1. `shortcut` action - Attach shortcuts directly to DOM elements
 * 2. `createGlobalShortcuts` - Set up global shortcuts (e.g., for navigation)
 */

import type { GlobalShortcutConfig, KeyboardShortcutParams } from '$types/keyboard';

/**
 * Check if the event target is an input element where we should ignore shortcuts
 */
export function isInputElement(target: EventTarget | null): boolean {
	if (!target) return false;
	const element = target as HTMLElement;
	return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
}

/**
 * Check if keyboard event modifiers match the expected configuration
 */
function modifiersMatch(
	event: KeyboardEvent,
	config: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }
): boolean {
	// Treat Ctrl and Meta (Cmd) as equivalent for cross-platform compatibility
	const ctrlPressed = event.ctrlKey || event.metaKey;

	return (
		(config.ctrl ? ctrlPressed : !ctrlPressed) &&
		(config.alt ? event.altKey : !event.altKey) &&
		(config.shift ? event.shiftKey : !event.shiftKey) &&
		(config.meta ? event.metaKey : !event.metaKey)
	);
}

/**
 * Check if keyboard event key matches the expected key/code
 */
function keyMatches(event: KeyboardEvent, config: { key?: string; code?: string }): boolean {
	const keyMatch = config.key ? event.key === config.key : true;
	const codeMatch = config.code ? event.code === config.code : true;
	return keyMatch && codeMatch;
}

/**
 * Svelte action for attaching keyboard shortcuts to elements
 *
 * By default, clicking the element is triggered. You can provide a custom callback instead.
 *
 * @example
 * // Simple shortcut - press 'a' to click the link
 * <a use:shortcut={{ key: 'a' }} href="/all">All</a>
 *
 * @example
 * // With modifiers and custom callback
 * <button use:shortcut={{ key: 's', ctrl: true, callback: save }}>Save</button>
 */
export function shortcut(node: HTMLElement, params: KeyboardShortcutParams) {
	let handler: (e: KeyboardEvent) => void;

	const removeHandler = () => {
		window.removeEventListener('keydown', handler);
	};

	const setHandler = () => {
		removeHandler();
		if (!params || params.enabled === false) return;

		handler = (e: KeyboardEvent) => {
			// Ignore shortcuts when typing in input fields (unless explicitly disabled)
			if (params.ignoreInputs !== false && isInputElement(e.target)) {
				return;
			}

			// Check if modifiers and key match
			if (!modifiersMatch(e, params) || !keyMatches(e, params)) {
				return;
			}

			// Prevent default browser behavior and execute callback
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
 * Create global keyboard shortcuts that aren't attached to specific elements
 *
 * Good for navigation shortcuts. Returns cleanup function for use with $effect.
 * Supports both simple shortcuts and two-key sequences.
 *
 * @param shortcuts - Array of shortcut configurations
 * @param options - Optional configuration (sequence timeout, etc.)
 * @returns Cleanup function to remove event listeners
 *
 * @example
 * $effect(() => {
 *   return createGlobalShortcuts([
 *     // Simple shortcut: press '/' to open search
 *     { key: '/', callback: () => openSearch() },
 *
 *     // Sequence shortcuts: press 'g' then 'h' to go home
 *     { sequence: ['g', 'h'], callback: () => goto('/home') },
 *     { sequence: ['g', 'l'], callback: () => goto('/library') }
 *   ]);
 * });
 */
export function createGlobalShortcuts(
	shortcuts: GlobalShortcutConfig[],
	options: { sequenceTimeout?: number } = {}
): () => void {
	const SEQUENCE_TIMEOUT = options.sequenceTimeout ?? 2500;

	// Track sequence state: which key was pressed first and when to reset
	let lastKey = '';
	let lastKeyTimeout: number | undefined;

	function resetSequence() {
		lastKey = '';
		if (lastKeyTimeout) clearTimeout(lastKeyTimeout);
	}

	function handleKeyDown(e: KeyboardEvent) {
		// Ignore shortcuts when typing in input fields
		const shouldIgnoreInputs = shortcuts.some((s) => s.ignoreInputs !== false);
		if (shouldIgnoreInputs && isInputElement(e.target)) {
			return;
		}

		// Check each registered shortcut
		for (const shortcut of shortcuts) {
			// Handle two-key sequences (e.g., 'g' then 'h')
			if (shortcut.sequence) {
				const [firstKey, secondKey] = shortcut.sequence;

				// First key in sequence: start tracking
				if (lastKey === '' && e.key === firstKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
					e.preventDefault();
					lastKey = firstKey;
					if (lastKeyTimeout) clearTimeout(lastKeyTimeout);
					// Reset if user doesn't press second key in time
					lastKeyTimeout = window.setTimeout(resetSequence, SEQUENCE_TIMEOUT);
					return;
				}

				// Second key in sequence: execute callback
				if (lastKey === firstKey && e.key === secondKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
					e.preventDefault();
					resetSequence();
					shortcut.callback();
					return;
				}
			}
			// Handle simple shortcuts (single key with optional modifiers)
			else {
				if (modifiersMatch(e, shortcut) && keyMatches(e, shortcut)) {
					e.preventDefault();
					shortcut.callback();
					return;
				}
			}
		}
	}

	// Set up event listener
	window.addEventListener('keydown', handleKeyDown);

	// Return cleanup function (for $effect)
	return () => {
		window.removeEventListener('keydown', handleKeyDown);
		resetSequence();
	};
}
