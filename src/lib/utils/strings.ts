import type { ListItem } from '$types/lists';

export function slugify(title: string) {
	const simpleTitle = title
		.replaceAll(/[^a-zA-Z0-9 ]/g, '')
		.replaceAll(/\s{2,}/g, '-')
		.replaceAll(' ', '-')
		.toLowerCase();

	return simpleTitle;
}

function stripArticle(str: string): string {
	return str.replace(/^(?:a|an|the)\s+/i, '');
}

export function sortTitles(arr: ListItem[] | undefined) {
	if (!arr) return;

	return [...arr].sort((a, b) => {
		const keyA = stripArticle(a.title);
		const keyB = stripArticle(b.title);
		return keyA.localeCompare(keyB, undefined, { sensitivity: 'base' });
	});
}
