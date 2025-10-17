export function slugify(title: string) {
	const simpleTitle = title
		.replaceAll(/[^a-zA-Z0-9 ]/g, '')
		.replaceAll(/\s{2,}/g, '-')
		.replaceAll(' ', '-')
		.toLowerCase();

	return simpleTitle;
}
