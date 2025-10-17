import {
	collapseDuplicatesTransformer,
	DataSet,
	englishDataset,
	englishRecommendedTransformers,
	pattern,
	RegExpMatcher,
	resolveConfusablesTransformer,
	resolveLeetSpeakTransformer,
	skipNonAlphabeticTransformer,
	toAsciiLowerCaseTransformer
} from 'obscenity';
import z4 from 'zod/v4';

import { signupSchema } from '$schema/auth-schema';

export function blacklistChecks(unsafeData: z4.infer<typeof signupSchema>) {
	const { success, data: parsedData, error: parsedError } = signupSchema.safeParse(unsafeData);

	if (!success) {
		const tree = z4.treeifyError(parsedError);

		return {
			status: 'error',
			message: 'Please fill all fields correctly',
			errors: tree.errors
		};
	}

	const blacklistMatches = [];

	for (const [_key, value] of Object.entries(parsedData)) {
		const hasMatch = blacklistFilter(value);
		blacklistMatches.push(hasMatch);
	}

	if (blacklistMatches.includes(false)) {
		return {
			status: 'error',
			message: "Please don't use profanity or impersonate FrameRate staff"
		};
	}

	return {
		status: 'success',
		message: 'Passed checks'
	};
}

function hasReservedWord(string: string) {
	return string.toLowerCase().includes('support') ? true : false;
}

function blacklistFilter(word: string) {
	const customDataSet = new DataSet<{ originalWord: string }>()
		.addAll(englishDataset)
		.addPhrase((phrase) =>
			phrase
				.setMetadata({ originalWord: 'admin' })
				.addPattern(pattern`admin`)
				.addPattern(pattern`admn`)
				.addPattern(pattern`ad min`)
				.addPattern(pattern`adm in`)
				.addPattern(pattern`a dmin`)
				.addPattern(pattern`admi n`)
		)
		.addPhrase((phrase) =>
			phrase
				.setMetadata({ originalWord: 'framerate' })
				.addPattern(pattern`framerate`)
				.addPattern(pattern`frame rate`)
		);

	const matcher = new RegExpMatcher({
		...customDataSet.build(),
		...englishRecommendedTransformers,
		blacklistMatcherTransformers: [
			collapseDuplicatesTransformer(),
			resolveConfusablesTransformer(),
			resolveLeetSpeakTransformer(),
			skipNonAlphabeticTransformer(),
			toAsciiLowerCaseTransformer()
		]
	});

	let passedFilters = false;

	if (matcher.hasMatch(word) || hasReservedWord(word)) {
		passedFilters = false;
	} else {
		passedFilters = true;
	}

	return passedFilters;
}
