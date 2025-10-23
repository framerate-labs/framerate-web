/** Configuration for element-based shortcuts (use:shortcut) */
export type KeyboardShortcutParams = {
	/** Single key like 'a', 's', '/' */
	key?: string;
	/** Key code like 'KeyA', 'KeyS', 'Slash' (less common, use `key` instead) */
	code?: string;
	/** Require Ctrl/Cmd to be pressed */
	ctrl?: boolean;
	/** Require Alt to be pressed */
	alt?: boolean;
	/** Require Shift to be pressed */
	shift?: boolean;
	/** Require Meta/Cmd to be pressed */
	meta?: boolean;
	/** Custom callback (defaults to clicking the element) */
	callback?: () => void;
	/** Enable/disable the shortcut */
	enabled?: boolean;
	/** Ignore shortcuts when typing in inputs (default: true) */
	ignoreInputs?: boolean;
};

/** Configuration for global shortcuts */
export type GlobalShortcutConfig = {
	/** Single key like 'a', 's', '/' */
	key?: string;
	/** Key code like 'KeyA', 'KeyS', 'Slash' */
	code?: string;
	/** Two-key sequence like ['g', 'h'] for vim-style shortcuts */
	sequence?: [string, string];
	/** Callback to execute when shortcut is triggered */
	callback: () => void;
	/** Require Ctrl/Cmd to be pressed */
	ctrl?: boolean;
	/** Require Alt to be pressed */
	alt?: boolean;
	/** Require Meta/Cmd to be pressed */
	meta?: boolean;
	/** Ignore shortcuts when typing in inputs (default: true) */
	ignoreInputs?: boolean;
};
